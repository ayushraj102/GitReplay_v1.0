# One-Click Full-Stack Deployment (Frontend + `/api/ai/*` Backend)

Unlike static-only GitHub Pages, these platforms run the full Node.js + Express server (`server.ts`) together with the compiled React frontend (`dist/`) in one deployment, so AI Commit Analysis, AI Chat, GitHub Imports, and Exports all work from a single URL.

> **Required Environment Variable on All Platforms:**  
> Set `GEMINI_API_KEY` to your Google Gemini API key in the platform's environment variables UI.
>
> **Firebase Google Sign-In:**  
> After deploying, add your new app hostname (for example `your-app.koyeb.app` or `your-app.onrender.com`) in **Firebase Console → Authentication → Settings → Authorized domains**.

---

## 1. Deploy to Koyeb

[![Deploy to Koyeb](https://www.koyeb.com/static/images/deploy/button.svg)](https://app.koyeb.com/deploy?type=git&repository=github.com/ayushraj102/GitReplay&branch=main&name=gitreplay&builder=buildpack&build_command=npm%20install%20--include%3Ddev%20--legacy-peer-deps%20%26%26%20npm%20run%20build&run_command=npm%20start&env=NODE_ENV=production&env=PORT=3000&env=VITE_BASE_PATH=/&env=GEMINI_API_KEY=)

- **Builder:** Buildpack (or select **Dockerfile** — a production `Dockerfile` is included).
- **Port:** `3000`
- **Health check path:** `/api/health`
- **Note:** Koyeb's free web service includes 512 MB RAM and sleeps after 1 hour of inactivity, and Koyeb asks for a card verification ($29 temporary hold) when creating an account.

---

## 2. Deploy to Render (Free Web Service — No Card Required)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/ayushraj102/GitReplay)

Uses the included `render.yaml` Blueprint automatically:
- **Build Command:** `npm install --include=dev --legacy-peer-deps && npm run build`
- **Start Command:** `NODE_ENV=production npm start`
- **Health Check Path:** `/api/health`
- **Prompted Env Var:** `GEMINI_API_KEY`

---

## 3. Deploy on Railway

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new)

Uses the included `railway.toml`:
- Connect `ayushraj102/GitReplay`
- Add `GEMINI_API_KEY` in **Variables**
- Railway builds and starts `NODE_ENV=production npm start` with health check `/api/health`

---

## 4. Docker / Any Container Host (Fly.io, Cloud Run, Coolify, Dokploy)

```bash
docker build -t gitreplay .
docker run -p 3000:3000 -e GEMINI_API_KEY=your_key_here gitreplay
```
