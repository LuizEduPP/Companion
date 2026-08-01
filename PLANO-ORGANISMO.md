# Plano: Companion como organismo agentico

> Norte do projeto: [`AGENTS.md`](./AGENTS.md) — só host / porta / endpoint / model; turns event-driven; constitution = identidade + keys; `face` paramétrico (layout host, canais do modelo); sem caps de mente/mãos/tick.

Meta: presença desktop **autônoma** — loop contínuo sense → decide → act → remember → intend — com **zero política de comportamento no runtime**. Código = plumbing. Modelo + memória = agência. Sem thresholds de fala, sem árvores if/else de “quando comentar”, sem painéis de config.

Não-meta: mais knobs (`idle_ms`, noise scores, taxonomias de app, horários). Caps de buffer/I/O e adapters OS continuam (fio, não política).

---

## Princípios (travas de desenho)

1. **Runtime não decide.** Proibido: fingerprint skip, “se idle então…”, “se nudge então speak”, scores de relevância no código.
2. **Modelo filtra e age.** Ruído, silêncio, fala, tools e memória são decisão do organismo.
3. **Poucas tools genéricas** > milhares de flags.
4. **Intenção persiste** entre ticks (goals/commitments), não só biografia (`knows`).
5. **Constitution curta.** Preferências e estilo → memória aprendida, não regulamento eterno no prompt.
6. **Host ainda tem ifs de infra** (JSON parse, porta, kill process, adapters). Isso não conta como “política”.

---

## Estado atual (baseline)

| Existe | Falta |
|--------|--------|
| Sense multi-OS → POST activity | — |
| Turns event-driven + speak / face / learn / actions / intent | — |
| Store + recall tools (sem dump de episodes) | — |
| Tools + constitution curta | — |
| Orb: caption + nudge | — |

Fluxo: `sense ⇄ decide ⇄ act ⇄ tool_results ⇄ intend` (organismo)

---

## Fases

### Fase 0 — Congelar anti-padrões

**Objetivo:** alinhar o repo antes de crescer superfície.

- [x] Documentar neste plano a regra: política só no prompt/memória; novos PRs não adicionam thresholds de fala/idle/noise no `brain`/`sense`.
- [x] Inventário rápido do que é **fio** (OK) vs **política** (remover depois):
  - Fio: `IO.*` (buffers OS), bind, Electron hit-test, sense self-paced.
  - Política no prompt/tick/caps: **removida** no alinhamento AGENTS (constitution = identidade+keys; turns event-driven; face paramétrico).
- [x] Critério de aceite: qualquer feature nova de comportamento passa pelo modelo ou pela memória, não por `if` no runtime.

**Entrega:** consenso (aceite Luiz) + este arquivo como norte.

---

### Fase 1 — Loop vivo (tirar o gate)

**Objetivo:** o organismo **sempre** pode decidir; o runtime não pula turns.

1. [x] Remover o skip por `signalFingerprint` em `lib/brain.mjs` (`drainTurn`).
2. [x] Introduzir um **tick contínuo** no brain (heartbeat):
   - Sense continua postando activity (stream de sensores).
   - Brain mantém estado vivo e, a cada tick, monta payload e chama o modelo **ou** deixa o modelo escolher `wait` / `noop` via contrato (não via if no código).
3. [x] Unificar razões (`boot`, `nudge`, eventos sense) como **sinais no payload**, não como branches de política.
4. [x] Serialização: uma decisão por vez (`thinkBusy`); fila de ticks sem inventar silêncio fake.

**Contrato mínimo de saída (evolui na Fase 2):**

```json
{ "silence": true, "speak": null, "emotion": "idle", "learn": { "knows": [] }, "intent": null }
```

`intent` pode nascer já aqui (opcional) ou na Fase 3.

**Aceite:**

- Mudança de foco / clipboard / nudge / quiet desk → modelo vê o tick e decide speak ou silence.
- Zero `if (fp === last) return` (ou equivalente) no path de decisão.
- Orb e sense inalterados na UX básica.

**Riscos / mitigação:**

- Mais chamadas ao LLM → aceitar; se custo doer, o modelo aprende a pedir ticks mais raros via intent (Fase 3), **não** reintroduzir threshold no código.
- Modelo burro spamando fala → constitution + memória de preferência (Fase 5), não gate.

---

### Fase 2 — Mãos (tools)

**Objetivo:** decidir + **agir**, não só comentar.

1. [x] Estender o contrato de decisão para `actions[]`, além de speak/emotion/learn.
2. [x] Runtime: executor fino em `lib/tools.mjs` — valida schema, executa, devolve **observation** no próximo tick (`tool_results` + sinal `tool_result`).
3. [x] Set inicial:

| Tool | Efeito |
|------|--------|
| `speak` / emotion | Top-level (balão + avatar) |
| `memory_read` / `memory_write` | Recall e gravação sob pedido |
| `notify` | Aviso OS (`notify-send` / osascript / toast) |
| `open_or_focus` | `xdg-open` / `open` / `Start-Process` |
| `clipboard_write` | wl-copy/xclip/pbcopy/Set-Clipboard |

4. Shell / automação pesada: **só depois** do set mínimo estável.

**Aceite:** feito — actions no contrato; observations no tick seguinte.

---

### Fase 3 — Intenção persistente

**Objetivo:** continuidade entre ticks (vontade, não só biografia).

1. [x] Store: `intent: { goals, commitments, last_outcome }` em `memory.json`.
2. [x] Decisão pode atualizar `intent` (campo dedicado; `null` = leave unchanged).
3. [x] Todo tick inclui `intent` atual no payload.
4. [x] Após `actions[]`, gravar `last_outcome` cru via `setLastOutcome`.
5. [x] Nudge / tick / tool_result como **sinais**, não branches de fala.

**Aceite:** goals/commitments sobrevivem restart (persistidos no store).

---

### Fase 4 — Memória agentica (fim do dump cego)

**Objetivo:** contexto sob demanda; runtime não ranqueia relevância.

1. [x] Episodes fora do payload live; só `memory.{knows_count,episodes_count}`.
2. [x] Payload enxuto: sensores + `intent` + `user` slim + `knows` completos (sem dump de episodes).
3. [x] Tools: `memory_read`, `memory_search`, `episodes_since` (+ `memory_write`).
4. [x] Episodes append-only com higiene de dedup (inalterado).

**Aceite:** feito — recall via tools; turn sem novelão.

---

### Fase 5 — Constitution mínima + política aprendida

**Objetivo:** prompt curto; estilo e preferências na memória.

1. [x] `prompts/companion.md` reescrito como constitution (identidade, limites, voz, memória, mãos, output).
2. [x] Regulamento longo / exemplos extensos removidos; preferências → `knows` / `user.notes`.
3. [x] Sem branches de feedback no runtime (já era o caso).

**Aceite:** prompt ~½ do tamanho anterior; política de tom/frequência via memory + constitution curta.

---

### Fase 6 — Paridade de sense (só o que as mãos precisam)

**Objetivo:** tools e sensores úteis em Linux primeiro; Win/mac sem bloquear o desenho.

1. [x] Linux: a11y + focus + clipboard + KWin path já alimentam o tick.
2. [x] Tools atuais (`notify`, `open_or_focus`, `clipboard_write`) não dependem de `listWindows` no Win — buracos Win/mac ficam como degradação de sensor, não de arquitetura.
3. [x] Adapters = captura; zero classificador de kind/project.

**Aceite:** ciclo organismico no host principal (Linux/KDE); Win/mac degradam sensores.

---

## Ordem e dependências

```text
Fase 0 ──► Fase 1 (loop) ──► Fase 2 (tools)
                │                  │
                └──── Fase 3 (intent) ◄─┘
                           │
                      Fase 4 (recall)
                           │
                      Fase 5 (constitution)
                           │
                      Fase 6 (sense gaps, paralelo cedo se bloquear tools)
```

Sugestão prática: **1 → 3 (intent mínimo) → 2 (memory tools + notify) → 4 → 5**, com Fase 6 sob demanda.

---

## Contratos (alvo)

### Tick → modelo (entrada)

- `now`, `focus`, `activity` (sensores vivos)
- `intent` (goals, commitments, last_outcome)
- `user` / `knows` (slim)
- `situation.signals` (eventos crus + nudge flag como dado, não política)
- `tool_results[]` (do tick anterior)
- `emotions[]` (enum do build)

### Modelo → runtime (saída)

```json
{
  "emotion": "curious",
  "speak": "string|null",
  "silence": true,
  "learn": { "knows": [], "user": {} },
  "intent": { "goals": [], "commitments": [] },
  "actions": [
    { "tool": "memory_read", "args": { "query": "..." } }
  ]
}
```

Invalid JSON → manter estado anterior do orb (já é o comportamento atual). Sem “repair” criativo no runtime.

---

## Explicitamente fora de escopo

- Dashboard de configurações de personalidade / horários / apps favoritos
- Classificadores de noise ou idle→speak no `sense`/`brain`
- Chat Q&A com o orb
- Multi-agente / cloud sync
- “100% zero if” no host (infra continua com ifs)

---

## Checklist de progresso

| Fase | Nome | Status |
|------|------|--------|
| 0 | Congelar anti-padrões | feito |
| 1 | Loop vivo / sem fingerprint gate | feito |
| 2 | Tools (mãos) | feito |
| 3 | Intent persistente | feito |
| 4 | Memória agentica | feito |
| 5 | Constitution mínima | feito |
| 6 | Sense gaps para tools | feito |

---

## Definição de pronto (organismo)

O Companion é considerado organismo agentico neste repo quando:

1. [x] Não há gate mecânico que impeça o modelo de ver um tick.
2. [x] Pode agir no mundo via tools e observar o resultado no tick seguinte.
3. [x] Mantém goals/commitments across restarts.
4. [x] Puxa memória sob demanda em vez de dump cego.
5. [x] Prompt é constitution curta; preferências vivem na store.
6. [x] Nenhuma feature nova de comportamento entrou como threshold/config no runtime.

**Status: pronto segundo este plano** (2026-08-01). Evoluções seguintes = novas tools/adapters, não reintroduzir política no runtime.
