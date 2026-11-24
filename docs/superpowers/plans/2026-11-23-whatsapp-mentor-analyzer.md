# Saga v1 — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** App de desktop para Windows que lê os últimos 30 dias do WhatsApp do
mentor, transcreve áudios, resume o que cada mentorado quer, sugere 2–3
respostas editáveis com botão Copiar e aprende com as respostas salvas, tudo
em ritmo lento e seguro contra bloqueio.

**Architecture:** Electron com três camadas. `src/core` é Node puro (banco,
fila com limite de ritmo, WhatsApp, IA, memória) e é testável sem Electron.
`src/main` liga o núcleo ao Electron (janela, bandeja, IPC, energia,
`safeStorage`). `src/renderer` é a interface React em três colunas. Toda
ação de rede para o WhatsApp passa por `core/queue`.

**Tech Stack:** Node 22, TypeScript (strict), electron-vite, Electron,
React 18, `@whiskeysockets/baileys`, `node:sqlite` embutido no Node/Electron (`DatabaseSync`, com FTS5; sem módulo nativo), Vitest,
electron-builder (NSIS) + electron-updater, GitHub Actions (windows-latest).

**Spec:** `docs/superpowers/specs/2026-11-23-whatsapp-mentor-analyzer-design.md`

## Global Constraints

- Toda a interface e todos os prompts em português do Brasil.
- Nenhuma mensagem é enviada pelo app na v1. Não existe chamada a `sendMessage` no código.
- Nunca chamar `readMessages`, `sendReceipt(s)` ou `sendPresenceUpdate`. Socket com `markOnlineOnConnect: false`.
- Somente conversas individuais (`@s.whatsapp.net`). Grupos, status e newsletters são ignorados.
- Janela de histórico: 30 dias, calculada pelo `messageTimestamp` do WhatsApp, nunca pelo relógio local.
- Toda ação de rede para o WhatsApp (download de mídia, foto e nome de perfil) passa por `core/queue`.
- Ritmo padrão dos downloads: intervalo sorteado de 4–12 s, até 300 por hora e 2.000 por dia.
- Aquecimento: 15 min com intervalos dobrados após iniciar o app ou acordar de suspensão de mais de 1 h.
- Reconexão: esperas de 10 s, 30 s, 2 min, 5 min, 15 min e 30 min (teto), com ±20% de variação; no máximo 6 tentativas por hora, depois só manual.
- Groq gratuito: 20 pedidos/min, 2.000/dia, 28.800 s de áudio/dia, mínimo de 10 s cobrado por pedido.
- IA: até 3 tentativas com espera crescente, depois o estado "falhou" com botão "Tentar de novo". Teto de gasto diário configurável (padrão US$ 1,00).
- Espaço livre abaixo de 1 GB pausa a fila.
- Chaves de API só em `safeStorage`, nunca em texto puro nem em logs.
- Dados em `app.getPath('userData')`: `saga.db`, `auth/`, `auth-backup/`, `media/`.

## Review Focus

1. **App morto no meio de um job** (queda de energia): ao reabrir, o job volta para `pending`, sem duplicar a transcrição. Teste em Task 2.
2. **Grande volume de mensagens offline ao religar** (ex.: 500 áudios): nada roda fora do ritmo e o aquecimento se aplica. Teste em Task 2.
3. **Mensagem citando ou respondendo outra, áudio sem `url`/expirado, mensagem apagada ou editada**: a normalização não quebra e o áudio fica "indisponível". Teste em Task 4.
4. **IA devolve JSON inválido ou com 0 ou 5 sugestões**: tenta de novo uma vez e depois mostra erro, normalizando para 2–3. Teste em Task 6.
5. **Contato sem nome e sem notas, sem nenhuma resposta salva (primeiro uso)**: o prompt sai sem exemplos e não quebra. Teste em Task 6.

---

## Estrutura de arquivos

```
package.json, tsconfig.json, electron.vite.config.ts, vitest.config.ts, electron-builder.yml
src/core/
  db/schema.sql          esquema e migrações
  db/db.ts               openDb(path), migrate()
  db/repo.ts             acesso aos dados (contatos, mensagens, análises, memória, jobs, eventos)
  clock.ts               Clock (now(), monotonic()) e implementação falsa para testes
  queue/limiter.ts       RateLimiter (intervalo sorteado, tetos, aquecimento)
  queue/queue.ts         JobQueue persistente (jobs no SQLite)
  wa/reconnect.ts        ReconnectPolicy + classifyDisconnect()
  wa/authState.ts        estado de autenticação com gravação atômica + backup
  wa/normalize.ts        WAMessage -> NormalizedMessage
  wa/client.ts           WhatsAppClient (Baileys) — sem envio
  ai/transcriber.ts      Transcriber (Groq, OpenAI)
  ai/llm.ts              LlmProvider (Groq, Claude)
  ai/prompt.ts           buildPrompt(), parseSuggestions()
  ai/budget.ts           CostTracker
  memory/memory.ts       selectExamples(), saveApproved(), reconcileSent()
  service.ts             SagaService: fachada do núcleo usada pelo main
  disk.ts                hasFreeSpace()
src/main/  index.ts (janela, instância única, bandeja, powerMonitor), ipc.ts, settings.ts (safeStorage), updater.ts
src/preload/index.ts     expõe window.saga (tipado por src/shared/api.ts)
src/shared/api.ts        tipos do contrato IPC
src/renderer/            App.tsx, components/{ContactList,Conversation,Suggestions,SetupWizard,Settings,StatusBar}.tsx, styles.css
tests/core/...           espelha src/core
docs/guia-instalacao.md  guia em pt-BR com imagens
.github/workflows/ci.yml testes e instalador no Windows
```

---

### Task 1: Esqueleto do projeto e banco de dados

**Files:**
- Create (scaffold manual, sem comandos interativos): `package.json`, `tsconfig.json`, `electron.vite.config.ts`, `vitest.config.ts`, `.gitignore`, `src/core/db/schema.sql`, `src/core/db/db.ts`, `src/core/db/repo.ts`, `src/core/clock.ts`
- Test: `tests/core/db/repo.test.ts`

**Interfaces:**
- Produces:
  - `openDb(file: string | ':memory:'): DatabaseSync` de `node:sqlite` (aplica `PRAGMA journal_mode=WAL; foreign_keys=ON` e as migrações)
  - `class Repo(db)` com:
    - `upsertContact(c: {jid, pushName?})`, `renameContact(jid, name)`, `setHidden(jid, bool)`, `setNotes(jid, text)`, `listContacts({includeHidden}): ContactRow[]` (ordenados pela última mensagem desc; com `awaitingReply: boolean` = a última mensagem não é `fromMe`)
    - `insertMessage(m: NormalizedMessage): boolean` (`INSERT OR IGNORE` pelo id; devolve se inseriu), `listMessages(jid, limit?): MessageRow[]`, `setTranscript(id, text | null, status: 'done'|'failed'|'unavailable')`
    - `saveAnalysis(jid, lastMsgId, provider, summary, suggestions: string[])`, `getAnalysis(jid): AnalysisRow | null`
    - `logEvent(kind: string, detail: string)`, `recentEvents(limit): EventRow[]`
  - `interface Clock { now(): number /*epoch ms*/; monotonic(): number }`, `systemClock`, `class FakeClock` (`advance(ms)`)
  - Tabelas: `contacts(jid PK, push_name, custom_name, hidden, notes)`, `messages(id PK, jid, from_me, ts, kind 'text'|'audio'|'other', text, media_key_json, audio_path, transcript, transcript_status)`, `analyses(jid PK, last_msg_id, provider, summary, suggestions_json, created_at)`, `approved_replies(id PK, jid, context_text, original_suggestion, final_text, sent_text, provider, created_at)` + FTS5 `approved_fts(context_text, final_text, tokenize='unicode61 remove_diacritics 2')`, `jobs(id PK, type, key UNIQUE, payload_json, status, attempts, next_run_at, priority, last_error)`, `events(id, ts, kind, detail)`, `settings_kv(key PK, value)`

- [ ] **Step 1: Scaffold manual** (electron-vite + React + TS; Electron atual, cujo Node tem `node:sqlite`). Adicionar `@whiskeysockets/baileys` (fixar a versão exata instalada), `vitest`. Não usar `better-sqlite3`. Silenciar o `ExperimentalWarning` do SQLite nos testes (`NODE_OPTIONS=--no-warnings=ExperimentalWarning` no script de teste) para a saída ficar limpa. Em `.gitignore`: `node_modules`, `out`, `dist`, `*.db`, `auth*/`, `media/`. Os testes do núcleo rodam no Node (`vitest --environment node`); script `"test": "vitest run"`.
- [ ] **Step 2: Testes que falham** em `repo.test.ts`:
  - `insertMessage` com o mesmo id duas vezes → a segunda devolve `false`, e `listMessages` tem 1 item.
  - `listContacts` ordena pela mensagem mais recente; `awaitingReply` é `true` quando a última é do contato e `false` quando é do mentor.
  - `setHidden(jid,true)` some de `listContacts({includeHidden:false})`.
  - O nome exibido é `custom_name ?? push_name ?? número formatado` (ex.: `5547999998888@s.whatsapp.net` → `+55 47 99999-8888`).
- [ ] **Step 3:** Rodar `npm test` → FAIL.
- [ ] **Step 4:** Implementar o esquema, `openDb` e `Repo`.
- [ ] **Step 5:** Rodar `npm test` → PASS. Verificar `npm run dev`: abre a janela vazia.
- [ ] **Step 6: Commit** `feat: scaffold electron app and sqlite repository`

### Task 2: Fila persistente com limite de ritmo (a trava)

**Files:**
- Create: `src/core/queue/limiter.ts`, `src/core/queue/queue.ts`
- Test: `tests/core/queue/limiter.test.ts`, `tests/core/queue/queue.test.ts`

**Interfaces:**
- Consumes: `Repo`, `Clock`, `FakeClock`
- Produces:
  - `interface LimitConfig { minGapMs: number; maxGapMs: number; perHour: number; perDay: number }`
  - `const LIMITS: Record<'wa_media'|'wa_profile'|'groq_audio'|'llm', LimitConfig>`. Valores: `wa_media` {4000, 12000, 300, 2000}; `wa_profile` {8000, 20000, 60, 300}; `groq_audio` {3000, 6000, 20*60, 2000} mais o teto de segundos de áudio; `llm` {0, 1000, 600, 2000}.
  - `class RateLimiter(cfg, clock, rng = Math.random)`: `nextAllowedAt(): number`, `record(costUnits = 1)`, `startWarmup(durationMs = 15*60_000)`; durante o aquecimento os intervalos são dobrados. Para `groq_audio`, `record(seconds)` usa `max(10, seconds)` contra o teto diário de 28.800.
  - `type JobType = 'download_audio' | 'transcribe' | 'fetch_profile'`
  - `class JobQueue(repo, clock, limiters: Record<JobType, RateLimiter>)`:
    - `enqueue(type, key, payload, priority = 0): void` (ignora a chave duplicada)
    - `recoverAfterCrash(): number` (`running` → `pending`; devolve quantos)
    - `pause()`, `resume()`, `isPaused()`
    - `register(type, handler: (payload) => Promise<void>)`
    - `tick(): Promise<'ran'|'idle'|'paused'|'waiting'>`: roda no máximo 1 job por chamada, o pendente de maior prioridade e mais antigo cujo limitador permite.
    - `start()` / `stop()` (laço com `setTimeout` até `nextAllowedAt`)
    - `stats(): {pending, running, failed, done, paused, nextRunAt}`
  - Falha: `attempts++`, `next_run_at = now + [30s, 2min, 10min][attempts-1]`; na 3ª falha, `status='failed'`. `retryFailed(id)` volta para `pending`.
  - Mapeamento tipo de job → limitador: `download_audio`→`wa_media`, `transcribe`→`groq_audio`, `fetch_profile`→`wa_profile` (`llm` é usado direto pela Task 6). O custo do `transcribe` vem de `payload.durationSec`.
  - Intervalo entre ações: medido por `clock.monotonic()` dentro do processo. Tetos por hora/dia: janela deslizante com os horários (`clock.now()`) das ações registradas, persistida em `settings_kv` para sobreviver a reinícios (a contagem diária não zera ao reabrir). Se o relógio voltar para trás (`now` menor que o último registro), tratar o registro como se fosse agora (conservador: nunca libera mais cedo).

- [ ] **Step 1: Testes que falham** (`FakeClock`, `rng` fixo):
  - `limiter`: com `rng=()=>0`, dois `record()` seguidos → `nextAllowedAt` = último + 4000. Com `rng=()=>1` → +12000.
  - `limiter`: após 300 `record()` em menos de 1 h, `nextAllowedAt` ≥ o primeiro + 3.600.000.
  - `limiter`: com `startWarmup()`, o intervalo mínimo vira 8000; depois de `advance(15*60_000)`, volta a 4000.
  - `limiter groq_audio`: 2.880 registros de 10 s esgotam o dia; `record(3)` conta 10.
  - `queue`: enfileirar 500 `download_audio` e chamar `tick()` repetidamente sem avançar o relógio → exatamente 1 `'ran'` e o resto `'waiting'`.
  - `queue`: um job em `running` + um novo `JobQueue` sobre o mesmo banco + `recoverAfterCrash()` → 1, e o job roda de novo; o handler idempotente não duplica a transcrição (`setTranscript` chamado 1 vez ao todo quando a primeira execução não terminou).
  - `queue`: `pause()` → `tick()` devolve `'paused'`.
  - `queue`: o handler lança erro 3 vezes → `status='failed'`; `retryFailed` volta para `pending`.
  - `queue`: prioridade: um job `priority=10` enfileirado depois roda antes de um `priority=0`.
  - `queue`: a contagem diária persiste: 2.000 `record` → reabrir o limitador sobre o mesmo `repo` → continua bloqueado.
- [ ] **Step 2:** `npm test -- queue` → FAIL.
- [ ] **Step 3:** Implementar `RateLimiter` e `JobQueue`.
- [ ] **Step 4:** `npm test -- queue` → PASS.
- [ ] **Step 5: Commit** `feat: persistent rate-limited job queue with warmup`

### Task 3: Política de reconexão e classificação de desconexões

**Files:**
- Create: `src/core/wa/reconnect.ts`
- Test: `tests/core/wa/reconnect.test.ts`

**Interfaces:**
- Produces:
  - `type DisconnectClass = 'retry' | 'logged_out' | 'restricted' | 'outdated' | 'replaced'`
  - `classifyDisconnect(statusCode: number | undefined, message?: string): DisconnectClass`. Mapeamento pelos `DisconnectReason` do Baileys: `loggedOut` (401) → `logged_out`; `forbidden` (403) → `restricted`; `connectionReplaced` (440) → `replaced`; `badSession` (500) → `retry` (o cliente restaura o backup); 405 ou uma mensagem com "version" → `outdated`; o resto (408, 428, `connectionLost`, `restartRequired` 515, undefined) → `retry`.
  - `class ReconnectPolicy(clock, rng)`: `nextDelayMs(): number | null` (null = desistir até a ação manual), `reset()` (chamar ao conectar com sucesso), `manualRetry()`. Sequência `[10_000, 30_000, 120_000, 300_000, 900_000, 1_800_000]`, depois fica em 1.800.000; ±20% de variação; no máximo 6 tentativas em 60 min deslizantes.

- [ ] **Step 1: Testes que falham:** a sequência com `rng=()=>0.5` é exatamente `[10s,30s,2min,5min,15min,30min]`; a 7ª dentro de 1 h → `null`; após `advance(60min)` volta a dar um valor; `reset()` reinicia em 10s; `classifyDisconnect(401)==='logged_out'`, `(403)==='restricted'`, `(440)==='replaced'`, `(515)==='retry'`, `(405)==='outdated'`.
- [ ] **Step 2:** FAIL → **Step 3:** implementar → **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat: reconnect backoff policy and disconnect classification`

### Task 4: Cliente WhatsApp (somente leitura)

**Files:**
- Create: `src/core/wa/authState.ts`, `src/core/wa/normalize.ts`, `src/core/wa/client.ts`, `src/core/disk.ts`
- Test: `tests/core/wa/normalize.test.ts`, `tests/core/wa/authState.test.ts`, `tests/fixtures/wa/*.json`

**Interfaces:**
- Consumes: `Repo`, `JobQueue`, `ReconnectPolicy`, `classifyDisconnect`, `Clock`
- Produces:
  - `interface NormalizedMessage { id: string; jid: string; fromMe: boolean; ts: number /*ms*/; kind: 'text'|'audio'|'other'; text: string | null; mediaKeyJson: string | null /*mensagem serializada p/ download*/; durationSec: number | null }`
  - `normalize(msg: WAMessage): NormalizedMessage | null`: devolve `null` para grupos, `status@broadcast`, newsletters, `protocolMessage` (apagar/editar), reações e mensagens sem conteúdo. Texto de `conversation` ou `extendedTextMessage.text`. `audioMessage` → `kind 'audio'` com `durationSec=seconds`. Imagem/vídeo/documento → `'other'` com a legenda como texto, ou `"[imagem]"`, `"[vídeo]"`, `"[documento: nome]"`. Mensagens efêmeras e de visualização única: desembrulhar `ephemeralMessage`/`viewOnceMessage*`.
  - `useAtomicAuthState(dir: string, backupDir: string)`: igual a `useMultiFileAuthState`, mas grava em `file.tmp` e depois `rename`. `backup()` copia `dir` → `backupDir` após cada conexão aberta com sucesso. `restoreBackup(): boolean`.
  - `class WhatsAppClient(deps: {repo, queue, clock, authDir, backupDir, mediaDir})` com eventos (EventEmitter): `'qr'(dataUrl)`, `'status'(ConnState)` onde `ConnState = 'connecting'|'open'|'waiting_retry'|'needs_qr'|'stopped_logged_out'|'stopped_restricted'|'stopped_outdated'|'manual_retry_needed'`, `'message'(NormalizedMessage)`. Métodos: `start()`, `stop()`, `manualReconnect()`, `onResumeFromSleep(sleptMs)`.
  - Socket: `makeWASocket({ auth, browser: Browsers.windows('Desktop'), markOnlineOnConnect: false, syncFullHistory: true, shouldSyncHistoryMessage: () => true, generateHighQualityLinkPreview: false })`. Nunca chamar leitura/presença.
  - Ingestão (`messaging-history.set` e `messages.upsert`): `normalize`, descartar se `ts < now - 30d`, `repo.insertMessage`. Para áudio novo: `queue.enqueue('download_audio', id, {id}, priority)`, com prioridade 10 se o contato está aguardando resposta e mensagem com menos de 3 dias, senão 0. `upsertContact` com `pushName`.
  - Handler `download_audio`: `hasFreeSpace(mediaDir, 1GB)` falso → `queue.pause()` e `logEvent('disk_low')`. Baixar com `downloadMediaMessage`, salvar `media/<id>.ogg` e enfileirar `transcribe`. Erro 404/410 (mídia expirada) → `setTranscript(id, null, 'unavailable')` sem nova tentativa.
  - Desconexão: `classifyDisconnect` → `retry` usa `ReconnectPolicy` (`null` → `manual_retry_needed`). `badSession` → `restoreBackup()` uma vez e depois `needs_qr`. `logged_out`/`restricted`/`outdated` → `queue.pause()`, estado `stopped_*` e `logEvent`, sem nova tentativa. `replaced` → `stopped`, sem tentar (outra instância conectou).
  - Handler `fetch_profile`: só para contatos sem `pushName`, enfileirado por `SagaService.listContacts` quando o contato aparece na lista (prioridade 0). Busca o nome com `sock.getBusinessProfile`/`onWhatsApp` e grava com `upsertContact`. Fotos de perfil ficam fora da v1.
  - `onResumeFromSleep(ms)`: se `ms > 3.600.000`, chamar `startWarmup()` em todos os limitadores.
  - `hasFreeSpace(dir, minBytes): Promise<boolean>` via `fs.statfs`.

- [ ] **Step 1: Fixtures e testes que falham** de `normalize`: texto simples; `extendedTextMessage` com citação → o texto da própria mensagem; áudio PTT com `seconds=37`; mensagem de grupo → `null`; `protocolMessage` REVOKE → `null`; reação → `null`; `ephemeralMessage` com texto → desembrulhado; imagem com legenda → `'other'` com a legenda.
- [ ] **Step 2: Teste de `authState`:** gravar a chave → existe o arquivo final e nenhum `.tmp` sobra. `backup()` seguido de corromper o arquivo e `restoreBackup()` → o conteúdo original volta.
- [ ] **Step 3:** FAIL → **Step 4:** implementar `normalize`, `authState`, `disk`, `client`.
- [ ] **Step 5:** PASS. Checar no código: `grep -rE "sendMessage|readMessages|sendPresenceUpdate|sendReceipt" src/` não retorna nada.
- [ ] **Step 6: Commit** `feat: read-only whatsapp client with safe ingestion`

### Task 5: Transcrição (Groq grátis, OpenAI opcional)

**Files:**
- Create: `src/core/ai/transcriber.ts`
- Test: `tests/core/ai/transcriber.test.ts`

**Interfaces:**
- Consumes: `JobQueue`, `Repo`, `LIMITS.groq_audio`
- Produces:
  - `interface Transcriber { transcribe(file: string, durationSec: number): Promise<string> }`
  - `createTranscriber(kind: 'groq'|'openai', apiKey: string, fetchImpl = fetch): Transcriber`. Groq: `POST https://api.groq.com/openai/v1/audio/transcriptions`, multipart com `model=whisper-large-v3`, `language=pt`, `response_format=text`. OpenAI: `https://api.openai.com/v1/audio/transcriptions`, `model=whisper-1`.
  - Handler `transcribe`: lê `audio_path` e chama `setTranscript(id, text, 'done')`. HTTP 429 → lança `RateLimitedError(retryAfterMs)`; a fila respeita `retry-after` sem contar como tentativa falha. 401 → `queue.pause()` + `logEvent('ai_key_invalid')`.

- [ ] **Step 1: Testes que falham** com `fetchImpl` falso: envia `model=whisper-large-v3` e `language=pt` para a URL da Groq; com 429 e `retry-after: 30` → `RateLimitedError` com 30000; com 401 → a fila fica pausada.
- [ ] **Step 2:** FAIL → **Step 3:** implementar (adicionar em `JobQueue` o tratamento de `RateLimitedError`: `next_run_at = now + retryAfterMs`, `attempts` igual) → **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat: groq/openai audio transcription jobs`

### Task 6: Memória, prompt e provedores de sugestão

**Files:**
- Create: `src/core/memory/memory.ts`, `src/core/ai/prompt.ts`, `src/core/ai/llm.ts`, `src/core/ai/budget.ts`
- Test: `tests/core/memory/memory.test.ts`, `tests/core/ai/prompt.test.ts`, `tests/core/ai/llm.test.ts`

**Interfaces:**
- Consumes: `Repo`, `RateLimiter(LIMITS.llm)`
- Produces:
  - `selectExamples(repo, jid, contextText): Example[]` com `Example = {context: string; reply: string; source: 'same_contact'|'similar'|'recent'|'sent_history'}`. Pega até 3 de `same_contact` (`approved_replies` do jid, mais recentes), até 3 de `similar` (FTS5 `bm25` sobre palavras do `contextText` com ≥4 letras, excluindo os já escolhidos), até 2 de `recent` (qualquer jid) e até 3 de `sent_history` (mensagens `fromMe` reais do mesmo jid, com a mensagem anterior do contato como contexto). Usa `sent_text ?? final_text` como `reply`.
  - `saveApproved(repo, {jid, contextText, originalSuggestion, finalText, provider}): number`
  - `reconcileSent(repo, msg: NormalizedMessage)`: para `fromMe` de texto, procura o `approved_replies` do mesmo jid criado até 6 h antes e ainda sem `sent_text`, com `similarity(final_text, msg.text) ≥ 0.6` (`similarity` = 1 − Levenshtein normalizado sobre texto minúsculo sem pontuação). Se achar, grava `sent_text`. Chamado na ingestão de mensagens (Task 4 → registrar em `SagaService`).
  - `buildPrompt({contactName, notes, newMessages: MessageRow[], priorMessages: MessageRow[] /*até 20*/, examples}): {system: string; user: string}`. Áudios aparecem como `[áudio transcrito] texto` ou `[áudio indisponível]`. O `system` pede JSON `{"resumo": string, "sugestoes": string[]}` com 2–3 sugestões de abordagens diferentes (direta, acolhedora, com pergunta de aprofundamento), em pt-BR, imitando o tom dos exemplos.
  - `parseSuggestions(raw: string): {summary: string; suggestions: string[]}`: aceita JSON puro ou dentro de bloco ```json; corta para no máximo 3; menos de 2 sugestões → lança `InvalidOutputError`.
  - `interface LlmProvider { name: 'groq'|'claude'; complete(p: {system, user}): Promise<{text: string; inputTokens: number; outputTokens: number}> }`
  - `createLlm('groq', key)`: `POST https://api.groq.com/openai/v1/chat/completions`, `response_format: {type:'json_object'}`, modelo em `settings` (padrão: o melhor modelo de texto do catálogo gratuito da Groq em pt-BR no momento do build; registrar o nome escolhido no README). `createLlm('claude', key)`: SDK `@anthropic-ai/sdk`, `messages.create`, modelo em `settings` (padrão `claude-sonnet-5-5`), `max_tokens: 1500`. Antes de implementar, consultar o skill `claude-api`.
  - `generateAnalysis(deps, jid): Promise<AnalysisRow>`: monta o contexto (mensagens desde o último `fromMe` = novas; as 20 anteriores = contexto), chama o LLM, faz `parseSuggestions` e, se der `InvalidOutputError`, mais uma tentativa; depois `saveAnalysis`. Se `getAnalysis(jid).last_msg_id` já é a última mensagem, devolve o cache sem chamar a IA.
  - `class CostTracker(repo, clock)`: `add(provider, inTok, outTok)`, `todayUsd()`, `overCap(capUsd): boolean`. Groq = 0. O preço do Claude vem de uma tabela no código (consultar o skill `claude-api`). `generateAnalysis` lança `BudgetExceededError` quando `overCap`.

- [ ] **Step 1: Testes que falham:**
  - `selectExamples` sem nenhuma resposta salva e sem histórico → `[]`, e `buildPrompt` com `examples=[]`, `notes=null` e nome = número não quebra; o `user` contém as mensagens novas.
  - `selectExamples` prioriza o mesmo contato e não repete o mesmo exemplo em duas fontes.
  - `similar` acha a resposta salva cujo contexto tem "precificação" quando o `contextText` fala de "precificação dos produtos".
  - `reconcileSent`: salvo "Oi Michael, pode sim! Vamos marcar amanhã?" e enviado 10 min depois "Oi Michael, pode sim! Vamos marcar amanhã às 15h?" → `sent_text` gravado. Enviado 7 h depois → não grava. Texto totalmente diferente → não grava.
  - `parseSuggestions`: JSON dentro de ```json → ok; 5 sugestões → 3; 1 sugestão → `InvalidOutputError`; lixo → `InvalidOutputError`.
  - `generateAnalysis` com LLM falso que devolve lixo e depois JSON válido → sucesso com 2 chamadas. Com lixo duas vezes → erro e nada salvo. Com cache válido → 0 chamadas.
  - `createLlm('groq')` com `fetch` falso envia `response_format` json_object.
- [ ] **Step 2:** FAIL → **Step 3:** implementar → **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat: memory examples, prompt and groq/claude suggestion providers`

### Task 7: SagaService, processo principal e configurações

**Files:**
- Create: `src/core/service.ts`, `src/shared/api.ts`, `src/main/index.ts`, `src/main/ipc.ts`, `src/main/settings.ts`, `src/preload/index.ts`
- Test: `tests/core/service.test.ts`

**Interfaces:**
- Consumes: tudo de Tasks 1–6
- Produces (`src/shared/api.ts`, exposto como `window.saga`):
  - `getState(): Promise<AppState>` com `AppState = {conn: ConnState; qr: string|null; queue: QueueStats; paused: boolean; costTodayUsd: number; setupDone: boolean; provider: 'groq'|'claude'}`
  - `onState(cb)`, `onContactsChanged(cb)`, `onMessages(jid, cb)`
  - `listContacts(includeHidden)`, `listMessages(jid)`, `getAnalysis(jid)` (gera se necessário), `regenerate(jid)`
  - `saveReply({jid, originalSuggestion, finalText})`, `copyToClipboard(text)` (via `clipboard.writeText` no main)
  - `renameContact`, `setHidden`, `setNotes`
  - `pauseAll()`, `resumeAll()`, `manualReconnect()`, `retryFailedJobs()`
  - `getSettings()` → as chaves vêm só como `{groq: boolean; claude: boolean; openai: boolean}`, nunca o valor. `saveSettings({groqKey?, claudeKey?, openaiKey?, provider?, transcriber?, dailyCapUsd?, startWithWindows?})`
  - `testKey(kind, key): Promise<boolean>` (chamada barata para validar a chave no assistente)
  - `audioUrl(id)`: caminho servido por um protocolo `saga-media://` registrado no main, para ouvir o original.
- `SagaService.start()`: `queue.recoverAfterCrash()`, `startWarmup()` em todos os limitadores, `waClient.start()`, `queue.start()`. Não dispara nenhuma geração de IA.
- `main/index.ts`: `app.requestSingleInstanceLock()` (falhou → `app.quit()`; `second-instance` → mostra e foca a janela); fechar a janela esconde na bandeja; menu da bandeja: Abrir, Pausar/Retomar, Sair. `powerMonitor.on('suspend')` guarda o horário; `on('resume')` → `waClient.onResumeFromSleep(dt)`. `app.setLoginItemSettings({openAtLogin})` conforme a configuração. Ao sair: `queue.stop()` e espera o job atual terminar (até 5 s).
- `settings.ts`: `safeStorage.encryptString` → base64 em `settings_kv`. Se `safeStorage.isEncryptionAvailable()` for falso, mostra um erro e não salva a chave.

- [ ] **Step 1: Testes que falham** (`service.test.ts`, com WA e LLM falsos): `start()` chama `recoverAfterCrash` e `startWarmup` e não chama o LLM. Ao ingerir 200 mensagens de áudio offline, o LLM tem 0 chamadas e a fila tem 200 pendentes. `saveReply` grava em `approved_replies` com o `context_text` = as mensagens novas do contato. `getSettings` nunca contém o texto da chave.
- [ ] **Step 2:** FAIL → **Step 3:** implementar → **Step 4:** PASS. `npm run dev`: abrir o app duas vezes → só uma janela.
- [ ] **Step 5: Commit** `feat: saga service, electron main, ipc and encrypted settings`

### Task 8: Interface em três colunas, assistente e status

**Files:**
- Create: `src/renderer/App.tsx`, `src/renderer/components/{SetupWizard,ContactList,Conversation,Suggestions,Settings,StatusBar}.tsx`, `src/renderer/styles.css`
- Test: `tests/renderer/suggestions.test.tsx` (Vitest + Testing Library, jsdom)

**Interfaces:**
- Consumes: `window.saga` (`src/shared/api.ts`)
- Comportamento:
  - **SetupWizard** (quando `setupDone=false`): 1) boas-vindas e aviso sobre o risco; 2) chave Groq com link `https://console.groq.com/keys`, passo a passo e "Testar"; 3) Claude opcional ("Pular"); 4) QR Code com instrução "No celular: WhatsApp › Aparelhos conectados › Conectar um aparelho"; 5) progresso da importação.
  - **StatusBar** (topo): bolinha de conexão com texto (ex.: "Conectado", "Reconectando em 2 min", "Desconectado — vincule novamente", "Pausado"), "Baixando áudios: 12 de 340", gasto de hoje, botão **Pausar tudo / Retomar** e botão "Reconectar" quando `manual_retry_needed`.
  - **ContactList**: busca, ponto verde em "aguardando resposta", menu do contato (Renomear, Esconder, Notas), alternar "mostrar escondidos".
  - **Conversation**: balões estilo WhatsApp com data/hora; áudio mostra a transcrição em itálico com ▶ para ouvir; "Transcrevendo…", "Áudio indisponível" ou "Falhou — tentar de novo". No topo, um cartão "O que a pessoa quer" com o resumo.
  - **Suggestions**: 2–3 cartões; cada um com `<textarea>` editável, **Salvar** (fica "Salvo ✓") e **Copiar** ("Copiado ✓" por 2 s). Embaixo, "Gerar novas" e qual IA gerou. Estados: carregando, erro com "Tentar de novo", limite de gasto atingido.
  - **Settings**: chaves (só "configurada ✓" ou campo para trocar), IA das sugestões (Groq grátis / Claude), transcrição (Groq / OpenAI), teto de gasto diário, iniciar com o Windows, ritmo (somente leitura) e os eventos recentes.
- [ ] **Step 1: Testes que falham** (`suggestions.test.tsx`, `window.saga` falso): editar o texto e clicar em Salvar → `saveReply` com `originalSuggestion` = o texto gerado e `finalText` = o editado. Copiar → `copyToClipboard` com o texto editado e o rótulo "Copiado ✓". Com `getAnalysis` rejeitando → aparece "Tentar de novo".
- [ ] **Step 2:** FAIL → **Step 3:** implementar → **Step 4:** PASS.
- [ ] **Step 5: Verificação visual:** `npm run dev` com `SAGA_FAKE_WA=1` (um `WhatsAppClient` falso que carrega `tests/fixtures/wa/demo.json` com 5 contatos e áudios já transcritos). Tirar capturas das três colunas e conferir.
- [ ] **Step 6: Commit** `feat: three-column UI, setup wizard, settings and status bar`

### Task 9: Instalador Windows, atualizações, CI e guia

**Files:**
- Create: `electron-builder.yml`, `src/main/updater.ts`, `.github/workflows/ci.yml`, `docs/guia-instalacao.md`, `README.md`, `build/icon.ico`

**Interfaces:**
- `electron-builder.yml`: `appId: br.com.saga.mentoria`, `productName: Saga`, alvo `nsis` (`oneClick: false`, `perMachine: false`, atalho na área de trabalho), sem módulos nativos, `publish: github`.
- `updater.ts`: `autoUpdater.autoDownload = false`; ao achar uma versão, mostra o aviso "Nova versão disponível — Atualizar" no StatusBar; o clique baixa e instala ao sair. Se o repositório for privado, as atualizações automáticas exigem token: deixar o updater desligado por configuração (`SAGA_UPDATES=off`) e o guia explica como baixar o novo `.exe` manualmente.
- CI (`windows-latest`, Node 22): `npm ci`, `npm test`, `npm run build`, `npx electron-builder --win --publish never`; o `.exe` sobe como artefato do workflow.
- `guia-instalacao.md` (pt-BR, para quem não usa terminal): baixar o `.exe` em GitHub › Actions/Releases; o aviso "O Windows protegeu o computador" › "Mais informações" › "Executar assim mesmo"; criar a chave Groq; escanear o QR Code; o que significa cada estado do StatusBar; o que fazer se aparecer "vincule novamente".

- [ ] **Step 1:** Configurar o builder e o CI. Fazer o push e conferir que o workflow fica verde e gera `Saga-Setup-x.y.z.exe`.
- [ ] **Step 2:** Escrever o guia e o README (com o modelo Groq escolhido e os limites).
- [ ] **Step 3: Teste manual no Windows**, com o mentor ou numa VM: instalar, assistente, QR, importar, abrir conversa, salvar e copiar. Depois: tirar a internet 5 min (deve reconectar sozinho com espera), suspender o notebook, abrir o app duas vezes, encerrar pelo Gerenciador de Tarefas no meio de downloads e reabrir (nada duplicado, ritmo lento na volta).
- [ ] **Step 4: Commit** `build: windows installer, updater, ci and install guide`

---

## Pontos em aberto para quem executa

- O modelo de texto da Groq é escolhido no momento do build (catálogo gratuito atual, melhor em pt-BR). Registrar no README.
- Atualização automática depende de o repositório ser público ou de publicar os releases num repositório público separado. Confirmar com o mentor antes da Task 9.
- O build do instalador e os testes no Windows dependem do acesso do Claude ao GitHub (hoje bloqueado).
