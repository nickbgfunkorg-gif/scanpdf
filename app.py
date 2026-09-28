"""Sign & Send — receive a document, print it, sign it, scan it, send it via Gmail."""
import base64
import io
import os
import re
import smtplib
import tempfile
import uuid
from datetime import datetime
from email.message import EmailMessage

from flask import Flask, jsonify, request, send_file, send_from_directory
from PIL import Image

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# ---------------------------------------------------------------
# Optional .env file (local dev only; on Render use env vars)
# ---------------------------------------------------------------
env_path = os.path.join(BASE_DIR, ".env")
if os.path.exists(env_path):
    with open(env_path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, val = line.split("=", 1)
            os.environ.setdefault(key.strip(), val.strip().strip('"').strip("'"))

SMTP_HOST = os.environ.get("SMTP_HOST", "smtp.gmail.com")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "465"))
SMTP_USER = os.environ.get("SMTP_USER", "")
SMTP_PASS = os.environ.get("SMTP_PASS", "")
SMTP_FROM = os.environ.get("SMTP_FROM", "") or SMTP_USER
APP_PIN = os.environ.get("APP_PIN", "")

DOCS_DIR = os.path.join(tempfile.gettempdir(), "sign_and_send_docs")
os.makedirs(DOCS_DIR, exist_ok=True)

ALLOWED_INCOMING = {".pdf", ".png", ".jpg", ".jpeg"}
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
MAX_PAGES = 30

app = Flask(__name__, static_folder="static", static_url_path="/static")
app.config["MAX_CONTENT_LENGTH"] = 80 * 1024 * 1024  # 80 MB


# ---------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------
def err(status, message):
    return jsonify({"error": message}), status


def pin_ok():
    """If APP_PIN is set, every POST must carry it in the X-App-Pin header."""
    return not APP_PIN or request.headers.get("X-App-Pin", "") == APP_PIN


def build_pdf(pages):
    """List of data-url images (data:image/jpeg;base64,...) -> PDF bytes."""
    if not pages:
        raise ValueError("No pages to build a PDF from.")
    images = []
    for page in pages[:MAX_PAGES]:
        if not isinstance(page, str):
            raise ValueError("Invalid page data.")
        _, _, b64 = page.partition(",")
        try:
            raw = base64.b64decode(b64)
            im = Image.open(io.BytesIO(raw))
            im = im.convert("RGB")
        except Exception:
            raise ValueError("Invalid image — please retake the photo.")
        images.append(im)
    buf = io.BytesIO()
    images[0].save(buf, format="PDF", save_all=True,
                   append_images=images[1:], resolution=150.0)
    return buf.getvalue()


def pdf_name():
    return f"signed-document-{datetime.now():%Y%m%d-%H%M}.pdf"


# ---------------------------------------------------------------
# Routes
# ---------------------------------------------------------------
# ---------------------------------------------------------------
# CORS — required so the app works inside sandboxed preview iframes
# (they run at origin "null", so every fetch needs explicit permission)
# ---------------------------------------------------------------
@app.after_request
def add_cors(resp):
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type, X-App-Pin"
    return resp


@app.get("/manifest.json")
def manifest_json():
    resp = send_from_directory(app.static_folder, "manifest.json",
                               mimetype="application/manifest+json")
    resp.headers["Cache-Control"] = "no-cache"
    return resp


@app.get("/sw.js")
def service_worker():
    resp = send_from_directory(app.static_folder, "sw.js", mimetype="text/javascript")
    resp.headers["Cache-Control"] = "no-cache"
    return resp


@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.get("/api/config")
def api_config():
    return jsonify({
        "pin_required": bool(APP_PIN),
        "has_smtp": bool(SMTP_USER and SMTP_PASS),
        "max_pages": MAX_PAGES,
    })


@app.get("/api/health")
def api_health():
    return jsonify({"ok": True})


@app.post("/api/incoming")
def api_incoming():
    if not pin_ok():
        return err(401, "Wrong PIN.")
    f = request.files.get("file")
    if f is None:
        return err(400, "No file received.")
    name = f.filename or "document"
    ext = os.path.splitext(name)[1].lower()
    if ext not in ALLOWED_INCOMING:
        return err(400, "Only PDF, PNG and JPG files are allowed.")
    blob = f.read()
    if len(blob) > 30 * 1024 * 1024:
        return err(413, "File is larger than 30 MB.")
    fid = uuid.uuid4().hex
    with open(os.path.join(DOCS_DIR, fid + ext), "wb") as out:
        out.write(blob)
    return jsonify({"id": fid, "url": f"/files/{fid}{ext}",
                    "name": name, "size": len(blob)})


@app.get("/files/<path:fn>")
def files(fn):
    if "/" in fn or ".." in fn or "\\" in fn:
        return err(404, "File not found.")
    return send_from_directory(DOCS_DIR, fn)


@app.post("/api/pdf")
def api_pdf():
    if not pin_ok():
        return err(401, "Wrong PIN.")
    data = request.get_json(silent=True) or {}
    try:
        pdf = build_pdf(data.get("pages") or [])
    except ValueError as exc:
        return err(400, str(exc))
    name = pdf_name()
    fid = uuid.uuid4().hex + ".pdf"
    with open(os.path.join(DOCS_DIR, fid), "wb") as out:
        out.write(pdf)
    # return a link (not raw bytes) so restricted preview iframes can still
    # fetch the file or open it via a normal navigation
    return jsonify({"url": f"/files/{fid}", "name": name, "size": len(pdf)})


@app.post("/api/send")
def api_send():
    if not pin_ok():
        return err(401, "Wrong PIN.")
    data = request.get_json(silent=True) or {}
    to = (data.get("to") or "").strip()
    subject = ((data.get("subject") or "").strip()) or "Signed document"
    body = (data.get("body") or "").strip()
    pages = data.get("pages") or []

    if not EMAIL_RE.match(to):
        return err(400, "Enter a valid recipient e-mail address.")
    if not SMTP_USER or not SMTP_PASS:
        return err(503, "Sending is not configured on the server — add the SMTP_USER "
                        "and SMTP_PASS environment variables (Gmail App Password).")
    try:
        pdf = build_pdf(pages)
    except ValueError as exc:
        return err(400, str(exc))

    msg = EmailMessage()
    msg["From"] = SMTP_FROM
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(body or "Please find the signed document attached.")
    msg.add_attachment(pdf, maintype="application", subtype="pdf",
                       filename=pdf_name())

    try:
        ctx = smtplib.ssl.create_default_context()
        with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, context=ctx, timeout=25) as smtp:
            smtp.login(SMTP_USER, SMTP_PASS)
            smtp.send_message(msg)
    except smtplib.SMTPAuthenticationError:
        return err(503, "Gmail rejected the login — check SMTP_USER and SMTP_PASS "
                        "(App Password, not your regular password).")
    except Exception as exc:  # noqa: BLE001
        return err(502, f"Sending failed: {exc}")

    return jsonify({"ok": True, "to": to, "pages": min(len(pages), MAX_PAGES)})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8000)), debug=False)
