# Companion — orb no desktop

Projeto standalone em `projects/032-companion` (git próprio).

Presence luminosa no PC: captura atividade do desktop (foco, páginas, arquivos, digitação após idle, clipboard, a11y), lembra em `memory.json`, pergunta no balão. Sem tipado no orb. Sem screenshot.

Alvo: **Linux, Windows e macOS** (Node ≥20 + Electron).

```
sense (adapters) ──► companion :8770 ──► orb overlay
        │
        └── LM Studio / OpenAI-compatible
```

## Setup

```bash
cd companion
cp .env.example .env
yarn install
yarn start               # = node run.mjs  (brain + sense + orb)
```

Entrada: `run.mjs` (`all` | `brain` | `sense` | `orb` | `electron-ensure`).

## O que captura (activity stream)

| Canal | Linux | Windows | macOS |
|-------|--------|---------|-------|
| Focus | KWin script + `/proc` + AT-SPI | GetForegroundWindow | System Events |
| Pages | URL no título | URL no título | URL no título |
| Files | título + `/proc/<pid>/fd` + watch dirs | título + watch | título + watch |
| Windows | KWin window list | — | System Events |
| Typed | valor a11y do foco → flush após idle | UI Automation Value → idle | AX value → idle |
| Selection | AT-SPI selection + primary (`wl-paste --primary`) | TextPattern selection | — |
| Idle | loginctl IdleHint + quiet tracker | GetLastInputInfo | HIDIdleTime |
| Clipboard | wl-paste / xclip | Clipboard.GetText | pbpaste |
| A11y | AT-SPI (python3+gi) | UI Automation | System Events |

**Nunca:** `org.kde.KWin.queryWindowInfo` (rouba mouse), screenshot region.

Digitação: buffer local; envia o texto **integral** após `COMPANION_TYPE_IDLE_MS` (default 2.5s). Campos password (quando detectáveis) são ignorados. Tokens óbvios são redacted.

## APIs

| Método | Path | Uso |
|--------|------|-----|
| GET | `/api/pc/ui` | orb + balão |
| GET | `/api/health` | health + brain status |
| POST | `/api/pc/activity` | stream completo (focus/page/file/typed/…) |
| POST | `/api/pc/nudge` | toque no orb |

## Data

`data/memory.json` — `user`, `knows`, `episodes`.

## Envs de captura

```bash
COMPANION_CAPTURE_ALL=1          # master (default on)
COMPANION_CAPTURE_TYPED=1
COMPANION_CAPTURE_CLIPBOARD=1
COMPANION_CAPTURE_A11Y=1
COMPANION_CAPTURE_FILES=1
COMPANION_CAPTURE_BROWSER=1
COMPANION_TYPE_IDLE_MS=2500
COMPANION_TYPE_MAX_CHARS=16000
COMPANION_WATCH_DIRS=            # dirs extras separados por ,:; 
```

## Código

- `lib/sense.mjs` — orquestra
- `lib/sense/{linux,win32,darwin}.mjs` — adapters
- `lib/sense/infer.mjs` — URL/arquivo/kind estrutural
- `lib/brain.mjs` / `lib/store.mjs` — activity → memória + turns
