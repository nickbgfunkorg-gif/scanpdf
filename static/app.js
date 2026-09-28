/* Sign & Send — frontend logic (v6: 6 image presets, no e-mail UI) */
"use strict";

/* ========================= state ========================= */

/* Storage that survives sandboxed preview iframes (sessionStorage throws there). */
const store = (() => {
  try {
    const s = window.sessionStorage;
    s.setItem("__probe", "1"); s.removeItem("__probe");
    return { get: (k) => s.getItem(k), set: (k, v) => s.setItem(k, v) };
  } catch {
    const m = new Map();
    return { get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, v) };
  }
})();

/* True when rendered inside the platform's restricted preview iframe. */
const FRAMED = (() => { try { return window.self !== window.top; } catch { return true; } })();

const state = {
  pages: [],            // dataURLs (jpeg) of final pages
  incoming: null,       // {url, name, size}
  pin: store.get("appPin") || "",
  pinRequired: false,
  stream: null,         // camera stream
  queue: [],            // files waiting for the editor
  work: null,           // working canvas in the editor
  cropMode: false,
  cropSel: null,        // {x,y,w,h} in screen px
};

const $ = (id) => document.getElementById(id);
const MAX_EXPORT_PX = 2000;
if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = "static/vendor/pdf.worker.min.js";
}
const PREVIEW_PX = 1100;

/* ========================= helpers ========================= */
function toast(msg, type = "", ms = 3200) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast " + type;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, ms);
}

function headers(json = true) {
  const h = {};
  if (json) h["Content-Type"] = "application/json";
  if (state.pinRequired && state.pin) h["X-App-Pin"] = state.pin;
  return h;
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  let data = {};
  try { data = await res.json(); } catch { /* not json */ }
  if (!res.ok) throw new Error(data.error || ("Error " + res.status));
  return data;
}

function fmtSize(bytes) {
  if (bytes > 1024 * 1024) return (bytes / 1048576).toFixed(1) + " MB";
  return Math.round(bytes / 1024) + " KB";
}

/* Banner shown inside the restricted preview iframe. */
function showFrameBanner() {
  if (document.getElementById("frameBanner")) return;
  const el = document.createElement("div");
  el.id = "frameBanner";
  el.className = "framebar";
  el.innerHTML =
    "<span>📱 You're in the <b>embedded preview</b> — its sandbox may block the camera, " +
    "file pickers, printing and downloads. Everything else works right here (try " +
    "<b>🧪 Try a sample page</b>). For the full experience open the app in a separate tab " +
    "with the <b>↗</b> button on the preview.</span>" +
    '<button class="icon-btn" id="frameBannerX" title="Dismiss">✕</button>';
  const main = document.querySelector("main");
  main.parentNode.insertBefore(el, main);
  document.getElementById("frameBannerX").addEventListener("click", () => el.remove());
}

/* ========================= boot ========================= */
async function boot() {
  try {
    const cfg = await api("/api/config");
    state.pinRequired = cfg.pin_required;
    $("pinRow").hidden = !cfg.pin_required;
    if (cfg.pin_required && state.pin) $("pin").value = state.pin;
  } catch {
    toast("Cannot reach the server — please reload the page.", "bad");
  }
  bindUI();
  updatePagesUI();
  if (FRAMED) showFrameBanner();
}

/* ========================= image processing ========================= */

/** Returns a processed canvas: preset (magic/enhanced/gray/whiteboard/bw/original) + brightness/contrast. */
function processImage(src, mode, brightness, contrast, maxSize) {
  let w = src.width, h = src.height;
  const scale = Math.min(1, maxSize / Math.max(w, h));
  w = Math.max(1, Math.round(w * scale));
  h = Math.max(1, Math.round(h * scale));

  const out = document.createElement("canvas");
  out.width = w; out.height = h;
  const ctx = out.getContext("2d");
  ctx.drawImage(src, 0, 0, w, h);

  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const cf = (contrast + 100) / 100; // -60..60 -> 0.4..1.6
  const n = w * h;

  if (mode === "bw") {
    // grayscale + Otsu threshold → hard black & white "scanner" look
    const gray = new Uint8ClampedArray(n);
    const hist = new Uint32Array(256);
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      const v = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 | 0;
      gray[p] = v; hist[v]++;
    }
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = -1, thr = 128;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (!wB) continue;
      const wF = n - wB;
      if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; thr = t; }
    }
    thr += brightness; // the slider shifts the threshold
    for (let p = 0, i = 0; p < n; p++, i += 4) {
      const v = gray[p] > thr ? 255 : 0;
      d[i] = d[i + 1] = d[i + 2] = v;
    }
  } else if (mode === "magic") {
    // color: per-channel auto-levels + saturation boost (white background, vivid ink)
    const mn = [255, 255, 255], mx = [0, 0, 0];
    for (let i = 0; i < d.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        if (d[i + c] < mn[c]) mn[c] = d[i + c];
        if (d[i + c] > mx[c]) mx[c] = d[i + c];
      }
    }
    const rng = [0, 1, 2].map((c) => Math.max(24, mx[c] - mn[c]));
    for (let i = 0; i < d.length; i += 4) {
      const lum = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
      for (let c = 0; c < 3; c++) {
        let v = (d[i + c] - mn[c]) * 255 / rng[c];
        v = lum + (v - lum) * 1.3; // saturate
        d[i + c] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
    }
  } else if (mode === "enhanced") {
    // grayscale + auto-levels (stretch the histogram)
    const gray = new Uint8ClampedArray(n);
    let mn = 255, mx = 0;
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      const v = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 | 0;
      gray[p] = v; if (v < mn) mn = v; if (v > mx) mx = v;
    }
    const range = Math.max(1, mx - mn);
    for (let p = 0, i = 0; p < n; p++, i += 4) {
      d[i] = d[i + 1] = d[i + 2] = (gray[p] - mn) * 255 / range;
    }
  } else if (mode === "gray") {
    // plain grayscale
    for (let i = 0; i < d.length; i += 4) {
      const v = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
      d[i] = d[i + 1] = d[i + 2] = v;
    }
  } else if (mode === "whiteboard") {
    // grayscale, paper pushed to pure white, text stays soft
    for (let i = 0; i < d.length; i += 4) {
      let v = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
      v = v * 1.15 + 42;
      d[i] = d[i + 1] = d[i + 2] = v > 255 ? 255 : v;
    }
  }
  // "original" → no preset processing

  if (mode !== "bw" && (brightness !== 0 || contrast !== 0)) {
    for (let i = 0; i < d.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        let v = (d[i + c] - 128) * cf + 128 + brightness;
        d[i + c] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

function rotateCanvas(src, deg) {
  const c = document.createElement("canvas");
  c.width = src.height; c.height = src.width;
  const x = c.getContext("2d");
  x.translate(c.width / 2, c.height / 2);
  x.rotate(deg * Math.PI / 180);
  x.drawImage(src, -src.width / 2, -src.height / 2);
  return c;
}


/* PDF file -> one canvas per page (rendered locally by PDF.js). */
async function pdfToCanvases(file) {
  if (!window.pdfjsLib) throw new Error("PDF support failed to load.");
  const buf = await file.arrayBuffer();
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
  const out = [];
  const n = Math.min(doc.numPages, 30);
  for (let i = 1; i <= n; i++) {
    const page = await doc.getPage(i);
    const vp1 = page.getViewport({ scale: 1 });
    const scale = Math.min(2.2, 2000 / Math.max(vp1.width, vp1.height));
    const vp = page.getViewport({ scale });
    const c = document.createElement("canvas");
    c.width = Math.floor(vp.width);
    c.height = Math.floor(vp.height);
    await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
    out.push(c);
  }
  const total = doc.numPages;
  doc.destroy();
  if (total > 30) toast("PDF has " + total + " pages — the first 30 were loaded.", "", 4500);
  return out;
}

/* Build editor queue entries from picked files (images AND PDFs). */
async function filesToQueueItems(files) {
  const items = [];
  for (const f of files) {
    const isPdf = f.type === "application/pdf" || /\.pdf$/i.test(f.name);
    if (isPdf) {
      try {
        const canvases = await pdfToCanvases(f);
        canvases.forEach((c) => items.push({ canvas: c }));
      } catch {
        toast("Could not open: " + f.name, "bad");
      }
    } else if (f.type.startsWith("image/")) {
      items.push({ file: f });
    }
  }
  return items;
}

/* ========================= editor ========================= */
const ed = {
  get overlay() { return $("editorOverlay"); },
};

function openEditor(canvas, queueLeft = 0, queueIdx = 0) {
  state.work = canvas;
  state.cropMode = false;
  state.cropSel = null;
  $("btnCropApply").hidden = true;
  $("cropRect").hidden = true;
  $("cropHint").hidden = true;
  $("edQueue").textContent = queueLeft > 1 ? `(${queueIdx + 1}/${queueLeft})` : "";
  $("brRange").value = 0; $("ctRange").value = 0;
  $("brVal").textContent = "0"; $("ctVal").textContent = "0";
  ed.overlay.hidden = false;
  renderPreview();
}

function closeEditor() {
  ed.overlay.hidden = true;
  state.work = null;
  nextFromQueue();
}

function nextFromQueue() {
  if (!state.queue.length) return;
  const item = state.queue.shift();
  if (item.canvas) { openEditor(item.canvas, state.queue.length + 1, item.idx); return; }
  loadFileToCanvas(item.file).then((c) => openEditor(c, item.total, item.idx))
    .catch(() => toast("Cannot open that image.", "bad"));
}

function renderPreview() {
  const mode = $("filterMode").value;
  const br = +$("brRange").value;
  const ct = +$("ctRange").value;
  const preview = processImage(state.work, mode, br, ct, PREVIEW_PX);
  const cv = $("edCanvas");
  cv.width = preview.width;
  cv.height = preview.height;
  cv.getContext("2d").drawImage(preview, 0, 0);
  $("cropRect").hidden = !state.cropMode || !state.cropSel;
}

function loadFileToCanvas(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext("2d").drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      resolve(c);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("bad image")); };
    img.src = url;
  });
}

/* ---------- crop: drag across the canvas ---------- */
function bindCrop() {
  const wrap = $("edWrap");
  let dragging = false, sx = 0, sy = 0;

  const pos = (e) => {
    const r = wrap.getBoundingClientRect();
    const p = e.touches ? e.touches[0] : e;
    return { x: p.clientX - r.left, y: p.clientY - r.top };
  };

  const start = (e) => {
    if (!state.cropMode || !state.work) return;
    e.preventDefault();
    dragging = true;
    const p = pos(e); sx = p.x; sy = p.y;
    state.cropSel = { x: p.x, y: p.y, w: 0, h: 0 };
    $("cropRect").hidden = false;
  };

  const move = (e) => {
    if (!dragging) return;
    e.preventDefault();
    const p = pos(e);
    const rect = {
      x: Math.min(sx, p.x), y: Math.min(sy, p.y),
      w: Math.abs(p.x - sx), h: Math.abs(p.y - sy),
    };
    state.cropSel = rect;
    const el = $("cropRect");
    el.style.left = rect.x + "px";
    el.style.top = rect.y + "px";
    el.style.width = rect.w + "px";
    el.style.height = rect.h + "px";
  };

  const end = () => {
    if (!dragging) return;
    dragging = false;
    const sel = state.cropSel;
    if (!sel || sel.w < 15 || sel.h < 15) {
      state.cropSel = null;
      $("cropRect").hidden = true;
      $("btnCropApply").hidden = true;
    } else {
      $("btnCropApply").hidden = false;
    }
  };

  wrap.addEventListener("mousedown", start);
  wrap.addEventListener("touchstart", start, { passive: false });
  window.addEventListener("mousemove", move);
  wrap.addEventListener("touchmove", move, { passive: false });
  window.addEventListener("mouseup", end);
  wrap.addEventListener("touchend", end);

  $("btnCropApply").addEventListener("click", () => {
    const sel = state.cropSel;
    if (!sel || !state.work) return;
    const cv = $("edCanvas");
    const scaleX = state.work.width / cv.clientWidth;
    const scaleY = state.work.height / cv.clientHeight;
    // the canvas is centered inside wrap — find its offset
    const wrapR = $("edWrap").getBoundingClientRect();
    const cvR = cv.getBoundingClientRect();
    const offX = cvR.left - wrapR.left, offY = cvR.top - wrapR.top;
    const x = (sel.x - offX) * scaleX;
    const y = (sel.y - offY) * scaleY;
    const w = sel.w * scaleX;
    const h = sel.h * scaleY;
    if (w < 10 || h < 10) { toast("The crop area is too small.", "bad"); return; }
    const c = document.createElement("canvas");
    c.width = Math.round(w); c.height = Math.round(h);
    c.getContext("2d").drawImage(state.work, x, y, w, h, 0, 0, c.width, c.height);
    state.work = c;
    state.cropMode = false;
    state.cropSel = null;
    $("cropRect").hidden = true;
    $("cropHint").hidden = true;
    $("btnCropApply").hidden = true;
    $("btnCropMode").classList.remove("primary");
    renderPreview();
  });
}

/* ========================= pages ========================= */
function updatePagesUI() {
  const grid = $("pagesGrid");
  grid.innerHTML = "";
  state.pages.forEach((dataURL, i) => {
    const div = document.createElement("div");
    div.className = "page";
    div.innerHTML =
      `<span class="pnum">${i + 1}</span>` +
      `<img src="${dataURL}" alt="page ${i + 1}">` +
      `<div class="pacts">` +
      `<button data-act="up" title="move up">⬆</button>` +
      `<button data-act="down" title="move down">⬇</button>` +
      `<button data-act="del" class="del" title="delete">🗑️</button>` +
      `</div>`;
    div.addEventListener("click", (e) => {
      const act = e.target.closest("button")?.dataset.act;
      if (!act) return;
      if (act === "del") state.pages.splice(i, 1);
      if (act === "up" && i > 0) [state.pages[i - 1], state.pages[i]] = [state.pages[i], state.pages[i - 1]];
      if (act === "down" && i < state.pages.length - 1)
        [state.pages[i + 1], state.pages[i]] = [state.pages[i], state.pages[i + 1]];
      updatePagesUI();
    });
    grid.appendChild(div);
  });
  $("pageCount").textContent = state.pages.length;
  $("pagesEmpty").hidden = state.pages.length > 0;
  $("btnDownload").disabled = state.pages.length === 0;
}

function addPage() {
  if (!state.work) return;
  const mode = $("filterMode").value;
  const br = +$("brRange").value;
  const ct = +$("ctRange").value;
  const final = processImage(state.work, mode, br, ct, MAX_EXPORT_PX);
  state.pages.push(final.toDataURL("image/jpeg", 0.87));
  updatePagesUI();
  toast(`Page ${state.pages.length} added ✅`, "ok", 1800);
  if (state.queue.length) closeEditor();
  else { ed.overlay.hidden = true; state.work = null; }
}

/* ========================= camera ========================= */
async function startCam() {
  if (!navigator.mediaDevices?.getUserMedia) {
    toast("Camera is not available in this view — open the app in a separate browser tab.", "bad", 5000);
    return;
  }
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 2560 }, height: { ideal: 1920 },
      },
      audio: false,
    });
    $("video").srcObject = state.stream;
    $("camWrap").hidden = false;
    $("btnStopCam").hidden = false;
    $("btnCam").hidden = true;
  } catch {
    toast("Camera unavailable here — use “Take photo / pick images”, or open the app in a separate tab.", "bad", 5000);
  }
}

function stopCam() {
  if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
  state.stream = null;
  $("camWrap").hidden = true;
  $("btnStopCam").hidden = true;
  $("btnCam").hidden = false;
}

function shoot() {
  const v = $("video");
  if (!v.videoWidth) { toast("The camera is still starting…", "bad"); return; }
  const c = document.createElement("canvas");
  c.width = v.videoWidth; c.height = v.videoHeight;
  c.getContext("2d").drawImage(v, 0, 0);
  openEditor(c);
}

/* Demo page so the whole flow can be tested even in the restricted preview. */
function samplePage() {
  const c = document.createElement("canvas");
  c.width = 1654; c.height = 2339; // A4 at 150 dpi
  const x = c.getContext("2d");
  x.fillStyle = "#f8f7f3"; x.fillRect(0, 0, c.width, c.height);
  x.fillStyle = "#1f2937"; x.font = "bold 62px Georgia, serif";
  x.fillText("SERVICE AGREEMENT", 130, 280);
  x.font = "36px Georgia, serif"; x.fillStyle = "#374151";
  [
    "This agreement is entered into by the undersigned parties,",
    "hereinafter referred to as the Provider and the Client.",
    "",
    "1. The Provider shall deliver the services as agreed.",
    "2. The Client shall settle payment within 14 days.",
    "3. This page must be signed by hand to be valid.",
  ].forEach((t, i) => x.fillText(t, 130, 430 + i * 64));
  x.fillStyle = "#6b7280"; x.font = "34px Georgia, serif";
  x.fillText("Date: 29 Aug 2026", 130, 2050);
  x.fillText("Place: St. Paul's Bay", 900, 2050);
  x.strokeStyle = "#1d4ed8"; x.lineWidth = 8; x.lineCap = "round";
  x.beginPath();
  x.moveTo(1120, 1980);
  x.bezierCurveTo(1200, 1850, 1330, 2020, 1430, 1900);
  x.bezierCurveTo(1480, 1840, 1520, 1930, 1560, 1905);
  x.stroke();
  x.strokeStyle = "#9ca3af"; x.lineWidth = 3;
  x.beginPath(); x.moveTo(1080, 2035); x.lineTo(1650, 2035); x.stroke();
  x.fillStyle = "#6b7280"; x.font = "italic 30px Georgia, serif";
  x.fillText("Signature", 1280, 2090);
  openEditor(c);
}

/* ========================= step 1: incoming document ========================= */
async function uploadIncoming(file) {
  const dz = $("dropzone");
  dz.classList.add("busy");
  try {
    const fd = new FormData();
    fd.append("file", file);
    const data = await api("/api/incoming", { method: "POST", headers: headers(false), body: fd });
    state.incoming = data;
    $("incName").textContent = data.name;
    $("incSize").textContent = fmtSize(data.size);
    $("btnOpenIncoming").href = data.url;
    $("incomingCard").hidden = false;
    $("printFrame").src = data.url;
    toast("Document uploaded — ready to print 🖨️", "ok");
  } catch (e) {
    toast(e.message, "bad", 4200);
  } finally {
    dz.classList.remove("busy");
  }
}

function printIncoming() {
  if (FRAMED) {
    toast("Printing is blocked in the embedded preview — open the app in a separate tab (↗) and press Ctrl/Cmd + P.", "", 6000);
  }
  const frame = $("printFrame");
  try {
    frame.contentWindow.focus();
    frame.contentWindow.print();
  } catch {
    toast("If the print dialog didn't open, click “Open” and press Ctrl/Cmd + P.", "", 5000);
    if (state.incoming?.url) window.open(state.incoming.url, "_blank");
  }
}

/* ========================= download ========================= */
async function downloadPdf() {
  if (state.pinRequired) {
    state.pin = $("pin").value;
    store.set("appPin", state.pin);
  }
  const btn = $("btnDownload");
  btn.disabled = true;
  btn.textContent = "⏳ Building PDF…";
  try {
    const data = await api("/api/pdf", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ pages: state.pages }),
    });
    // fetch the built file and trigger a download
    const res = await fetch(data.url);
    if (!res.ok) throw new Error("Could not fetch the PDF.");
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = data.name || "signed-document.pdf";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);

    const help = $("dlHelp");
    if (FRAMED) {
      help.innerHTML = `✅ PDF ready — ${state.pages.length} page(s), ${fmtSize(data.size)}. ` +
        `If the download didn't start (the preview blocks it), ` +
        `<a href="${data.url}" target="_blank" rel="noopener">open the PDF here</a>, ` +
        `or use the ↗ button on the preview.`;
      help.hidden = false;
    } else {
      help.hidden = true;
    }
  } catch (e) {
    toast(e.message, "bad", 4200);
  } finally {
    btn.textContent = "⬇️ Download PDF";
    btn.disabled = state.pages.length === 0;
  }
}

/* ========================= bind UI ========================= */
let clearArm = null;

function bindUI() {
  // step 1
  $("incomingFile").addEventListener("change", (e) => {
    if (e.target.files[0]) uploadIncoming(e.target.files[0]);
    e.target.value = "";
  });
  const dz = $("dropzone");
  ["dragenter", "dragover"].forEach((ev) =>
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((ev) =>
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("drag"); }));
  dz.addEventListener("drop", (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (f) uploadIncoming(f);
  });
  $("btnPrint").addEventListener("click", printIncoming);
  $("btnRemoveIncoming").addEventListener("click", () => {
    state.incoming = null;
    $("incomingCard").hidden = true;
    $("printFrame").src = "";
  });

  // step 2 — camera & sample
  $("btnCam").addEventListener("click", startCam);
  $("btnStopCam").addEventListener("click", stopCam);
  $("btnShoot").addEventListener("click", shoot);
  $("btnSample").addEventListener("click", samplePage);

  // step 2 — drag & drop images straight onto the card
  const s2 = $("step2");
  ["dragenter", "dragover"].forEach((ev) =>
    s2.addEventListener(ev, (e) => { e.preventDefault(); s2.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((ev) =>
    s2.addEventListener(ev, (e) => { e.preventDefault(); s2.classList.remove("drag"); }));
  s2.addEventListener("drop", async (e) => {
    const files = Array.from(e.dataTransfer?.files || [])
      .filter((f) => f.type.startsWith("image/") || f.type === "application/pdf" || /\.pdf$/i.test(f.name));
    if (!files.length) return;
    const items = await filesToQueueItems(files);
    if (!items.length) return;
    state.queue = items.map((it, i) => ({ ...it, idx: i, total: items.length }));
    nextFromQueue();
  });

  // step 2 — files
  $("pickImage").addEventListener("change", (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (!files.length) return;
    state.queue = files.map((file, i) => ({ file, idx: i, total: files.length }));
    nextFromQueue();
  });

  // PDF or image files picked from the computer -> same editor with scan filters
  $("pickFile").addEventListener("change", async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (!files.length) return;
    toast(files.some((f) => /\.pdf$/i.test(f.name) || f.type === "application/pdf")
      ? "⏳ Reading the PDF…" : "", "", 1200);
    const items = await filesToQueueItems(files);
    if (!items.length) return;
    state.queue = items.map((it, i) => ({ ...it, idx: i, total: items.length }));
    nextFromQueue();
  });

  // warn when the sandbox silently blocks a file picker
  function watchPicker(input, hint) {
    let t = null;
    input.addEventListener("click", () => {
      if (!FRAMED) return;
      clearTimeout(t);
      t = setTimeout(() => toast(hint, "bad", 6500), 3500);
    });
    input.addEventListener("change", () => clearTimeout(t));
  }
  watchPicker($("pickImage"),
    "If no file window opened, the preview blocks it — drag & drop images onto step 2, or open the app in a new tab (↗).");
  watchPicker($("incomingFile"),
    "If no file window opened, the preview blocks it — drag & drop the file onto the upload zone, or open the app in a new tab (↗).");
  watchPicker($("pickFile"),
    "If no file window opened, the preview blocks it — drag & drop the file onto step 2, or open the app in a new tab (↗).");

  // editor
  $("edClose").addEventListener("click", closeEditor);
  $("btnRotL").addEventListener("click", () => { if (state.work) { state.work = rotateCanvas(state.work, -90); renderPreview(); } });
  $("btnRotR").addEventListener("click", () => { if (state.work) { state.work = rotateCanvas(state.work, 90); renderPreview(); } });
  $("filterMode").addEventListener("change", renderPreview);
  $("brRange").addEventListener("input", (e) => { $("brVal").textContent = e.target.value; renderPreview(); });
  $("ctRange").addEventListener("input", (e) => { $("ctVal").textContent = e.target.value; renderPreview(); });
  $("btnCropMode").addEventListener("click", () => {
    state.cropMode = !state.cropMode;
    state.cropSel = null;
    $("cropRect").hidden = true;
    $("cropHint").hidden = !state.cropMode;
    $("btnCropApply").hidden = true;
    $("btnCropMode").classList.toggle("primary", state.cropMode);
  });
  $("btnAddPage").addEventListener("click", addPage);
  bindCrop();

  // pages — two-step confirm (confirm() dialogs are blocked in sandboxed previews)
  $("btnClearPages").addEventListener("click", () => {
    if (!state.pages.length) return;
    const b = $("btnClearPages");
    if (b.dataset.armed) {
      clearTimeout(clearArm);
      delete b.dataset.armed;
      b.textContent = "Clear all";
      b.classList.remove("danger");
      state.pages = [];
      updatePagesUI();
      return;
    }
    b.dataset.armed = "1";
    b.textContent = "Really clear?";
    b.classList.add("danger");
    clearArm = setTimeout(() => {
      delete b.dataset.armed;
      b.textContent = "Clear all";
      b.classList.remove("danger");
    }, 3000);
  });

  // download
  $("btnDownload").addEventListener("click", downloadPdf);

  // protect against accidentally leaving the page
  window.addEventListener("beforeunload", (e) => {
    if (state.pages.length) { e.preventDefault(); e.returnValue = ""; }
  });
}

boot();

/* PWA — register the service worker so the app can be installed on phones */
if ("serviceWorker" in navigator &&
    (location.protocol === "https:" || ["localhost", "127.0.0.1"].includes(location.hostname))) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
