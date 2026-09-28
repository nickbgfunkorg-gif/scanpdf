# ✍️ Sign & Send

A web app for signing documents the old-fashioned, legally safest way:

**receive a document → print it → sign it by hand → scan it with your phone → download a clean PDF**

Everything runs in the browser (phone or desktop), no login needed.

## How to use

1. **Receive the document** — drag in the PDF/image someone sent you → click **Print**.
2. **Sign & scan** — sign the printed page, start the camera and photograph it (or pick images from your gallery). One photo per page.
   You can also click **📁 Add file from computer** and pick a PDF or image directly — each PDF page opens in the same editor with the scan filters.
3. **Edit the page** — crop edges (✂️), rotate (↺ ↻), and choose one of six looks:
   - *Enhanced* — auto-levelled grayscale (recommended)
   - *Color — magic* — white background, vivid colors
   - *Grayscale* — plain gray
   - *Whiteboard* — paper pushed to pure white, soft text
   - *Black & white — scan* — true scanner look (Otsu binarization)
   - *Original* — the photo as-is
   - plus brightness and contrast sliders
4. **Save** — **Download PDF**: all pages are merged into one PDF, in order.

## Project structure

```
sign-and-send/
├── app.py              # Flask backend (upload, PDF building)
├── static/
│   ├── index.html      # UI
│   ├── styles.css
│   └── app.js          # camera, image editor, 6 filter presets, cropping
├── requirements.txt    # flask, gunicorn, pillow
├── render.yaml         # Render blueprint
└── README.md
```

## Running locally

```bash
cd sign-and-send
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python app.py
# open http://localhost:8000
```

Optional: create a `.env` file with `APP_PIN=1234` to protect the app with a PIN.

## 📱 Install as an app on your phone (PWA)

No APK needed — the site is a full **installable web app**:

1. Open your Render URL in **Chrome on Android** (or Safari on iPhone).
2. Tap the menu (⋮) → **Add to Home screen** / **Install app** (iPhone: Share → Add to Home Screen).
3. An app icon appears — it opens fullscreen, with camera access, like a native app.
4. It always runs the latest deployed version; the shell even opens offline (scanning needs internet).

## 🚀 Deploying to Render

### 1) Push to GitHub

Upload the **contents** of this folder to a new GitHub repo (github.com/new), or:

```bash
cd sign-and-send
git init
git add .
git commit -m "Sign & Send - print, sign, scan, save"
git branch -M main
git remote add origin https://github.com/YOUR-USER/sign-and-send.git
git push -u origin main
```

### 2) Render

**Easiest — Blueprint (the repo already contains `render.yaml`):**

1. If an old `sign-and-send` service exists in your dashboard, delete it first (Settings → Delete Service).
2. Open https://dashboard.render.com → **New → Blueprint**
3. Select your GitHub repo — Render reads `render.yaml` automatically. No setup questions — just click **Apply**.
4. In a few minutes you get `https://sign-and-send-app-xxxx.onrender.com`
5. Open the site and check the footer says **v7** — that's how you know the new version is live.

You can add an `APP_PIN` later (Environment → Add Environment Variable) if you want PIN protection.

**Classic way:**

- **New → Web Service** → connect the repo
- Runtime: **Python 3** · Build: `pip install -r requirements.txt` · Start: `gunicorn app:app`
- Health check path: `/api/health` · Free plan

### Notes

- The free plan sleeps the app after 15 minutes of inactivity — the first request after that takes ~30–60 s while it wakes up.
- The browser camera requires **HTTPS** — Render gives you that automatically; locally it works on `localhost`.
- Max 30 pages per document, uploads up to 30 MB.
