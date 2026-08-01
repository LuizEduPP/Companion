# Companion — conceito

Este arquivo explica **como o Companion deve ser entendido e construído**.  
Não é um painel de regras de comportamento. Comportamento emerge do modelo + memória.  
O único “produto configurável” é ligação de infra: host, porta, endpoint, model.

Identidade falada ao modelo: [`prompts/companion.md`](./prompts/companion.md) (identidade + keys do JSON — sem tabela de ranges, sem checklist de quando falar).

---

## 1. O que é

Companion é uma **presença** no desktop — um orb luminoso que vive ao lado do humano.

Não é chatbot. Não há caixa de texto nem Q&A.  
O humano não “conversa com o bot”; o organismo **observa o PC**, pensa, às vezes fala no balão, às vezes age (abrir algo, lembrar, notificar), e segue vivo.

Pensa nele como um bicho pequeno no canto da tela: vê o que acontece, forma opinião, lembra, tem vontade — e o código só é o corpo (olhos, boca, mãos), não o juiz.

---

## 2. Ideia central (uma linha)

```text
código = plumbing (transporta sensores e executa decisões)
modelo + memória = agência (decide o que fazer com isso)
```

Se uma mudança no JS responde “quando falar / quando calar / quando pensar”, está no lugar errado.  
Isso pertence ao organismo (modelo + `data/memory.json` + constitution).

---

## 3. As três peças que correm juntas

`node run.mjs` sobe três processos:

| Peça | Nome | Função |
|------|------|--------|
| **Brain** | `server.mjs` + `lib/brain.mjs` | HTTP local, estado, turns no modelo, aplica decisão |
| **Sense** | `run.mjs sense` + `lib/sense*.mjs` | Lê o SO e posta activity (ritmo = duração da captura) |
| **Orb** | Electron + `public/` | layout jelly + `face` paramétrico (só números do modelo), balão, nudge |

O sense alimenta o brain. O orb mostra o que o brain decidiu. O brain é o coração do loop.

---

## 4. O ciclo de vida (passo a passo)

### Passo A — Observar (sense)

1. Snapshot do desktop (foco, a11y, clipboard, etc.).
2. `POST /api/pc/activity` com dados crus.
3. **Não classifica** “é código / é barulho / vale a pena”.

### Passo B — Viver (sinais → turn)

1. Sense atualiza estado sempre; **turn no modelo** só quando há sinal (boot, mudança de sensor, nudge, tool_result, parse_error).
2. Não há timer de parede (“pensar a cada N ms”). Presença ≠ martelar o LLM.
3. Sinais são **dados no payload**, não branches de política no JS.
4. Uma decisão por vez (`thinkBusy`); o resto espera na fila.

### Passo C — Situar (payload)

1. Um JSON: agora, sensores, user, knows (lista completa), intent, tools, tool_results, last_parse_error.
2. Episodes **não** vão no prompt; só contagem. Histórico via tools de memória.
3. Constitution = system; JSON = user.

### Passo D — Decidir (modelo)

1. Um objeto JSON: `silence`, `speak`, `face`, `learn`, `intent`, `actions`.
2. **`face`**: números por canal (olho L/R, brow L/R, boca, cor, acentos…). Layout/desenho é do host; o modelo controla todos os detalhes. Sem emoções nomeadas nem SVG livre. `null` mantém.
3. JSON inválido/cortado: runtime **não conserta** e **não inventa** fala. Observação `last_parse_error` + sinal `parse_error`.

### Passo E — Expressar (orb)

1. Fala → balão. Face/boca/cor/vida = só canais do modelo; host só desenha.
2. Clique = nudge (sinal), não chat.

### Passo F — Agir (mãos)

1. `actions[]` → `lib/tools.mjs` (sem teto de N actions no host).
2. Speak / face são campos top-level, não tools.
3. Resultados no próximo turn (`tool_results`).

### Passo G — Lembrar e querer (store)

1. `learn` → knows / perfil. `intent` → goals/commitments (persiste).
2. `last_outcome` após tools. Recall com `memory_read` / `memory_search` / `episodes_since`.

```text
observar → (sinal) → situar → decidir → expressar / agir → lembrar / querer → …
```

---

## 5. O que cada camada pode fazer

### Sense
- Pode: capturar o SO.
- Não pode: scores, idle→speak, taxonomia de app.

### Brain
- Pode: transportar, parsear, executar tools, persistir, pintar orb.
- Não pode: timer/threshold de “agora pensa / agora fala”.

### Modelo
- Pode: filtrar, calar, falar, aprender, intent, tools.
- Constitution: identidade + keys do JSON — não tabela de ranges nem regulamento de frequência.

### Store
- `user`, `knows`, `episodes`, `intent` — hábitos aqui, não no `.env`.

---

## 6. O que definimos de verdade (infra)

| | Onde | Papel |
|---|------|--------|
| **host** | `lib/config.mjs` → `BIND.host` | `127.0.0.1` |
| **porta** | `lib/config.mjs` → `BIND.port` | `8770` |
| **endpoint** | `.env` → `OPENAI_BASE_URL` | base `…/v1` |
| **model** | `.env` → `OPENAI_CHAT_MODEL` | id do modelo |

`OPENAI_API_KEY` opcional.

### Não é produto (corpo / apresentação)

| Coisa | Onde | Por quê |
|-------|------|---------|
| Geometria do orb | `lib/presentation.mjs` + CSS fallback | pixels da janela, não personalidade |
| Layout jelly + face | `public/avatar-engine.js` + `lib/avatar.mjs` | desenho fixo; todo movimento/expressão = canais do modelo |
| Buffers de captura OS | `lib/sense/util.mjs` → `IO.*` | tamanho de string do SO |
| Ritmo do sense | duração de `collectActivity` | I/O auto-clock |
| Ritmo do UI poll | `requestAnimationFrame` | frame do display |
| `--hot` | argv | dev, não personalidade |

---

## 7. Como evoluir

1. Novo sensor → sense posto cru; modelo interpreta.  
2. Nova mão → tool + catálogo; observation no próximo turn.  
3. Novo jeito de ser → memória / intent / constitution curta.  
4. Bug de infra → adapters, Electron, bind — ok no JS.  
5. “E se spammar?” → não se resolve com gate no host.

---

## 8. Mapa de arquivos

| Caminho | Conceito |
|---------|----------|
| `run.mjs` | Supervisor (brain + sense + orb) |
| `server.mjs` | HTTP + static |
| `lib/config.mjs` | host / porta / endpoint / model |
| `lib/presentation.mjs` | geometria do orb |
| `lib/brain.mjs` | turns event-driven + apply decision |
| `lib/sense*.mjs` | olhos |
| `lib/store.mjs` | memória |
| `lib/tools.mjs` | mãos |
| `lib/avatar.mjs` | canais / normalize do `face` |
| `prompts/companion.md` | identidade + keys do JSON |
| `public/avatar-engine.js` | layout jelly + face paramétrica |
| `public/` | cara do orb |
| `data/memory.json` | memória em disco |

---

## 9. Resumo

1. Olha sem julgar no código.  
2. Pensa quando há sinal — não por relógio de produto.  
3. Entrega o mundo ao modelo.  
4. Aceita decisão estruturada.  
5. Mostra, age, lembra, quer.  
6. Repete.

Infra: **host, porta, endpoint, model**. Resto = organismo ou corpo inevitável.
