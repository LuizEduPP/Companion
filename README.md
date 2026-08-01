# Companion

**A luminous presence on your desktop — watches the PC, thinks with your model, speaks when it matters.**

Companion is a local-first desktop organism: sensors read what you are doing, an OpenAI-compatible model decides what to feel and say, and a small jelly orb lives in an always-on overlay. No chat box. No cloud backend. Your endpoint, your memory, your machine.

## Features

- **Desktop sense** — Focus, windows, a11y text, clipboard, selection, open files, idle (Linux / Windows / macOS)
- **Event-driven mind** — Thinks on boot, sensor changes, orb nudges, tool results, and parse errors — not on a product timer
- **Parametric face** — The model owns every channel (eyes, brows, mouth, color, energy…). The host only draws the jelly layout
- **Speech balloon** — Short lines on the orb when the model chooses to speak
- **Tools** — Memory read/search/write, episodes, notify, open/focus, clipboard write
- **Local memory** — `data/memory.json` for profile, knows, episodes, and intent
- **Your LLM** — LM Studio, Ollama, or any OpenAI-compatible `/v1` API

## Requirements

- Node.js 20+
- Yarn
- Linux, macOS, or Windows
- An OpenAI-compatible chat endpoint

## Install

```bash
git clone https://github.com/LuizEduPP/Companion.git
cd Companion
cp .env.example .env
yarn
yarn start
```

Edit `.env` with your endpoint and model before the first run.

## Configure

| Variable | Required | Role |
|----------|----------|------|
| `OPENAI_BASE_URL` | yes | Base URL ending in `/v1` |
| `OPENAI_CHAT_MODEL` | yes | Model id |
| `OPENAI_API_KEY` | no | Often empty for local servers |

Bind defaults: `127.0.0.1:8770` (local HTTP brain + static orb UI).

Optional: `yarn start -- --hot` for public/ hot reload while developing the orb.

## Use

1. Start Companion (`yarn start` runs brain + sense + Electron orb).
2. Drag the orb; click to nudge (signals the mind).
3. Work normally — activity posts to the brain; the model may speak, change face, learn, or call tools.
4. Inspect or reset memory in `data/memory.json` if you want a clean slate.

## Architecture

```
sense (OS adapters) ──► brain :8770 ──► Electron orb
                              │
                              └── your OpenAI-compatible /v1 API
```

| Path | Role |
|------|------|
| `run.mjs` | Supervisor: brain, sense, orb, Electron ensure |
| `server.mjs` | Local HTTP + static `public/` |
| `lib/brain.mjs` | Turns, decision apply, orb UI state |
| `lib/sense*.mjs` | OS capture (raw → activity POST) |
| `lib/store.mjs` | Persistent memory |
| `lib/tools.mjs` | Model-callable hands |
| `lib/avatar.mjs` | Face channel normalize |
| `public/` | Orb overlay (jelly layout + balloon) |
| `prompts/companion.md` | Constitution (identity + JSON keys) |

Code carries sensors and executes decisions. Agency lives in the model + memory — not in host thresholds for when to speak.

## Privacy

Runs on localhost. Sensors stay on your machine. Inference goes only to the endpoint you configure. No analytics ship with Companion.

## License

[MIT](LICENSE) © 2026 [Luiz Eduardo (LuizEduPP)](https://github.com/LuizEduPP)
