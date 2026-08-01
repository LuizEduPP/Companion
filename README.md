# Companion — orb no desktop

Projeto standalone em `projects/032-companion` (git próprio).

Presence luminosa no PC: captura atividade do desktop (foco, páginas, arquivos, digitação via a11y, clipboard), lembra em `memory.json`, fala no balão. Sistema **agentico** — o modelo decide `silence` / `speak` / `face` / `learn` / `intent` / `actions`; o JS só orquestra I/O e aplica a decisão. Turns event-driven (boot, mudança de sensor, nudge, tool_result, parse_error) — sem fingerprint gate nem timer de produto.

Norte: [`AGENTS.md`](./AGENTS.md). Infra configurável: host, porta, endpoint, model.

Alvo: **Linux, Windows e macOS** (Node ≥20 + Electron).

```
sense (adapters) ──► companion :8770 ──► orb overlay
        │
        └── LM Studio / OpenAI-compatible
```

## Setup

```bash
cd companion
cp .env.example .env   # só OPENAI_*
yarn install
yarn start             # = node run.mjs  (brain + sense + orb)
node run.mjs --hot     # hot reload (opcional)
```

Entrada: `run.mjs` (`all` | `brain` | `sense` | `orb` | `electron-ensure`).

## Env (só wiring LLM)

```bash
OPENAI_BASE_URL=http://127.0.0.1:1234/v1
OPENAI_API_KEY=
OPENAI_CHAT_MODEL=…
```

Sem knobs de comportamento, thresholds ou regex de política no `.env`.

## O que captura (activity stream)

| Canal | Linux | Windows | macOS |
|--------|--------|---------|-------|
| Focus | KWin script + `/proc` + AT-SPI | GetForegroundWindow | System Events |
| Pages / files | URL/path no título | idem | idem |
| Typed | valor a11y do foco | UI Automation | AX value |
| Selection / clipboard | AT-SPI + primary / wl-paste | TextPattern / Clipboard | pbpaste |
| Idle | loginctl + quiet tracker | GetLastInputInfo | HIDIdleTime |

**Nunca:** `org.kde.KWin.queryWindowInfo` (rouba mouse), screenshot region.

## APIs

| Método | Path | Uso |
|--------|------|-----|
| GET | `/api/pc/ui` | orb + balão |
| GET | `/api/health` | health + brain status |
| POST | `/api/pc/activity` | stream completo |
| POST | `/api/pc/nudge` | toque no orb |

## Data

`data/memory.json` — `user`, `knows`, `episodes`, `intent`.

## Código

- `lib/sense.mjs` — orquestra sensores (raw)
- `lib/sense/{linux,win32,darwin}.mjs` — adapters
- `lib/brain.mjs` / `lib/store.mjs` — activity → memória + turns
- `lib/avatar.mjs` / `public/avatar-engine.js` — layout orb + `face` paramétrica (canais do modelo)
- `prompts/companion.md` — identidade + keys do JSON
