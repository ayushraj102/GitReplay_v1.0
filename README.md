# GitReplay

**Replay how a codebase was built, and why.**

GitReplay turns a repository's commit history into a guided, replayable story: the base design, every change after it, the reasoning behind each decision, and how the architecture evolved. It is built to help new team members understand a module of a large codebase in minutes instead of days.

---

## Table of Contents

- [The Problem](#the-problem)
- [The Solution](#the-solution)
- [What Makes It Different](#what-makes-it-different)
- [Features](#features)
- [Screens](#screens)
- [How It Works](#how-it-works)
- [Getting Started](#getting-started)
- [Deployment](#deployment)
- [Usage](#usage)
- [Try It With These Repos](#try-it-with-these-repos)
- [Tech Stack](#tech-stack)
- [Limitations](#limitations)
- [Roadmap](#roadmap)
- [Developer](#developer)

---

## The Problem

When someone joins a company, they usually get one module of a very large codebase. To work on it they need to know:

1. What the module does
2. How its base was designed
3. What changed afterwards, and why

Today they learn this by reading the final code, scrolling a flat `git log`, or asking seniors. The final code shows *what* exists, not *how* or *why* it got there. Diffs show line changes, not intent, trade-offs, or architectural impact.

## The Solution

GitReplay imports a repository (public or token-authenticated GitHub link, or pasted `git log -p`) and presents its history as a three-step learning path:

| Step | Screen | Question it answers |
|------|--------|---------------------|
| 1 | **Overview** | What is this module, and where do I start? |
| 2 | **Timeline** | What changed, and why? |
| 3 | **Architecture** | How did the structure change? |

## What Makes It Different

| Existing approach | What it gives | Gap GitReplay fills |
|-------------------|---------------|---------------------|
| `git log` / GitHub commit list | Linear messages and diffs | No reasoning, no structure view, no guided order |
| File history / blame | Who changed a line and when | Per-file only, hard to follow a cross-file story |
| History visualisers | Animation of activity over time | No code and no explanation of decisions |
| Design docs / ADRs | Written rationale | Separate from the code, not tied to the exact commit |
| Hand-written code tours | Walkthrough of current code | Manual effort, shows today's code not its evolution |

**Key ideas**

- Code, reasoning, and architecture in **one synchronized view** per commit
- **ADR-style rationale** (Problem, Decision, Trade-offs) next to the diff
- **Onboarding-first design:** guided tour, version milestones, and warm light/dark themes
- **Architecture diff:** layered topology with modules marked added, modified, or unchanged
- Works on **GitHub repo links** (up to 200 commits per fetch + pagination) and exports to **PDF and Markdown**

## Features

- **Guided tour** that replays a module chronologically from commit #1
- **Timeline playback** with play/pause, previous/next, speed control, loop toggle, and keyboard shortcuts (`←` / `→` / `Space`), plus a **Commit Matrix** view toggle
- **Unified and Split diff** views, collapsed unchanged regions, file-level summaries, line blame, and copy controls
- **"Why this change" panel:** summary, collapsible Problem, Decision, Trade-offs, and personal developer notes per commit
- **Category & release filters:** Architecture, Performance, Feature, Refactor, Bugfix, plus folder path, date range, tag/release range, and milestones-only import filters
- **Architecture view:** horizontal layered module topology, data flow connections, and a commit slider with before/after comparison
- **AI assistant (Gemini):** deep commit analysis, single-turn diff Q&A, and multi-turn persona chat rendered with sanitized Markdown and syntax highlighting
- **Smart caching & cloud sync:** IndexedDB caching for commit diffs, AI analyses, and chat threads (`Saved answer` + `Regenerate`), with optional Firebase Google Sign-In to sync across devices
- **Import & Export:** GitHub API (with optional local GitHub token for higher rate limits / private repos), raw `git log -p`, and summarized onboarding reports in **PDF and Markdown**

## Screens

### Overview
Module name and description, inline stats (commits, contributors, date range, current version), a **Start guided tour** button, simplified current architecture diagram, and a vertical mini-timeline of key milestones.

### Timeline
Horizontal milestone track with step counter, code diff viewer on the left/center (plus Commit Matrix toggle), and the **Why this change** panel on the right with collapsible Problem, Decision, Trade-offs, personal notes, and AI Assistant drawer triggers.

### Architecture
Layered architecture diagram comparing each commit before and after. Changed modules are highlighted with status badges (`added` / `modified`) and unchanged ones are muted, paired with wrapped data-flow connection details and a commit slider.

## How It Works

1. **Input:** a GitHub repository URL (optionally scoped by folder, date range, tag range, or milestones) or a pasted `git log -p`
2. **Fetch:** fetches commit metadata first (paginated up to 200 commits + Load More), then fetches each commit's diff lazily on demand and caches it in IndexedDB
3. **Classify:** tags each commit with a category, milestone status, and architecture layer
4. **Explain:** builds Problem / Decision / Trade-offs rationale from commit context plus cached/streamed Gemini AI analysis
5. **Model:** derives modules and data-flow links across layers, comparing each commit before and after
6. **Render and export:** presents the replay across Overview, Timeline, and Architecture, and exports reports to PDF or Markdown

## Getting Started

### Prerequisites

- Node.js 20+ (Node 22 recommended)
- A Google Gemini API key from [Google Gemini API Console](https://aistudio.google.com/apikey) *(required only for AI Commit Analysis & Ask Assistant)*

### Installation

```bash
git clone https://github.com/ayushraj102/GitReplay.git
cd GitReplay
npm install --legacy-peer-deps
```

### Environment variables

Copy `.env.example` to `.env` in the project root (never commit `.env`):

```bash
GEMINI_API_KEY=your_api_key_here
```

### Run locally

```bash
npm run dev
```

Then open `http://localhost:3000` in your browser.

## Deployment

### One-Click Full-Stack Deployment (Frontend + `/api/ai/*` Backend)

Unlike static-only GitHub Pages, these platforms run the Node.js + Express server (`server.ts`) together with the compiled frontend (`dist/`) from one URL so AI Commit Analysis, AI Chat, GitHub Imports, and Exports all work out of the box.

> **Required Environment Variable:** Set `GEMINI_API_KEY` from [Google Gemini API Console](https://aistudio.google.com/apikey) in your host's environment settings.  
> **Firebase Google Sign-In:** Add your deployed hostname (for example `your-app.koyeb.app` or `your-app.onrender.com`) under **Firebase Console → Authentication → Settings → Authorized domains**.

#### Deploy to Koyeb

[![Deploy to Koyeb](https://www.koyeb.com/static/images/deploy/button.svg)](https://app.koyeb.com/deploy?type=git&repository=github.com/ayushraj102/GitReplay&branch=main&name=gitreplay&builder=buildpack&build_command=npm%20install%20--include%3Ddev%20--legacy-peer-deps%20%26%26%20npm%20run%20build&run_command=npm%20start&env=NODE_ENV=production&env=PORT=3000&env=VITE_BASE_PATH=/&env=GEMINI_API_KEY=)

- **Builder:** Buildpack (or select **Dockerfile** — a production `Dockerfile` is included)
- **Port / Health Check:** `3000` / `/api/health`
- **Note:** Koyeb's free web service includes 512 MB RAM, sleeps after 1 hour of inactivity, and requires card verification (temporary hold) during account signup.

#### Deploy to Render (Free Web Service — No Card Required)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/ayushraj102/GitReplay)

Uses `render.yaml` automatically (`npm install --include=dev --legacy-peer-deps && npm run build`, `NODE_ENV=production npm start`, health check `/api/health`, prompts for `GEMINI_API_KEY`).

#### Deploy on Railway

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new)

Uses `railway.toml` — connect `ayushraj102/GitReplay`, add `GEMINI_API_KEY` in **Variables**, and Railway deploys automatically with health check `/api/health`.

#### Docker (Fly.io, Cloud Run, Coolify, Dokploy)

```bash
docker build -t gitreplay .
docker run -p 3000:3000 -e GEMINI_API_KEY=your_key_here gitreplay
```

### Static Hosting on GitHub Pages

1. In your GitHub repo, open **Settings → Pages → Build and deployment → Source** and select **GitHub Actions** (one-time setup).
2. Run **Actions → Deploy to GitHub Pages → Run workflow** (or push to `main`/`master`).
3. *(Optional for AI on GitHub Pages)* Deploy the backend using one of the options above and set repository variable `VITE_API_BASE_URL` in **Settings → Secrets and variables → Actions → Variables** to that backend URL before re-running the workflow.

## Usage

1. Open the repository dropdown in the top bar and click **Load public GitHub link** or **Import git log**.
2. Paste a repo URL (for example `https://github.com/koajs/koa`), optionally set commit limit, folder path, date/tag range, or a local GitHub token, and click **Build Playable Timeline**.
3. Start from **Overview**, click **Start guided tour**, and step through commits on **Timeline** and **Architecture**.
4. Use **Analyze with AI** or **Ask question** on any commit (answers are cached locally in IndexedDB and synced when signed in with Google).
5. Click **Export** in the top bar to save the onboarding report as **PDF** or **Markdown**.

## Try It With These Repos

| Repository | Why it works well |
|------------|-------------------|
| `koajs/koa` | Small, readable framework with a clear architecture story |
| `pmndrs/zustand` | Tiny state library, quick to replay end to end |
| `vitejs/vite` | Active project with plenty of meaningful changes |
| `jashkenas/underscore` | Small library with simple history |
| `yjs/yjs` | Real-time sync and CRDT concepts |

For large repositories, scope to a single folder path or a range between two release tags.

## Tech Stack

- **Frontend:** React 19, TypeScript, Vite, Tailwind CSS
- **Backend & AI Proxy:** Node.js, Express (`server.ts`), `@google/genai` (Gemini API with automatic model fallback)
- **Markdown & Diff Rendering:** `react-markdown`, `remark-gfm`, `rehype-sanitize`, `highlight.js`
- **Data & Storage:** GitHub REST API, IndexedDB (offline commit/AI caching), Firebase Auth & Firestore (optional cloud sync)
- **Export:** `jsPDF` (PDF onboarding summary) & Markdown report generator

## Limitations

- Rationale quality depends on commit message quality and AI accuracy; AI output should be verified against the diff
- Very large histories are subject to GitHub REST API rate limits (add an optional personal GitHub token in the import dialog to increase limits) and Gemini API quota
- Layer and dependency inference for arbitrary external repositories is heuristic-based
- Static-only hosts like GitHub Pages require `VITE_API_BASE_URL` pointing to a running backend (`server.ts`) for `/api/ai/*` endpoints

## Roadmap

- [x] Render AI answers as full Markdown with syntax highlighting
- [x] Higher commit limits with pagination, folder, date, and tag-range filters
- [x] Cache AI responses per commit in IndexedDB & cloud sync to save quota
- [x] Private repository support with a local GitHub token
- [ ] Pull request discussions and issue links
- [ ] Branch and merge visualisation
- [ ] Onboarding quizzes and team-shared notes

## Developer

**Ayush Raj**

- GitHub: [@ayushraj102](https://github.com/ayushraj102)
- Email: ayushraj1500@gmail.com

---
If you find this project useful, consider giving it a star.
