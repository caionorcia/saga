# SagaZap (antes Saga) — Assistente de respostas para mentorados (WhatsApp)

Data: 2026-11-23 · Status: aprovado · Atualizado: 2026-11-26 (v0.7.0, follow-up do Copiloto)

## Intenção e o porquê

O mentor atende muitos mentorados pelo WhatsApp (número com DDD 47) e gasta
tempo lendo conversas, ouvindo áudios e escrevendo respostas. O app deve:

1. Ler as conversas dos últimos 30 dias pelo WhatsApp Web.
2. Mostrar, por mentorado, o que a pessoa quer (resumo), com áudios já
   transcritos em texto.
3. Sugerir 2 ou 3 respostas, que o mentor pode editar.
4. Ao salvar, guardar a resposta aprovada como "memória", para que as
   sugestões seguintes fiquem cada vez mais parecidas com o jeito do mentor
   responder.
5. Ter um botão **Copiar** para o mentor colar a resposta no WhatsApp e, desde a v0.4.0, um botão **Enviar** que
   envia a resposta pelo próprio app, sempre com a confirmação explícita do mentor a cada envio (ver "Envio direto").

O sucesso é o mentor responder mais rápido, com sugestões que precisam de
cada vez menos correção.

## Objetivos (v1)

- Conectar ao WhatsApp como aparelho vinculado (QR Code), uma única vez;
  a sessão fica salva e reconecta sozinha.
- Importar o histórico dos últimos 30 dias que o WhatsApp entregar na
  sincronização, e continuar recebendo mensagens novas com o app aberto.
- Transcrever automaticamente todos os áudios (mensagens de voz).
- Interface em 3 colunas, parecida com o WhatsApp:
  - **Esquerda:** lista de conversas individuais (mentorados), ordenada pela
    mensagem mais recente, com indicador de "aguardando resposta"
    (última mensagem foi do mentorado). Busca por nome. Botão para
    esconder contatos que não são mentorados (persistente). Removido na v0.3.0: o telefone é só profissional
    (ver "Sem conversas escondidas").
  - **Centro:** histórico da conversa (mensagens de ambos os lados, com
    data/hora); áudios aparecem como texto transcrito (com opção de ouvir o
    original). No topo, um resumo curto: "O que a pessoa quer".
  - **Direita:** 2–3 sugestões de resposta; cada uma pode ser editada num
    campo de texto; botões **Salvar** (grava na memória) e **Copiar**
    (copia para a área de transferência). Botão para gerar novas sugestões.
    **Copiar** também salva (se o texto ainda não foi salvo). Copiar ou Salvar
    *escolhe* a sugestão: as outras somem com um fade, o cartão fica marcado
    "✓ Resposta escolhida" e "Mostrar as outras sugestões" as traz de volta. A
    escolha fica na análise (`chosen_index`, `chosen_reply_id`) e some quando
    uma análise nova é gerada. As sugestões não escolhidas vão em
    `approved_replies.rejected_json`; até 2 exemplos do prompt (mesmo contato ou
    parecidos) ganham a linha "Não escolhida: …" (200 caracteres).
- Memória de aprendizado: respostas salvas viram exemplos nas próximas
  gerações (ver "Memória").

## Grupos (v0.1.5, a pedido do mentor)

Os grupos eram um não-objetivo da v1. O mentor pediu para vê-los, porque quase
todos os grupos dele são de mentoria. Decisão: **todos os grupos** entram, com
resumo e sugestões como nas conversas individuais, e um filtro para ver só
grupos ou só individuais.

- **Ingestão:** conversas `@g.us` entram (status, newsletters e listas de
  transmissão continuam fora). Cada mensagem de grupo guarda quem mandou
  (`participant`, com `@lid` → telefone pelo mesmo mapa das conversas
  individuais, ou `participantAlt`) e o pushName dessa pessoa. Valem a janela
  de 30 dias, o "esconder" e a fila de áudios.
- **Prioridade dos áudios de grupo:** 0, a não ser que a mensagem mencione o
  mentor (@) ou cite uma mensagem dele; aí vale como "aguardando resposta e
  recente" (10). Conversas individuais seguem a regra de antes.
- **Nome do grupo:** vem dos eventos `groups.upsert`/`groups.update`, dos
  nomes de conversa do histórico e, uma vez por abertura (no máximo a cada
  24 h), de uma consulta só de leitura (`groupFetchAllParticipating`) feita
  **pela fila**, com o ritmo das consultas de perfil. O app nunca chama nada
  que altere grupos (criar, sair, mudar assunto, participantes etc.).
- **Lista:** filtro "Todos | Individuais | Grupos" no topo (a escolha fica
  guardada neste computador); grupos com ícone próprio; a busca vale para os
  dois. Num grupo, "aguardando resposta" = a última mensagem não é do mentor.
- **Conversa:** em cada balão de grupo aparece o nome de quem mandou (uma vez
  por sequência da mesma pessoa) e um selo quando a mensagem menciona o
  mentor. O resumo de grupo se chama "O que pedem a você".
- **IA:** cada mensagem vai como "Nome: texto". O resumo de grupo foca no que
  pedem ao mentor (perguntas e pedidos para ele, menções, dúvidas sem
  resposta), não na conversa inteira. As 2–3 sugestões são mensagens para o
  mentor postar no grupo, chamando as pessoas pelo nome quando ajudar.
  "Mensagens novas" = depois da última mensagem do mentor, no máximo as
  últimas 40 (para controlar o custo); contexto anterior: 20. A memória
  funciona igual (o "mesmo contato" é o grupo).

## Fila do dia e alertas (v0.2.0, a pedido do mentor)

Objetivo: nenhum mentorado fica sem resposta e o mentor age cedo nos sinais.

- **Espera:** `waitingSince` = horário da primeira mensagem do contato depois da última do mentor (null se o
  mentor falou por último). Selo na lista: "há 15 min", "há 3 h", "há 2 dias"; neutro até 24 h, âmbar de 24 a
  48 h, vermelho depois de 48 h (constantes em `src/shared/triage.ts`).
- **Lista:** dois botões de liga/desliga acima do filtro "Todos | Individuais | Grupos": **Para responder (N)**
  (só quem espera, quem espera há mais tempo primeiro) e **Com alerta (M)** (gravidade: urgente > desânimo >
  travado > reunião > esperando, depois a espera). Ficam separados do filtro de tipo porque combinam com ele
  (ex.: "Para responder" + "Grupos") e cinco botões numa linha não cabem na coluna; o número no botão mostra o
  tamanho da fila sem precisar clicar. A escolha fica guardada neste computador.
- **Alertas:** tabela `alerts(jid, kind, detail, msg_id, created_at, dismissed_at)`, um ativo por conversa e
  tipo. Tipos da IA: `urgente`, `desanimo`, `reuniao`, `travado`. Por regra (sem IA): `esperando`, mais de 48 h
  sem resposta (em grupo, só se alguém mencionou o mentor nessa espera); resolvido à mão, não volta na mesma
  espera. Resposta do mentor resolve urgente/travado/reunião/esperando; desânimo fica até o mentor resolver.
- **Detecção pela IA, em segundo plano:** job `classify` (um por conversa) na fila única, com limitador próprio
  (20–40 s entre chamadas, 60/h, 400/dia), aquecimento e um intervalo inteiro antes do primeiro job ao abrir
  (sem rajada). Só a **Groq gratuita**, seja qual for o provedor das sugestões; sem chave da Groq, não há
  alertas da IA (nunca gasta com o Claude em segundo plano). Respeita o teto diário e a escolha automática de
  modelo. Só conversas não escondidas, com mensagem nova do contato nos últimos 7 dias; até 20 mensagens novas
  + 6 de contexto, áudios como transcrição (espera até 30 min por um áudio ainda sendo transcrito), nome de
  quem mandou nos grupos (e só sinais dirigidos ao mentor). `alert_checks` guarda até qual mensagem já se olhou:
  a mesma janela nunca é analisada duas vezes. Saída JSON `{alerts:[{kind, detail ≤120, messageId}]}` lida com
  cuidado; inválida → nenhum alerta, registrado. Erros da IA não viram "falha" na barra de status.
- **Conversa:** faixa fina sob o cabeçalho com cada alerta, o detalhe, "Resolver" e, quando há, o clique que
  rola até a mensagem e a destaca. **Barra de status:** "N para responder · M com alerta" (conversas, fora as
  escondidas); o clique abre "Para responder".
- **Registro de diagnóstico:** uma linha por job (`classify result=… alerts=N ms=…`), sem jid nem texto.

### Avaliação dos alertas (v0.2.1, a pedido do mentor)

Objetivo: o classificador aprende com o mentor e as avaliações viram dados para análise.

- **Dados:** `alerts` ganha `source` (`ai` | `rule` = "esperando" | `user` = marcado pelo mentor), `context_text` (a
  janela exata que a IA viu: "Conversa anterior" + "Mensagens novas" numeradas) e `model`. Tabela
  `alert_feedback(alert_id, jid, kind, msg_id, verdict 'up'|'down'|'missed', reason_code, reason_text, correct_kind,
  context_text, detail, model, created_at)`: cada linha é um exemplo rotulado completo. Uma avaliação por alerta (mudar
  de ideia atualiza a mesma linha). Alerta antigo sem janela guardada, e "faltou": as 8 mensagens até a escolhida (ou
  as últimas).
- **Conversa:** 👍/👎 (rótulos "Alerta correto"/"Alerta errado") nos alertas da IA (na v0.2.2, em todos — ver abaixo). 👍 grava `up` e o alerta fica. 👎 abre "O que está errado neste alerta?":
  motivo obrigatório (Não é esse tipo de alerta → "Qual seria o certo?" com os outros tipos + Nenhum; Era
  brincadeira/ironia; Já foi resolvido; Não era comigo; Exagerado; Outro) e texto opcional; salvar resolve o alerta e,
  com o tipo certo, cria esse (`source=user`). "Faltou um alerta?" no cabeçalho: tipo, mensagem opcional (as 10 últimas
  do contato) e texto → `missed` + o alerta. Aviso discreto "Obrigado — o Saga vai aprender com isso".
- **Aprendizado:** o prompt do `classify` leva até 6 avaliações recentes (primeiro da mesma conversa; depois das outras,
  alternando os tipos; no máximo 2 👍), cada uma numa linha com o fim do trecho (≤ 400 caracteres): "Exemplo: mensagens
  "…" → alerta X estava ERRADO porque: …" / "→ deveria ter alertado Y" / "→ … estava CERTO". "Já foi resolvido" não
  vira exemplo (não diz nada sobre a mensagem). Depois de um 👎, a IA nunca recria o mesmo tipo para a mesma mensagem, e
  não reescreve um alerta marcado pelo mentor.
- **Configurações → Qualidade dos alertas:** por tipo, 👍/👎/faltou dos últimos 30 dias e % de acerto 👍/(👍+👎).
  "Exportar avaliações (CSV)": o "Salvar como" é do processo principal (o caminho nunca vem da interface); UTF-8 com
  BOM e ";" (o Excel em português usa ";"), colunas `data; tipo; avaliação; motivo; motivo_texto; tipo_correto;
  conversa; trecho; detalhe; modelo`; células que começam com = + - @ ganham ' (sem fórmulas). "Anonimizar nomes"
  (ligado por padrão) troca a conversa por "Contato N"; o aviso diz que o arquivo traz trechos das mensagens e que
  nomes citados nelas continuam.
- **Registro de diagnóstico:** `alert_feedback verdict=… reason=…|kind=…` e `alert_feedback_export rows=N`, sem texto
  nem jid.

### "Para responder" mais certeiro e 👍/👎 em todos os alertas (v0.2.2, a pedido do mentor)

Pedido do mentor: "Na lista de Para responder temos vários casos equivocados" (último recado era só "obrigado", "ok",
emoji, figurinha, despedida, conversa de grupo que não era com ele, ou ele já tinha respondido por ligação) e "Por que
somente uma conversa veio com positivo e negativo?" (o "esperando" e os alertas marcados por ele não tinham 👍/👎).

- **Decisão por conversa:** tabela `reply_checks(jid, msg_id, app_needs, app_reason, app_source 'rule'|'ai', model,
  user_needs, updated_at)`, uma linha por conversa, sobre a **última mensagem do contato** (`msg_id`). Vale a do mentor
  (`user_needs`), senão a do Saga (`app_needs`), senão "precisa". Mensagem nova do contato = `msg_id` diferente = a
  decisão não vale mais (volta para a lista até ser classificada de novo). `ContactRow` ganha `needsReply` (aguarda
  resposta e ninguém decidiu que não precisa) e `replyDecision {needed, by, reason}`. "Para responder", o contador da
  barra (`triage.awaiting`) e o selo de espera usam `needsReply`; a conversa que não precisa aparece em "Todos" com
  "Sem pendência" e a etiqueta "Não precisa responder" (o motivo no `title`).
- **Regra sem IA (antes da IA):** as mensagens do contato depois da última do mentor (até 6) são todas agradecimento/ok/
  emoji/figurinha/risada/despedida curta: lista pt-BR sem acento nem maiúsculas ("ok", "obrigado(a)", "valeu", "show",
  "top", "beleza", "combinado", "tchau", "kkk", 👍, 🙏…), até 4 palavras, sem "?"; emojis de tristeza/dúvida (😢 ❓)
  não contam. Roda quando a mensagem chega (mesmo sem chave da Groq) e não agenda o `classify` (não gasta chamada).
  Reações do WhatsApp nem viram mensagem (já eram descartadas na ingestão). Na dúvida, precisa.
- **IA (o mesmo job `classify`, Groq, mesmo limitador):** a saída ganha `needsReply: boolean` e `reason` (≤ 100,
  pt-BR) para as mensagens do contato depois da última do mentor. Prompt: agradecimento, ok, emoji, risada, despedida,
  informativo sem pedido e (grupo) conversa entre participantes → false; pergunta, pedido, problema, menção ao mentor →
  true; na dúvida, true. Sem o campo (ou formato estranho), nada é decidido. Não reescreve a decisão do mentor para a
  mesma mensagem. Registro: `classify … reply=yes|no` (nunca texto).
- **"esperando":** só nasce para conversa com `needsReply`; se a decisão virar "não precisa", o ativo é resolvido.
- **Correções do mentor:** "Não precisa responder" no cabeçalho da conversa e, em "Para responder", um ícone em cada
  linha → diálogo "Por que esta conversa não precisa de resposta?" (Era só agradecimento / ok / emoji; Respondi no grupo
  dele; Respondi por ligação/pessoalmente (v0.2.3; antes um só "Já respondi por outro meio"); Mensagem de grupo que não é comigo; Conversa encerrada; Outro — obrigatório) +
  texto opcional. Salvar: `user_needs = 0` para a última mensagem, sai da lista, "esperando" resolvido. Quando o Saga
  decidiu, a conversa mostra "O Saga acha que esta conversa não precisa de resposta: <motivo>" com 👍 ("O Saga acertou")
  e "Precisa sim" (devolve). Quando o mentor decidiu: "Você marcou que…" + "Precisa sim".
- **Dados:** `reply_feedback(jid, msg_id, alert_id, verdict 'reply_not_needed'|'reply_needed'|'reply_ok', app_needs,
  app_reason, app_source, reason_code, reason_text, context_text, model, created_at)`, uma por conversa e mensagem (mudar
  de ideia atualiza). `context_text` = as últimas mensagens do contato (até 8), como a IA as lê. `app_needs` guarda o que
  o Saga achava na hora (NULL = deixava na lista), para medir o acerto.
- **Aprendizado:** o prompt do `classify` leva até 4 correções recentes (primeiro da mesma conversa): "Exemplo: mensagens
  "…" → o mentor NÃO precisava responder: <motivo>" / "→ o mentor PRECISAVA responder". "Já respondi por outro meio" não
  ensina (não diz nada sobre as mensagens).
- **👍/👎 em todos os alertas:** também nos "marcados por você" (funcionam como os da IA, mas não entram no % de acerto da
  IA) e no "esperando": 👍 grava `reply_needed` (com `alert_id`; o alerta fica marcado), 👎 abre o diálogo "não precisa
  responder" (`setNeedsReply`). `rateAlert(…, 'down')` num "esperando" é recusado.
- **Qualidade dos alertas:** linha "Para responder" (30 dias): removidos por você, devolvidos (o Saga tirou e você
  devolveu), confirmados (👍) e % de acerto do Saga (o que ele achava × o que você disse; sem decisão = "precisa"). O CSV
  traz essas linhas com `tipo = para_responder`, `avaliação` (Não precisa responder / Precisa responder / Correto),
  motivo e, em `detalhe`, o que o Saga achava.
- **API:** `setNeedsReply(jid, needed, reason?)` (motivo obrigatório quando `false`) e `confirmNoReply(jid)`, com
  validação dos argumentos e checagem do remetente como as outras. Registro: `reply_feedback verdict=… reason=…`, sem
  texto nem jid.

### Atualizações que não apareciam (v0.2.3, a pedido do mentor)

Pedido: "O aviso não está aparecendo no app para atualizar para a nova versão" (ele instalava cada versão pelo GitHub).

- **Investigação (descartado com evidência):** o `resources/app-update.yml` existe no instalador publicado (extraído do
  `Saga-Setup-0.2.2.exe`: `provider: github, owner: caionorcia, repo: saga, releaseType: release`) e é gerado mesmo com
  `--publish never`; os Releases são públicos, não são rascunho nem pré-lançamento, a tag é `vX.Y.Z`, o `latest.yml` está
  em cada Release e o `releases/latest` aponta para a mais nova. O app empacotado (Electron 45, ESM) com um servidor
  imitando o GitHub mostra "Nova versão disponível" no estado da interface; a barra de status desenha o aviso.
- **Causa:** a procura só acontecia 30 s depois de o app iniciar e depois a cada 6 h. O Saga fica na bandeja (fechar a
  janela só esconde) e abre com o Windows, então abrir a janela nunca procurava; com versões publicadas a 1–2 h umas das
  outras e o mentor instalando à mão, a procura quase nunca rodava depois de uma versão nova. Uma falha (ex.: sem internet
  logo depois de ligar o PC) esperava mais 6 h, e nada disso era visível.
- **Correção:** estado puro (`updaterState.ts`: aviso + última procura, a partir dos eventos `checking-for-update`,
  `update-available`, `update-not-available`, `error`, `download-progress`, `update-downloaded`), horários acima, cada
  evento no registro de diagnóstico (`update_checking`, `update_available`, `update_not_available`, `update_error` com a
  primeira linha do erro, `update_download_progress` a cada 25%, `update_downloaded`; versão nova, erro e baixada também
  em "Eventos recentes"). `AppState.updateCheck {enabled, currentVersion, checking, lastCheckAt, lastResult, latestVersion,
  lastError}`. Configurações › Atualizações: versão instalada, última procura e resultado, "Verificar agora"
  (`checkForUpdates()`, sem argumentos, só da interface do app; devolve o resultado). O aviso também aparece no assistente
  (com o progresso do download). CI: o release confere o `app-update.yml` no `win-unpacked` e usa `gh release create --latest`.
- **Limite:** a correção só chega depois que o mentor instalar a 0.2.3 manualmente uma vez (as versões antigas continuam
  procurando só a cada 6 h).

### "Respondido no grupo" (v0.2.3, a pedido do mentor)

Pedido: o motivo "Já respondi por outro meio" estava errado: "quer dizer que eu respondi no grupo dele. Isso é o padrão."
Cada mentorado costuma ter o próprio grupo, onde o mentor responde.

- **Participantes:** `group_members(group_jid, member_jid)` (schema v9), preenchida pela consulta só de leitura
  `groupFetchAllParticipating` que já rodava pela fila (no máximo 1 vez por dia; chave nova `wa.groupMembersFetchedAt`,
  então quem atualiza busca na primeira conexão). Cada participante entra com todas as formas conhecidas (telefone e @lid,
  sem dispositivo; o par @lid→telefone é aprendido quando o participante traz os dois ou pelo mapeamento local). Quem já
  mandou mensagem no grupo (`messages.sender_jid`) também conta. O registro só leva contagens.
- **Regra:** conversa individual aguardando resposta, e **depois** da primeira mensagem sem resposta (`waitingSince`) o
  mentor escreveu (a) num grupo de que o contato participa com até `GROUP_ANSWER_MAX_MEMBERS = 10` participantes
  conhecidos (`group_sizes`, da consulta; sem linha = tamanho desconhecido = grande), ou (b) em qualquer grupo, uma
  mensagem que menciona (@) o contato ou cita uma mensagem dele (`message_targets(msg_id, target_jid)`: menções e autor
  citado das mensagens do mentor em grupos, com @lid e telefone) → não está em "Para responder", não conta em `triage.awaiting` e não
  ganha "esperando". `replyDecision = {needed: false, by: 'group', reason: 'Respondido no grupo <nome>', group: {jid,
  name, ts}}` (vale a mensagem mais recente do mentor entre os grupos). Precedência: mentor > grupo > regra de
  agradecimento/IA. Calculada na consulta (não é gravada), então some sozinha quando a espera muda.
- **Interface:** conversa: "Respondido no grupo <nome> às HH:MM" (o nome abre o grupo), 👍 (`confirmNoReply`) e "Precisa
  sim" (`setNeedsReply(jid, true)`, grava `reply_needed` com `app_source = 'group'`, ou seja, o Saga tinha tirado). Lista:
  etiqueta "respondido em <grupo>".
- **Motivos:** "Já respondi por outro meio" virou "Respondi no grupo dele" (`respondi_grupo`; as linhas `outro_meio` foram
  migradas para ele) e "Respondi por ligação/pessoalmente" (`ligacao`). Os dois não viram exemplo para a IA. CSV com os
  rótulos novos; em `detalhe`, "Saga (grupo): não precisa responder — Respondido no grupo <nome>".

### Tema escuro (v0.2.3, a pedido do mentor)

- Configurações › Tema: Automático (do Windows, padrão) / Claro / Escuro, salvo em `settings.theme` (processo principal).
  Botão sol/lua na barra de cima ("Usar o tema escuro/claro") inverte o tema que está valendo.
- CSS: todas as cores são tokens no `:root` com `light-dark()`; `color-scheme: light dark` (Automático segue
  `prefers-color-scheme`), `<html data-theme="light|dark">` força. O processo principal aplica `nativeTheme.themeSource`
  (moldura, barras de rolagem e `prefers-color-scheme`), a cor de fundo da janela, e passa o tema ao preload
  (`--saga-theme=`) para a primeira pintura sair certa. Contraste AA conferido nos dois temas (texto, selos, alertas,
  balões, avisos, nomes de quem mandou). O QR fica sempre em fundo branco com margem clara.

### Base de conhecimento do método (v0.3.0, a pedido do mentor)

- **Por quê:** as sugestões vão para mentorados e devem responder com o método do mentor, não com conhecimento genérico.
  O mentor já tem o método escrito (pacotes de skills / GPT: arquivos .md com regras, conteúdo e material interno).
- **Importar (Configurações › Base de conhecimento):** "Importar pacote / skill" (.zip, .skill ou pasta, pelo diálogo
  do sistema no processo principal; a interface só diz o tipo, nunca o caminho), "Adicionar arquivo" (.md, .txt, .docx;
  .docx lido sem dependência: é um .zip com XML; PDF fica para depois) e "Colar texto" (título + texto). Arquivo avulso e
  texto colado vão para o pacote "Arquivos avulsos" (o de mesmo nome é substituído). Reimportar um pacote (pelo nome:
  pasta raiz do .zip, nome da pasta ou do arquivo) troca tudo numa transação; o papel e o "Usar" que o mentor mudou à mão
  continuam valendo para o arquivo de mesmo caminho.
- **Segurança do .zip:** lido só em memória (nada é extraído no disco); recusa `..`, caminho absoluto, letra de unidade,
  NUL, links simbólicos, ocultos e `__MACOSX`; limites de 25 MB no arquivo, 20 MB de texto no total, 2 MB por arquivo e
  500 arquivos, conferidos também na descompactação ("zip bomb"); ignora .zip dentro do .zip e o que não for .md/.txt;
  ZIP64 não é aceito (importar a pasta). Pasta: sem seguir links, sem pastas ocultas, até 8 níveis. Repetidos (mesmo
  conteúdo) entram uma vez (fica o de caminho mais curto).
- **Papel de cada arquivo (heurística, editável):** `regras` (regras/vocabulário/checklist no nome, `INSTRUCOES*`,
  `SKILL.md` — da skill vale a `description` do cabeçalho), `conhecimento` (o resto), `interno` (o LEIA-ME/README ou as
  instruções avisam que é material interno — "material interno", "não é pra repassar", "nomes reais", "preços de um
  aluno" — ou o arquivo tem muitos nomes de pessoas, ou nomes junto com valores em dinheiro; `exemplo-*`), `desligado`
  (LEIA-ME/README/índice, pastas ou arquivos de anúncios/copies/ganchos, pastas `exemplos/`).
- **Índice:** seções por título (`#` a `####`, fora de blocos de código); seção acima de ~1.200 caracteres vira pedaços
  por parágrafo com ~150 de sobreposição. Trilha "Pacote › Arquivo (sem número) › Seção". Seções sobre o próprio
  material ("como a IA usa este arquivo", "qual arquivo abrir", índice) ficam fora. Trecho com valor em dinheiro, 3+ nomes
  de pessoas ou título que se diz interno ("interna", "bastidores", "nunca vai pro aluno") é marcado sensível: vai para a
  IA só como orientação. Tabelas `kb_packages`, `kb_files`, `kb_chunks` e o FTS5 `kb_fts` (unicode61, sem acentos);
  `analyses.sources_json` guarda o "Baseado em". Tudo local.
- **Na hora da sugestão (individual e grupo):** consulta = mensagens novas do contato (com transcrições; sem novas, as 3
  últimas dele), sem palavras vazias, com radical e alguns sinônimos de conversa ("zap" → WhatsApp, "insta" →
  Instagram, "cobrar" → preço); bm25 no FTS5; um trecho só entra com 2+ termos da consulta; até 4 trechos e ~3.000
  caracteres, no máximo 2 por arquivo e 1 interno, "conhecimento" antes de "interno", nunca "desligado" nem "regras".
  As regras viram um bloco de até 6.000 caracteres no pedido do sistema, feito de seções inteiras (nunca cortadas no
  meio): primeiro as seções de regras, postura, vocabulário/palavras, bastidor e "quando não sabe", depois as demais dos
  arquivos de regras, a `description` dos SKILL.md e as seções de tom/regra das instruções. Se a próxima seção não cabe,
  tenta a seguinte (menor); seções repetidas entre arquivos (ex.: INSTRUCOES e SKILL) entram uma vez só. Fora: checklists,
  exemplos reais, casos de sucesso, depoimentos, contas, instruções para outra IA e trechos com dinheiro ou vários nomes.
- **Instruções à IA (valem mais que as do pacote):** seguir as regras; usar os trechos para responder com precisão;
  "Conhecimento" pode ser mencionado (o conceito, a aula); "Orientação interna" só para entender, sem copiar frases nem
  citar nomes, preços, resultados, depoimentos ou falas; sem bastidor (nunca revelar outros alunos, preços de outros,
  frases literais, nem que existem arquivos ou uma base); se não estiver coberto, não inventar e dizer "vou confirmar e
  te retorno" (nunca mandar a pessoa perguntar a outra pessoa); continuar imitando o estilo do mentor (exemplos da memória
  seguem valendo).
- **Interface:** embaixo de cada sugestão, "Baseado em:" com um chip por trecho de conhecimento (arquivo › seção; a trilha
  inteira na dica); clicar abre o trecho num diálogo. Trecho interno não aparece. Na tela da base: lista por pacote com
  papel (select), tamanho, seções e "Usar"; "Usar" e "Remover" por pacote; aviso de que os trechos vão para a IA.
- **Registro:** só contagens (`kb_import`: arquivos, seções, ignorados, repetidos; `kb_used`: caracteres das regras e
  quantos trechos de cada papel). Nunca nomes de arquivo nem texto da base ou das mensagens.

### Foco (v0.3.0, a pedido do mentor)

- Botão "Foco" (ícone de alvo, `aria-pressed`) no alto da lista de conversas. Ligado, as conversas que não pedem a
  resposta do mentor (mentor falou por último, "Não precisa responder" do Saga ou do mentor, "Respondido no grupo",
  escondidas) ficam apagadas (v0.3.1: opacidade 0,28 e sem cor, selos inclusive; 0,7 ao passar o mouse ou com o
  teclado), mas na lista e clicáveis; as que pedem resposta ficam
  normais. Vale com todos os filtros e nos dois temas. Lembrado por computador (`localStorage`, com try/catch).

### Sem conversas escondidas (v0.3.0, a pedido do mentor)

- O telefone é estritamente profissional: saíram "Mostrar escondidos" e "Esconder/Mostrar" do menu ⋯ (sem o primeiro,
  esconder seria irreversível) e o método `setHidden` da interface (`SagaApi`, preload e `guards`).
- Migração v11: `contacts.hidden = 0` para todos; a lista dos que estavam escondidos vai para
  `settings_kv['migration.unhidden_jids']` e, ao iniciar, o serviço devolve à fila (`requeue`, no ritmo normal) os áudios
  deles sem transcrição (baixar, ou só transcrever se o arquivo já existe), apaga a lista e registra só contagens
  (`unhidden_requeue`). A coluna e os caminhos do núcleo que olham `hidden` continuam, inofensivos (sempre 0).

### Envio direto (v0.4.0, a pedido do mentor; era a "v2")

O mentor pediu para responder sem sair do Saga. Decisões dele: mostrar "digitando…" antes de enviar (sim); marcar como
lidas as mensagens da conversa respondida (sim, só dessa conversa); nos grupos citar a mensagem respondida, nas
individuais não citar.

- **Interface:** botão **Enviar** em cada cartão de sugestão (ao lado de Salvar/Copiar). Abre a confirmação: para quem
  (nome e número, ou o nome do grupo), nos grupos a prévia da mensagem citada ("Respondendo a …"), o texto final
  (editável) e **Enviar** / **Cancelar** (Ctrl+Enter confirma, Esc cancela). Enviar = escolher a sugestão (como
  Copiar/Salvar: grava na memória com as não escolhidas) + pôr o envio na fila. O cartão mostra o estado: "Na fila —
  envia em 42 s" (contagem regressiva, com "Cancelar envio"; "pausado" quando for o caso), "Digitando…", "Enviada ✓ às HH:MM", "Não enviada — tentar de novo", "Não enviada — aguardando confirmação"
  (expirou) e "Não sei se foi enviada — conferir" (Conferir procura na conversa; sem achar, "Enviar de novo" pede nova
  confirmação). Enquanto o envio não termina, o texto do cartão fica só leitura.
- **Configurações › Envio direto:** "Mostrar o botão Enviar nas sugestões" (ligado por padrão; desligado, o botão some
  e o que estava na fila expira) e as três opções (digitando / marcar como lida / citar nos grupos), ligadas por padrão.
- **Fila:** job `send_message` na fila única, com limitador próprio `wa_send`: intervalo sorteado de 30 a 90 s (o dobro
  no aquecimento), teto de 40 por hora e 200 por dia; o primeiro envio sai na hora se os tetos permitem. Prioridade
  acima dos áudios e alertas (cada tipo tem o seu ritmo). Só roda com a conexão `open` (o tipo fica pausado fora disso)
  e para com "Pausar tudo". Nunca tenta de novo sozinho (`NO_AUTO_RETRY`): falha, prazo estourado ou queda são
  definitivos, e o "Tentar de novo" da barra de status não inclui envios.
- **Execução (`executeSend` no `WhatsAppClient`, o único lugar que chama métodos de escrita do socket):** confere de
  novo as regras, `sendPresenceUpdate('composing', jid)` por 1,5 s + 35 ms por caractere (no máximo 8 s, mais até
  0,5 s de sorteio), `'paused'`, `sendMessage(jid, { text }, grupo ? { quoted } : undefined)`, `readMessages` com as
  chaves das mensagens do contato daquela conversa depois da última resposta do mentor, e `sendPresenceUpdate
  ('unavailable')`. Citação nos grupos: entre as mensagens do contato depois da última do mentor, a mais recente que
  menciona ou cita o mentor; senão a mais recente. A chave original de cada mensagem do contato (`remoteJid` como veio,
  `id`, `participant`) fica em `messages.wa_key_json` desde a v0.4.0; mensagens antigas usam uma chave reconstruída.
  `markOnlineOnConnect` continua `false`.
- **Depois do envio:** `sent_text` da resposta aprovada é gravado na hora; a conversa sai de "Para responder" quando a
  mensagem do mentor chega pela ingestão normal, e os alertas se resolvem como hoje.
- **Registro de diagnóstico:** uma linha por etapa (`send_queued`, `send_typing`, `send_sent`, `send_failed`,
  `send_unknown`, `send_expired`, `send_canceled`, `send_refused`) com o id do envio e do job e uma impressão (hash) da
  conversa; nunca o texto nem o jid.
- **Tabela `sends`:** um envio por resposta aprovada + impressão do texto (`idem_key` único); estados `queued`,
  `typing`, `sending`, `sent`, `failed`, `unknown`, `expired`, `canceled`; `attempt` soma 1 a cada nova confirmação
  depois de falha/expiração/desconhecido, e cada tentativa tem o seu job (`send:<id>:<tentativa>`), cujo payload leva a
  tentativa e a geração da conexão. Toda mudança de estado é condicional ao estado atual E à tentativa (um handler velho
  nunca mexe na tentativa nova). `address` (destino) e `quoted_id` (citação) ficam presos na confirmação; `msg_ids_json`
  guarda os ids de mensagem que o app gerou para cada tentativa.

#### Ajustes da revisão de segurança (v0.4.0)

- **Nunca sai depois de reconectar:** qualquer perda de conexão (estado diferente de `open`, queda, "Reconectar",
  parar o app) leva tudo o que está na fila ou no "digitando…" para `expired` ("a conexão caiu antes de enviar") e conclui
  os jobs. O job leva a geração da conexão em que foi confirmado; `executeSend` recusa uma geração diferente. Sem
  conexão aberta, a confirmação é recusada ("O WhatsApp não está conectado"). O cartão mostra "Não enviada — a conexão
  caiu. Enviar de novo?" (nova confirmação).
- **Sem envio duplicado:** prazo do job de 180 s; estourar o prazo com o pedido ao WhatsApp ainda em andamento NÃO dá o
  envio como desconhecido (fica "enviando" até o pedido terminar, `send_slow` no registro); uma nova tentativa da mesma
  resposta é recusada enquanto o pedido anterior está em andamento; numa tentativa > 1, logo antes de enviar, se a
  mensagem de uma tentativa anterior já está na conversa, marca enviada sem enviar; o sinal de prazo do job é conferido
  antes do "digitando…" e antes de enviar. Um pedido sem resposta por 10 min (conexão de pé) vira desconhecido, mas o
  reenvio continua bloqueado até o pedido terminar ou a conexão mudar. Enquanto qualquer pedido de envio estiver no ar,
  o próximo envio espera (o tipo fica "não pronto" na fila: sem vaga do limitador nem tentativa; se rodar mesmo assim,
  adia 15 s), para nunca sobrepor dois envios e manter os 30–90 s.
- **Conferência pelo id:** o app gera o id da mensagem (formato do WhatsApp Web) e passa em `sendMessage(..., {
  messageId })`; o estado desconhecido é resolvido achando uma mensagem do mentor com um desses ids (sem comparar relógio
  nem texto). O eco com esse id fica na conversa de onde a resposta saiu, mesmo vindo pelo @lid.
- **Endereço LID:** na individual, o destino (envio e "digitando…") é o `remoteJid` original da última mensagem do
  contato, sem dispositivo (@lid quando a conversa migrou, senão o telefone), escolhido na confirmação.
- **Menores:** "Pausar tudo" durante o "digitando…" expira o envio ("pausado"); a citação é exatamente a mensagem vista
  na confirmação (se sumiu, vai sem citação; sem chave original, não cita); `readMessages` só com chaves originais (nunca
  reconstruídas); `sends.error` e o registro só levam o tipo/código do erro, nunca a mensagem; "contato recente" conta
  só conteúdo (texto, áudio, mídia, figurinha); chave de idempotência de outra conversa é recusada; o diálogo não envia
  duas vezes com Ctrl+Enter repetido.

### Horário de envio e "Forçar envio" (v0.4.1, a pedido do mentor)

O mentor pediu: "configurar os dias e horários disponíveis pra mensagem, por exemplo de segunda a sexta das 09h às
18h, mas deixar uma opção na conversa chamada 'forçar envio' pra poder ignorar essa regra".

- **Configurações › Envio direto › Horário de envio:** "Só enviar nos dias e horários abaixo" (ligado por padrão) e uma
  linha por dia (Seg..Dom): liberado ou não, e um intervalo de início e fim (HH:MM, de 15 em 15 minutos; o fim pode ser
  24:00). Padrão: Seg–Sex, 09:00–18:00; Sáb e Dom sem envio. Um intervalo por dia. Fim depois do início (senão a
  tela mostra o erro e não salva; o processo principal e os guardas do IPC recusam também). Vale o fuso do computador
  (a tela mostra o nome do fuso). Salvo em `settings.sendSchedule` (JSON) e incluído na cópia de segurança (juntar não
  troca um horário já escolhido no computador; substituir troca).
- **Regra:** um envio só **executa** dentro do horário, a menos que tenha sido confirmado com "Forçar envio". O início
  vale, o fim não (09:00 pode, 18:00 não). Horário desligado = pode sempre. A conta usa as partes da data local (dia da
  semana, hora, minuto) e o construtor de data local para o próximo horário: a troca de horário de verão não quebra.
  Conferido no `prepareSend` (para a tela avisar), no `sendReply` e no `executeSend` antes do "digitando…" e de novo
  logo antes de enviar. Um envio que está na fila (ou no "digitando…") quando o horário acaba **expira** ("fora do
  horário de envio"; o cartão mostra "Não enviada — fora do horário de envio. Enviar de novo?"): nunca espera para sair
  depois, como na regra de nada automático. A varredura de 15 s também expira os da fila e avisa a barra de status
  quando o horário abre ou fecha; mudar o horário nas Configurações aplica na hora.
- **Confirmação fora do horário:** o botão Enviar continua lá. O `prepareSend` sem `forced` devolve a recusa
  `outside_hours` com `nextAllowedAt`, o resumo ("Seg–Sex, 09:00–18:00"), o próximo horário ("segunda 09:00") e o
  rascunho (para quem, citação, texto), **sem token**. O diálogo mostra "Fora do horário de envio (Seg–Sex,
  09:00–18:00). Próximo horário: segunda 09:00.", o botão principal desligado e a caixa **Forçar envio** ("envia agora
  mesmo assim, fora do horário. As outras regras continuam valendo."). Marcada, o diálogo pede um novo `prepareSend`
  com `forced: true` e o botão vira "Enviar mesmo assim". Um envio forçado segue todas as outras regras (ritmo, tetos,
  digitando, lida, citação, contato recente, conexão).
- **O token prende o `forced`:** o `SendGate` guarda `forced` junto com destino e citação; um token sem `forced` nunca
  vale fora do horário (nem se o diálogo abriu dentro dele e o horário acabou antes do clique). O `sendReply` não aceita
  `forced` (os guardas recusam o campo): só o token decide. A tabela `sends` ganha `forced` (schema v15); o
  `executeSend` só ignora o horário quando a linha é forçada.
- **"Forçar envio" no cabeçalho da conversa:** botão pequeno (aparece com o envio direto e o horário ligados; dica:
  "a confirmação desta conversa já abre com Forçar envio marcado; você ainda confirma cada envio; desliga sozinho em 30
  minutos ou ao fechar a conversa"). Só na memória da janela, nunca salvo, uma conversa de cada vez.
- **Barra de status:** com o envio direto ligado e fora do horário, um chip discreto "Fora do horário de envio" (a dica
  traz o resumo e o próximo horário); o clique abre Configurações › Envio direto › Horário de envio. Vem no
  `AppState.sendHours`.
- **Registro de diagnóstico:** `send_outside_hours` (confirmação aberta ou recusada fora do horário, envio que expirou
  por isso, com a etapa) e `send_forced` (envio forçado posto na fila fora do horário); só id do envio/job e a impressão
  da conversa, nunca texto nem jid.

### Mensagem avulsa (v0.6.0, a pedido do mentor)

O mentor pediu "uma opção pra poder enviar uma mensagem normalmente, sem precisar ser uma resposta", com um botão
"Enviar mensagem avulsa" abaixo do "Gerar sugestões mesmo assim".

- **Interface:** botão discreto (não é o principal) **Enviar mensagem avulsa**, logo abaixo de "Gerar sugestões mesmo
  assim" quando a conversa não precisa de resposta, e no fim da coluna de sugestões nos outros estados (com sugestões
  ou com erro), para estar sempre ao alcance. Só aparece com o envio direto ligado. Abre uma caixa "Mensagem avulsa"
  (editável como um cartão de sugestão; o rascunho sobrevive a trocar de tela) com **Descartar** e **Enviar**. Enviar
  abre a mesma confirmação ("Enviar mensagem avulsa"), com "Forçar envio" fora do horário. Embaixo da caixa aparece o
  mesmo estado do envio (fila, digitando, enviada, erros, conferir); enviada, **Nova mensagem avulsa** começa outra.
- **Mesmo caminho e mesma segurança das respostas:** `prepareSend({ kind: 'avulsa' })` → token de uso único preso a
  jid + texto + destino + "forçar" + **tipo** (o token de resposta não vale para a avulsa, nem o contrário) →
  `sendAvulsa({ token, jid, text, draftId })` → mesma fila `send_message`, mesmo `executeSend` (único caminho de
  escrita), ritmo de 30–90 s, tetos de 40/h e 200/dia, horário de envio, "digitando…", expiração por queda/reinício/10
  min, conferência pelo id no estado desconhecido, nada sobreposto. Também vale "responder, nunca iniciar conversa":
  só para quem mandou mensagem nos últimos 30 dias.
- **Diferenças:** nunca cita (nem em grupo; o banco recusa citação numa avulsa). Não entra na memória: nada em
  `approved_replies` (nem `sent_text`), não escolhe sugestão, não conta como avaliação; o eco da avulsa também não é
  ligado a uma resposta salva parecida (`reconcileSent`/`reconcileSaved` pulam mensagens que saíram por uma avulsa).
  Ela continua aparecendo na conversa como qualquer mensagem do mentor (como se ele tivesse digitado no celular).
- **Marcar como lida (decisão):** igual às respostas, se a opção estiver ligada: as mensagens do contato depois da
  última do mentor, só daquela conversa. Mandar mensagem numa conversa pelo celular também a deixa lida; quase sempre
  não há nada pendente quando a conversa não precisa de resposta.
- **Depois do envio:** como numa resposta, o eco chega pela ingestão normal, a conversa sai de "Para responder" e os
  alertas anteriores se resolvem. No Copiloto da Saga vai como mensagem do mentor com `sent_via_sagazap = true`.
- **Banco (schema v17):** `sends` ganha `kind` (`reply`/`avulsa`) e `reply_id` passa a ser opcional (a tabela é refeita,
  com os mesmos dados, índices e o gatilho do Copiloto; uma restrição exige resposta aprovada em `reply` e nenhuma, nem
  citação, em `avulsa`). Idempotência da avulsa: `idem_key = 'avulsa:' + conversa + id do rascunho + impressão do
  texto`; o id do rascunho é gerado pela interface quando a caixa abre, então o mesmo rascunho com o mesmo texto nunca
  vira dois envios (depois de falha/expiração, uma nova confirmação reaproveita a linha, como nas respostas).
- **Registro:** as mesmas linhas `send_*`, com " avulsa" em `send_queued`/`send_sent`; nunca texto nem jid.

### IAs gratuitas de reserva: Gemini e Mistral (v0.6.2, a pedido do mentor)

O mentor pediu que, quando a cota gratuita da Groq acabar, outras IAs gratuitas assumam sozinhas por algumas horas, e
que ele possa configurá-las no app.

- **Configurações › Chaves de acesso › IAs gratuitas de reserva (opcional):** chaves "Gemini (Google, gratuito)"
  (Google AI Studio) e "Mistral (gratuito)" (plano Experiment), cifradas com `safeStorage` como as outras, com
  Adicionar/Testar/Trocar/Remover. Sem chave, a reserva fica desligada. Aviso sempre visível: "No plano gratuito, o
  provedor pode usar as conversas enviadas para melhorar os modelos dele (…). Use só se concordar."
- **Corrente (`src/core/ai/fallback.ts`):** vale para tudo que usa a IA de conversa (sugestões, alertas/"precisa
  responder", resumo da busca). Principal como hoje; se ela terminar em 429 (`LlmRateLimitError`, depois de a Groq já
  ter trocado de modelo, ou com todos os modelos da Groq "no limite"), tenta o Gemini e depois o Mistral, só os que têm
  chave. Um 429 de uma reserva a tira da corrente até o tempo pedido (mínimo 2 min; guardado em `settings_kv`,
  `llm.fallback.limited`). Chave da reserva recusada: fora por 30 min; rede ou outro erro: passa para a próxima.
  Resposta fora do formato sobe como hoje (nova tentativa). Com o **Claude** como principal a mesma corrente vale
  (um 429 do Claude passa para as reservas); os alertas em segundo plano continuam só com a Groq como principal.
- **Gemini:** `POST …/v1beta/openai/chat/completions`, `Authorization: Bearer`, `response_format: json_object`. Modelo
  escolhido pela lista (`GET …/v1beta/openai/models`, prefixo `models/` tirado, cache de 24 h): o `gemini-X.Y-flash` de
  maior versão, senão qualquer "flash" de conversa (sem lite/imagem/tts/live); sem lista, `gemini-2.5-flash`. 404 marca
  o modelo como ruim (24 h) e escolhe outro. Espera do 429: `retry-after` ou `retryDelay` do corpo.
- **Mistral:** `POST https://api.mistral.ai/v1/chat/completions`, `mistral-small-latest` (setting opcional
  `llm.mistral.model`); modelo inexistente → `open-mistral-nemo`.
- **Quem respondeu:** o resultado traz `provider`; a análise grava `gemini`/`mistral` e a coluna de sugestões mostra
  "Gerado por: Gemini (grátis, reserva)". Custo 0 (só o Claude entra no teto de gasto).
- **Mensagem final de limite:** sem chave de reserva, sugere adicionar uma do Gemini ou do Mistral em Configurações;
  com chave, diz que as IAs gratuitas de reserva também estão no limite e voltam sozinhas.
- **Registro:** `llm_fallback` (quem respondeu), `llm_fallback_limited`, `llm_fallback_error` (só o tipo do erro),
  `gemini_model_gone`, `mistral_model_gone`; nunca chave nem texto.

### Copiloto da Saga (v0.5.0, a pedido do mentor)

O mentor pediu que o que acontece no WhatsApp profissional chegue ao Copiloto da Saga, mas só dos mentorados
cadastrados lá. O contrato com o servidor é `2026-11-26-copiloto-integration.md` (v1); aqui fica só o lado do SagaZap.

- **Configurações › Copiloto da Saga:** "Enviar para o Copiloto da Saga" (padrão: desligado), o endereço (https,
  terminando em `/functions/v1/sagazap-webhook`, sem `?`/`#`), "Gerar código" (32 bytes aleatórios em base64url,
  mostrado uma vez com Copiar; guardado com o `safeStorage` em `key.copiloto`; depois a tela só sabe "código
  configurado"), "Testar conexão" (pede o roster e diz quantos telefones vieram e quantas conversas daqui casam) e a
  linha de situação (pendentes, último envio, último erro). Ligar exige endereço e código. Desligar apaga a fila local
  (`copiloto_outbox`, `copiloto_dirty`, `copiloto_chats`) e o roster; o que já foi enviado fica no Copiloto. Nada disso
  vai na cópia de segurança.
- **Módulo `src/core/copiloto/`:** `identity.ts` (normalização: só dígitos, 10–11 dígitos ganham 55; as duas formas do
  celular BR com e sem o 9; `sha256hex("sagazap-v1:"+telefone)`; `chat.key`; ids `sz1:m:`/`a:`/`r:`/`s:`),
  `events.ts` (monta `message`, `alert`, `reply_state` e `summary` das tabelas locais) e `sync.ts` (fila e envio).
- **Só mentorados:** conversa individual entra se o telefone dela está no roster (o @lid usa o telefone que o cliente do
  WhatsApp já conhece; sem telefone, não entra). Grupo entra se algum participante (consulta de participantes + quem
  já mandou mensagem) está no roster; `chat.phones` leva só esses telefones e `sender.phone` só vai se quem mandou é
  mentorado (o nome que o grupo mostra cai no número: nesse caso vai só o pushName). O resto é descartado antes de
  virar evento.
- **O que muda vira evento (schema v16):** gatilhos do SQLite anotam em `copiloto_dirty` (só com
  `copiloto.enabled = '1'`) as mensagens novas ou com transcrição nova, alertas e avaliações, `reply_checks`,
  `reply_feedback`, análises e envios que viraram `sent`. Assim toda gravação conta (ingestão, IA, regras, mentor,
  envio) sem espalhar ganchos pelo código. A volta seguinte confere o roster, monta o evento e faz upsert em
  `copiloto_outbox` pelo id do evento: um estado mais novo troca o pendente; o mesmo estado (mesma impressão sha256 do
  JSON) não volta. Uma mensagem do mentor num grupo também refaz o "Para responder" das conversas individuais dos
  participantes mentorados ("Respondido no grupo"). Depois de aceito, o JSON sai da fila (fica a impressão por 45 dias).
- **Carga inicial:** a primeira vez que uma conversa de mentorado aparece (ao ligar, a cada roster novo, ou num grupo
  que passou a ter mentorado) entram os últimos 30 dias: mensagens, alertas (e os ativos), envios, o "Para responder" e
  o resumo.
- **Envio (processo principal, fora da fila de jobs do WhatsApp):** `fetch` com prazo de 30 s, sem seguir
  redirecionamento; uma requisição por vez (envio, roster e teste), ≥ 2 s entre elas; lotes de até 100 eventos e
  512 KB. 200: o lote todo concluído, seja qual for o status de cada um. 400: lote inválido. 413: o próximo lote tem a
  metade (um evento sozinho grande demais fica inválido). 401: para e mostra "Código do Copiloto inválido" até gerar
  outro código, trocar o endereço ou o teste passar. 429, 5xx, rede ou outra resposta: espera de 1, 2, 4… até 30 min.
  Roster ao ligar e a cada 6 h (falhou: tenta em 5 min, usando o roster anterior enquanto isso); conversas que saíram
  do roster perdem os pendentes.
- **Mapeamento:** `messages` → `message` (texto, ou a transcrição do áudio com `transcription_status`; mídia só como
  `has_media`; imagem/documento pelo rótulo `[imagem]`/`[documento: …]` sem legenda, o resto `other`;
  `sent_via_sagazap` quando um envio confirmado tem esse id); `sends` `sent` → a mensagem do mentor (mesmo id do eco);
  `alerts` + `alert_feedback` (no "esperando", o `reply_feedback` ligado a ele) → `alert`; `reply_checks` +
  `reply_feedback` → `reply_state` (`mentor`/`rule`/`ai`; motivo `respondi_grupo` ou a regra do grupo →
  `replied_in_group`; mentor falou por último → `replied`); `analyses` → `summary`.
- **Registro:** só contagens e códigos de status (`copiloto_on`, `copiloto_off`, `copiloto_code`, `copiloto_test`,
  `copiloto_roster`, `copiloto_error`; no diagnóstico `copiloto_batch`, `copiloto_queue`, `copiloto_backfill`). Nunca
  conteúdo, telefone, endereço nem o código.
- **Conferir no aparelho real:** o caminho do @lid (telefone conhecido só depois do histórico), a ordem entre o eco de
  um envio e o `sent`, o desempenho dos gatilhos numa importação grande com a integração ligada e o `safeStorage` do
  código no Windows.

### Follow-up do Copiloto (v0.7.0, contrato v1.1)

A equipe escreve o follow-up no Copiloto; o SagaZap mostra na conversa e o mentor confirma cada envio. Contrato:
adendo v1.1 de `2026-11-26-copiloto-integration.md`.

- **Busca:** `{action:"followups_pending"}` na mesma fila de 1 requisição por vez do Copiloto, ao ligar/abrir e a cada
  5 min (depois dos eventos pendentes); falha → espera crescente (1 → 30 min), 401 para tudo. Guarda em
  `copiloto_followups` (schema v18), dedupe pelo `id`.
- **Conversa:** grupo pelo `chat.key`; individual pelo hash do telefone nas duas formas do 9º dígito (@lid pelo
  telefone conhecido; duas conversas da mesma pessoa → a mais recente). Sem conversa → `failed`
  `conversa_nao_encontrada`.
- **Tela:** selo 📨 e filtro "Do Copiloto (n)" na lista; na coluna das sugestões, o cartão "Mensagem do Copiloto — por
  <autor>, <data>" com "Abrir para enviar" (caixa da mensagem avulsa preenchida, editável, até 4000 caracteres) e
  "Recusar" (motivo opcional, até 200). Nunca envia sozinho.
- **Envio:** é a mensagem avulsa, com o id do follow-up como id do rascunho: confirmação, horário/"Forçar envio",
  regra dos 30 dias, ritmo e tetos, marcar como lida, sem citação, sem memória. Um follow-up com envio na fila,
  saindo, desconhecido ou enviado não aceita outro (nem com texto editado). Envio que não saiu (falhou, expirou,
  cancelado) volta o aviso a "esperando" com o motivo. A regra dos 30 dias barrando → `failed` `fora_30_dias`.
- **Relatório:** `{action:"followup_update"}` com `sent` (texto que saiu, até 10000; `sent_at` do eco, ou da hora do
  envio se o eco não chegar em 2 min), `declined` e `failed`; até 100 por pedido, reenvio com espera crescente até o
  200. `updated`, `duplicate`, `invalid` e `cancelled` são finais; `cancelled` tira o aviso de um que não saiu (num já
  enviado, conta como confirmado). 400 conclui o lote (nunca em laço).
- **Reiniciar no meio:** a ligação está no banco (`send_id` e o id do rascunho na chave do envio); o envio
  desconhecido é conferido como sempre e o relatório sai certo. Desligar a integração apaga os follow-ups; se o
  Copiloto mandar de novo um que já saiu daqui, ele volta como enviado, nunca como oferta de envio.

### Follow-up com envio automático (v0.8.0, contrato v1.2)

O mentor aprovou: o clique "Enviar pelo SagaZap" de um administrador no Copiloto, com a janela de confirmação de lá, é a
confirmação dele. Contrato: adendo v1.2 de `2026-11-26-copiloto-integration.md`.

- **Opção:** Configurações › Copiloto da Saga › "Enviar follow-ups do Copiloto automaticamente" (desligada por padrão;
  `copiloto.autoFollowups`). Desligada, ou `auto_send: false` → v0.7.0 sem mudança (cartão e confirmação).
- **Mesmo caminho, sem tela:** `FollowupAutoSender` (`src/core/copiloto/autoSend.ts`) chama, por dentro, o mesmo
  `prepareSend({ kind: 'avulsa' })` (nunca `forced`) e gasta o token no mesmo `sendAvulsa` (id do follow-up = id do
  rascunho, mesma idempotência); daí em diante é a fila `send_message` e o `executeSend` (único caminho de escrita),
  com ritmo de 30–90 s, 40/h e 200/dia, horário de envio, 30 dias, "digitando…", marcar como lida, nunca cita,
  expiração por queda/reinício/10 min e conferência pelo id. O `sendAvulsa` da interface nunca é automático (os guardas
  recusam qualquer campo a mais). `sends.auto` (schema v19) marca o envio.
- **Conferência extra no `executeSend`** (`sendGuard`): antes do "digitando…" e logo antes de enviar, um envio
  automático só sai se a opção, a integração e o envio direto continuam ligados e o follow-up dele ainda está saindo;
  senão expira ("envio automático desligado"). Desligar a opção (ou a integração) expira na hora o que está na fila.
- **Quando sai:** dentro do horário, já; nunca nos primeiros 7 min da abertura (espera abertura + 7..25 min). Fora do
  horário, o próximo horário + 7..25 min sorteados, gravados em `copiloto_followups.auto_at` (reiniciar não sorteia de
  novo; app fechado na hora → sai depois de abrir, com as mesmas regras e ainda nunca na abertura). Um automático por
  vez, só quando nenhum envio está na fila, com a conexão aberta há 1 min, sem "Pausar tudo", e sem pôr na fila quando
  o teto do WhatsApp só libera daqui a mais de 2 min (expiraria lá). Varredura de 15 s, e a cada envio que termina.
- **Limite próprio:** 30 automáticos por dia local (contados em `sends`: saíram, saindo ou desconhecidos); o
  excedente vai para a abertura do dia seguinte + 7..25 min.
- **Nunca reenviar no escuro:** desconhecido → `auto_off` (cartão da v0.7.0 com "Conferir"; nem depois de reconectar
  ou reiniciar sai sozinho). Não chegou a sair (expirou, falhou antes do envio) → volta a esperar e tenta de novo,
  no máximo 3 vezes (`auto_attempts`), depois `auto_off`. A regra dos 30 dias barrando → `failed` `fora_30_dias`.
- **Tela:** sem "Abrir para enviar"; a linha "📨 Follow-up do Copiloto: envio automático às HH:MM" ("enviando…",
  "enviado ✓", esperando conexão/limite do dia) e "Não enviar" (= `declined` `recusado_pelo_mentor`; cancela o envio
  se ainda estiver na fila).
- **Cancelados (v1.2.1):** `cancelled_ids` do `followups_pending` tira os itens daqui a cada consulta (sem relatório;
  nunca um que já saiu ou está saindo). Antes de pôr cada automático na fila, uma consulta nova (na fila de uma
  requisição por vez do Copiloto; nenhuma vaga do limitador gasta, a fila do WhatsApp não fica parada esperando a
  rede): cancelado → não sai. Só põe na fila com o limitador livre, então o "digitando…" vem segundos depois. Falha →
  todos os automáticos esperam 5 → 10 → 20 → 30 min (gravado; zera na primeira resposta boa).
- **Só com a integração saudável:** código recusado (401) para o automático. **Só o que chegou depois de ligar a
  opção** (`copiloto.autoFollowupsAt`): o que já estava como cartão continua cartão.
- **Registro:** `copiloto_auto` e as linhas `send_*` de sempre ("automático" no `send_queued`); nunca texto nem jid.

### Grupos no Copiloto e nomes dos grupos (v0.8.1, a pedido do mentor)

Relato: as conversas individuais chegaram ao Copiloto com 30 dias de histórico, os grupos só com o que aconteceu depois
de ligar, e vários grupos sem mensagem nova nunca apareceram (o follow-up, que vai sempre ao grupo, ficava travado).
Muitos grupos antigos com assunto apareciam como "Grupo sem nome".

- **Causa (grupos):** um grupo só era conferido contra o roster no roster (ao ligar e a cada 6 h) e numa mudança dentro
  dele (`applyRoster` e `processDirty` em `src/core/copiloto/sync.ts`). Na carga inicial, muitos grupos ainda não
  casavam: os participantes vêm da consulta dos grupos (pela fila, uma vez por dia), o telefone de um @lid só existe
  na memória do cliente (`pnForLid`) e as mensagens antigas guardam o remetente como @lid. Quando a participação ficava
  conhecida depois, nada conferia o grupo de novo: com mensagem nova, a carga dele ia junto; sem mensagem nova, nunca.
  E uma carga anotada quando o grupo casava se perdia se, na hora de virar evento, ele não casasse mais (o mapa do @lid
  ainda vazio depois de reiniciar), com o grupo marcado como "carga feita".
- **Correção:** os grupos sem carga são conferidos de novo a cada 10 min e logo que a participação muda (evento
  `membership` do cliente: consulta dos grupos, `groups.upsert` com participantes, `group-participants.update`, um @lid
  que ganhou telefone). Grupo que passa a casar ganha a carga dos 30 dias na hora. Um @lid que ganha telefone grava o
  telefone como mais uma forma do participante em `group_members` (nos grupos em que ele está ou já escreveu), então
  vale depois de reiniciar. Conversa que deixa de casar antes de a carga virar evento perde a marca de "carga feita" e
  é refeita quando voltar a casar. Grupo sem mensagem nos últimos 30 dias leva a mais recente guardada aqui (seja de
  quando for), para o Copiloto saber que ele existe; nunca se inventa mensagem.
- **Grupo novo:** `groups.upsert` (grupo criado, ou o mentor entrou nele) já traz os participantes; `group-participants.update`
  acrescenta ou tira gente (sem consulta). Mensagem num grupo que apareceu depois da última consulta de todos e de que
  não se sabe quem participa → uma consulta só daquele grupo (`groupMetadata`, leitura), pela fila, com limite gravado no banco:
  no máximo 10 por hora e 40 por dia local, uma por grupo por dia e sem nova tentativa (falhou → espera a consulta de
  todos do dia). Acima do limite, o grupo espera a consulta de todos do dia seguinte. O grupo novo de um mentorado aparece no Copiloto na volta seguinte da integração depois de
  a participação ficar conhecida (segundos, até ~15 s; com o mentorado só como @lid, assim que o telefone dele ficar
  conhecido), com a mensagem do mentor e o que houver dos últimos 30 dias.
- **Reenvio único (`copiloto.groupRepairV081`):** depois da atualização, com o WhatsApp de pé há 1 min e a consulta dos
  grupos feita nesta execução (para os eventos levarem o nome; no máximo 15 min de conexão), para cada grupo que casa:
  as mensagens dos últimos 30 dias (ou a mais recente), os envios, os alertas, o "Para responder" e o resumo, com os
  mesmos ids e o mesmo formato da captura normal, de volta a pendentes mesmo já aceitos (`upsert` com `force`; uma linha
  por id, o servidor faz upsert pelo id). Contagens em `copiloto.groupRepairResult` e no registro (`copiloto_groups`),
  nunca nomes ou texto. Grupos de mentorados sem nenhuma mensagem aqui só são contados (mandar a existência deles
  pediria mudar o contrato). Ligar a integração depois da atualização marca o reenvio como feito (a carga já segue a
  regra nova).
- **Botão "Reenviar histórico dos grupos"** (Configurações › Copiloto da Saga, com a integração ligada): pede a consulta
  dos grupos de novo e faz o reenvio (sem roster ainda: assim que ele chegar). A linha "Grupos: X grupo(s) e Y
  mensagem(ns) colocados na fila para o Copiloto (Z grupo(s) sem nenhuma mensagem neste computador)" fica na tela.
- **Causa (nomes):** o assunto vindo da consulta dos grupos só era gravado se a conversa do grupo já existisse
  (`setContactName` só atualiza); senão ficava só na memória, perdida ao fechar o app, e a consulta não se repetia por
  24 h. Além disso, um job da consulta que falhasse 3 vezes ficava falho para sempre (`requeueJob` só reabria job
  concluído) e uma resposta vazia contava como feita. A consulta tinha prioridade 0 e sem horário, a última da fila.
- **Correção (nomes):** `group_subjects` (schema v20) guarda o assunto mesmo sem a conversa; a conversa do grupo nasce
  com ele. A consulta tem prioridade 15 (na frente dos downloads, atrás dos envios; mesmo ritmo do limitador), resposta
  vazia com grupos aqui não conta como feita, e um grupo sem nome visto (ou conectar com grupos sem nome) pede a
  consulta de novo, no máximo uma vez por hora, reabrindo o job falho. Nome novo de um grupo (gatilho
  `copiloto_group_name_au`) põe a mensagem mais recente dele de novo na fila, com o `chat.name` novo. Grupo de que o
  mentor saiu não volta na consulta: continua sem nome (ou com o nome personalizado).

### Histórico antigo dos grupos (v0.8.3, a pedido do mentor)

Relato: no Copiloto, a mensagem de grupo mais antiga era de 25/11, e as individuais de 27/10.

- **Causa:** a ingestão de grupos só existe desde a v0.1.5 (25/11); antes dela as mensagens `@g.us` do histórico inicial
  eram descartadas, e o WhatsApp só manda o histórico ao vincular. O reenvio da v0.8.1 só manda o que está guardado aqui.
- **Vincular de novo** (aparelho removido no celular → `logged_out` → só a sessão é apagada → "Reconectar" → QR → histórico
  completo): a ingestão é `INSERT OR IGNORE` pela id, então nada duplica e o que já estava não emite `message` (nada de
  áudio baixado ou transcrito de novo, nada de alerta, gatilho do Copiloto só nas novas); mensagens, memória, respostas
  aprovadas, configurações, fila do Copiloto e envios ficam. As de grupo dos 30 dias entram e vão ao Copiloto pela captura
  de sempre (mesmos ids `sz1:m:`). Ao abrir depois de um QR (`paired`), a consulta dos grupos roda de novo (pela fila).
  **Correção:** um vínculo novo ou histórico pedido ao celular seguram o envio automático dos follow-ups: os recebidos
  até 24 h depois (`copiloto.autoHoldUntil`, só estende) ficam para a confirmação do mentor, inclusive os que já estavam
  esperando para sair sozinhos (antes, um automático já marcado saía 1 min depois de vincular de novo). Envios na fila
  já expiravam com a queda (nunca saem depois de reconectar).
- **Buscar no celular o histórico dos grupos** (botão em Configurações › Copiloto da Saga): `fetchMessageHistory` do
  Baileys 7.0.0-rc14 (pedido PDO `HISTORY_SYNC_ON_DEMAND` ao próprio celular, o mesmo do WhatsApp Web ao rolar a
  conversa; não vai a nenhum contato) com a resposta como `messaging-history.set` `syncType` ON_DEMAND (6), gravada pela
  ingestão normal (janela de 30 dias). Grupos de mentorados com mensagem aqui e sem os 30 dias; ponto de partida = a mais
  antiga guardada (id, `fromMe`, participante, horário em ms), depois a mais antiga da resposta. Job `fetch_history`
  (limitador `wa_history`: 20–30 s, 60/h, 60/dia), que só fica pronto com a conexão aberta há 1 min, sem pedido esperando
  resposta e dentro dos limites gravados (`wa.groupHistoryLog`: 20 s entre pedidos, 60 por dia local; o estado em
  `wa.groupHistoryRun`). 50 mensagens por pedido; o grupo termina quando a resposta chega a 30 dias atrás ou vem sem nada
  anterior. Sem resposta em 60 s = perdido (quieto); 2 seguidos no grupo → desiste dele; 3 seguidos → para
  (`waiting_phone`) até clicar de novo. Nunca vira job com falha. Grupos sem mensagem nenhuma aqui não têm ponto de
  partida: só contados ("N grupo(s) precisam reconectar o aparelho"). Registro: só contagens.
- **Linha de status:** "Histórico dos grupos: mensagem mais antiga em DD/MM; X grupo(s), Y mensagem(ns) enviadas ao
  Copiloto" (eventos `sz1:m:` de grupos aceitos na fila de saída; a mais antiga pela id do evento), e a linha da busca.
- **Conferir no aparelho real:** a unidade do horário do pedido (ms, como o nome do campo do protocolo) e se o celular
  atende pedidos de grupos antigos.

### Versão 0.3.1 (a pedido do mentor)

**Foco mais forte.** "A diferença não ficou tão grande": as conversas que não pedem resposta ficam com opacidade 0,28 e
`grayscale(100%)` (avatar, texto e selos), um valor só para os dois temas (tokens `--dim-opacity` e
`--dim-hover-opacity`); ao passar o mouse, com foco do teclado ou selecionada, sobem para 0,7.

**Janela maximizada.** A janela principal abre maximizada por padrão (`maximize()` antes de `show()`, sem piscar). Se o
mentor tirar do maximizado, `settings_kv['window.state']` guarda `{ maximized, bounds }` (o tamanho normal, por
`getNormalBounds`, salvo ao maximizar/restaurar, ao mover/redimensionar com pausa de 400 ms e ao fechar). Ao abrir, o
retângulo é encaixado na tela que existe agora (a de maior área em comum; precisa mostrar ao menos 120×80; senão abre
centralizada). Abrir de novo (segunda instância, bandeja) só mostra a janela, que continua como estava.

**Sugestões só quando a conversa precisa.** "Conversas que não precisam de resposta não precisam gerar modelos de
resposta. Somente se eu solicitar." Ao abrir uma conversa que não está em "Para responder" (o mentor falou por último,
"Não precisa responder" do Saga ou do mentor, respondido no grupo), a interface chama `getAnalysis(jid, { onlyIfNeeded:
true })`: o serviço não chama a IA (resumo e sugestões são o mesmo pedido), devolve a análise guardada se ela ainda vale
para a última mensagem, senão `not_needed`. A coluna da direita mostra "Esta conversa não precisa de resposta agora." e
o botão "Gerar sugestões mesmo assim" (caminho normal, com a base de conhecimento); o resumo diz que não foi gerado. A
atualização silenciosa usa a mesma opção. Chegou mensagem do contato e a conversa voltou a precisar: gera sozinho como
antes.

**Busca geral.** "Procurar em todas as conversas e transcrições (ex.: 'quem falou sobre precificação?')".
- Índice: migração v13 cria `messages_fts` (FTS5, `unicode61 remove_diacritics 2`; colunas `body` = texto + transcrição
  e `sender` = pushName de quem mandou), `rowid = messages.rowid`, gatilhos de inserção, mudança de texto/transcrição/
  remetente e exclusão, e preenche com o que já existe. Índice `messages(ts)` para o filtro de período.
- Pergunta natural: sem acento e minúsculas; saem perguntas, verbos de "falar", artigos e preposições ("quem", "falou",
  "sobre", "qual", "quando", "alguém", "me", "de"…); ficam palavras com 3 letras ou mais (ou números); radical leve
  (tira terminações comuns: "precificação" → `"precifica"*`) e busca por prefixo; aspas = frase exata. Primeiro todas as
  palavras (AND); sem resultado, qualquer uma (OR, com aviso). Só palavras vazias: pede o assunto.
- Filtros: Todos/Individuais/Grupos, período (tudo, 30 dias, 7 dias), "Só áudios" e uma conversa. Até 300 mensagens por
  busca (bm25, o texto pesa mais que o nome), agrupadas por conversa (a mais relevante primeiro; dentro, as mais novas;
  até 20 por conversa, com o total).
- Interface: caixa "Procurar nas conversas" com lupa no alto da coluna da esquerda (Ctrl+F / Ctrl+K; Enter procura já,
  ou depois de 450 ms parado; Esc ou "Limpar" volta à lista). Os resultados ocupam o lugar da lista: nome da conversa e
  total; cada mensagem com quem mandou (grupos; "Você" nas do mentor), data/hora, "áudio" e o trecho com as palavras em
  `<mark>`, montado por intervalos calculados no núcleo (nunca HTML). Clicar abre a conversa, rola até a mensagem e a
  destaca (o mesmo mecanismo do "Ver mensagem" dos alertas). "Nenhum resultado" traz dicas.
- "Resumir com IA" (só quando o mentor clica): no máximo os 30 trechos mais relevantes, cada um com até 240 caracteres,
  vão para a IA das sugestões (Groq ou Claude, com esquema JSON próprio `{resposta, conversas}`), dentro do teto diário
  e do limitador; resposta curta em pt-BR com as conversas citadas como links. Os trechos são marcados como dados, não
  instruções.
- API: `searchMessages(query, filters)` e `summarizeSearch(query, filters)`, validadas (texto até 200 caracteres,
  filtros conhecidos) e só da interface do app. Registro: só contagens e o tempo (`search`, `search_summary`).
- Desempenho: teste com 100 mil mensagens sintéticas, cada busca abaixo de 200 ms (pula em CI).

**Cópia de segurança.** "Exportar as respostas aprendidas, para não perder se trocar de computador."
- Arquivo `Saga-copia-AAAA-MM-DD.sagabackup`: um .zip com `manifest.json` (`format: saga-backup`, `version: 1`, data,
  versão do app, cifrado ou não) e `data.json` (com SHA-256 no manifesto) ou `data.enc`. Conteúdo: respostas aprovadas
  (com texto enviado, não escolhidas e provedor), nomes personalizados e notas, avaliações de alertas e do "Para
  responder" (sem o vínculo com alertas deste computador), a base de conhecimento (pacotes, arquivos com papel e "Usar",
  trechos; o índice é refeito), configurações sem segredo (provedor, transcrição, teto, modelos, tema) e as preferências
  da lista (filtros e Foco). Nunca: chaves (cifradas pela máquina; digitar de novo), a sessão do WhatsApp (vincular de
  novo), a mídia nem a chave de download dela. Mensagens e transcrições só com "Incluir mensagens e transcrições".
- "Proteger com senha" (recomendado; 6 a 200 caracteres): AES-256-GCM com chave por scrypt (N=2¹⁵, r=8, p=1), sal e
  IV aleatórios e o cabeçalho do manifesto como dado autenticado; as contagens vão dentro da parte cifrada. Senha
  errada → "Senha incorreta"; arquivo alterado, incompleto, de outro tipo ou de versão mais nova → mensagens claras.
- Restaurar: escolher o arquivo (diálogo do sistema; o caminho nunca vem da interface) → senha → prévia com as contagens
  → "Juntar com o que já existe" (sem repetir: resposta por conversa + texto + data; avaliação de alerta por conversa,
  tipo, mensagem, veredito e data; "Para responder" por conversa + mensagem; base por pacote + caminho; nomes e notas e
  configurações só onde ainda não há) ou "Substituir" (com confirmação; apaga respostas, avaliações, nomes/notas e a
  base, nunca mensagens). Uma transação; os índices de busca (respostas, base, mensagens) são refeitos no fim.
- Cópia automática semanal: liga/desliga, pasta escolhida no diálogo (dica: uma pasta do Google Drive ou OneDrive deixa
  a cópia na nuvem), senha opcional guardada cifrada pelo Windows. O processo principal confere a cada 30 min e só grava
  com o computador parado há 2 min ou a janela escondida, no máximo uma vez por semana; guarda as 5 mais novas. "Última
  cópia" e o erro da última tentativa aparecem na tela; o registro só leva contagens e tamanhos.

## Não-objetivos (v1)

- ~~Enviar mensagens pelo app (fica para a v2).~~ Entrou na v0.4.0, sempre com confirmação explícita a cada envio
  (ver "Envio direto").
- Integração com o Claude Code ("responde o Michael") — futura, via servidor MCP
  que expõe: listar respostas aprovadas, ver resposta de um contato, enviar (também só com confirmação).
- ~~Grupos do WhatsApp.~~ Entraram na v0.1.5 a pedido do mentor (ver "Grupos").
- Rodar em servidor na nuvem / acesso pelo celular (possível v3).
- Multiusuário, login.

## Anti-objetivos (seria fracasso mesmo funcionando)

- Enviar qualquer mensagem sem a confirmação explícita do mentor para aquele envio (risco de bloqueio do número e de
  constrangimento com mentorados). Isso inclui envio em lote, envio automático ao religar ou reconectar, reenvio sem
  perguntar e puxar conversa com quem não escreveu nos últimos 30 dias.
- Mandar dados das conversas para lugares além das APIs de IA necessárias.
- Marcar mensagens como lidas ou mostrar o mentor "online" de forma diferente
  do normal por causa do app. O app se conecta sem marcar como lido e sem anunciar presença; só durante um envio
  confirmado mostra "digitando…" naquela conversa, marca como lidas as mensagens daquela conversa (opções do mentor) e
  volta a "indisponível".
- Sugestões genéricas que não soam como o mentor.

## Restrições

- **Conexão não oficial:** a API oficial do WhatsApp não lê o histórico de um
  número pessoal. Usaremos a biblioteca **Baileys** (protocolo do WhatsApp Web
  multi-dispositivo). Viola os termos do WhatsApp; risco pequeno de bloqueio,
  mitigado pelo ritmo lento e, desde a v0.4.0, por só enviar com confirmação a cada envio, só para quem escreveu nos
  últimos 30 dias, com 30–90 s entre envios e tetos por hora e por dia. O mentor está ciente.
- **Escrita no WhatsApp só por um caminho:** o job `send_message`, criado depois da confirmação do mentor (token de
  uso único do `prepareSend` para exatamente aquele jid + texto, válido por 5 min). Nenhum outro código chama métodos de
  escrita do socket; os testes verificam isso. (v0.8.3: o pedido de histórico ao próprio celular, `fetchMessageHistory`,
  só sai pelo job `fetch_history`, a pedido do mentor; não é mensagem a ninguém.)
- **Histórico:** depende do que o WhatsApp envia ao vincular o aparelho;
  normalmente cobre 30 dias, mas não é garantido. Áudios antigos podem não
  estar mais disponíveis para download — nesse caso, mostrar "áudio
  indisponível".
- **Roda localmente no Windows** do mentor, que **não usa terminal**. Tudo
  precisa funcionar com clique: instalador, ícone na área de trabalho,
  configuração por tela. Mensagens recebidas com o app fechado chegam quando
  ele reabre.
- **Custos de API:** transcrição e sugestões usam APIs pagas (centavos por
  conversa). Chaves ficam guardadas de forma criptografada (ver abaixo).
- Idioma: português do Brasil em toda a interface e nas sugestões.

## Abordagens consideradas

| Abordagem | Prós | Contras |
|---|---|---|
| **A. App local (escolhida)** | Sem custo de servidor, dados ficam no computador, mais rápido de construir | Só recebe mensagens novas com o app aberto |
| B. Servidor na nuvem | Sempre ligado, acesso pelo celular | Custo mensal, configuração, dados em servidor, precisa login |
| C. Importar exportações do WhatsApp | Zero risco de bloqueio | Manual, conversa por conversa |

Escolha: **A**, com arquitetura que permita migrar para B depois sem
reescrever (backend e frontend separados por API HTTP).

## Decisões de como construir (chamadas do Claude, corrigíveis)

- **Stack:** Node.js + TypeScript, empacotado como **app de desktop Electron**
  com instalador para Windows (`.exe`, via electron-builder). Interface em
  React (Vite), dentro da própria janela do app. Banco **SQLite** (arquivo
  local na pasta de dados do usuário). Baileys para o WhatsApp. A lógica fica
  separada da interface (um "núcleo" com API interna), para permitir migrar
  para servidor depois.
- **Por que Electron:** instala com clique duplo, cria um ícone, permite
  ficar na bandeja do Windows, já tem trava de instância única e avisa quando
  o computador vai dormir ou acorda (usado pela trava de segurança).
- **Configuração sem terminal:** na primeira abertura, um assistente pede as
  chaves das APIs (Claude e transcrição), com links de onde obter, e mostra o
  QR Code. As chaves ficam guardadas de forma criptografada pelo Windows
  (`safeStorage`), nunca em arquivo de texto. Tudo pode ser alterado numa tela
  de Configurações.
- **Áudios:** as mensagens de voz do WhatsApp (OGG/Opus) são aceitas
  diretamente pela API de transcrição, então não é preciso instalar conversor.
- **Instalador sem assinatura digital (v1):** o Windows mostra o aviso
  "O Windows protegeu o computador". O mentor clica em "Mais informações",
  depois em "Executar assim mesmo", e o guia de instalação mostra isso com
  imagens. Assinatura digital (paga) fica para depois, se incomodar.
- **Atualizações:** o app avisa quando há versão nova e baixa com um clique
  (necessário porque o WhatsApp muda e a biblioteca precisa acompanhar). Desde a v0.2.3: procura 30 s depois de abrir,
  a cada 1 h (10 min depois de uma falha), ao mostrar/focar a janela e ao voltar da suspensão (se a última procura foi há
  mais de 20 min) e em "Verificar agora" (Configurações › Atualizações). Ver "Atualizações que não apareciam (v0.2.3)".
- **Iniciar com o Windows:** opcional, desligado por padrão, em Configurações.
- **Transcrição (gratuita):** **Groq**, modelo `whisper-large-v3`, no plano
  gratuito (cadastro sem cartão). Limites do plano gratuito, a conferir no
  painel da Groq: cerca de 20 pedidos por minuto, 2.000 por dia e 28.800
  segundos de áudio por dia (cerca de 8 h). Cada pedido conta no mínimo
  10 s de áudio. A fila respeita esses limites: quando a cota do dia acaba,
  ela continua no dia seguinte, sem erro. O provedor fica isolado atrás de
  uma interface, com OpenAI Whisper (pago) como alternativa configurável.
- **Por que não o Gemini gratuito:** no plano gratuito, o Google usa o
  conteúdo enviado para melhorar os próprios produtos, e pessoas podem ler
  esse material. Não serve para conversas privadas de mentorados.
- **Resumo e sugestões, com dois provedores à escolha** (decisão do mentor):
  - **Groq gratuito (padrão ao instalar):** usa a mesma chave da
    transcrição, com um modelo de texto aberto do catálogo gratuito da Groq
    (o melhor disponível em pt-BR no momento do build).
  - **Claude (opcional, pago):** ativado nas Configurações colando uma chave
    da Anthropic. Recomendado se as sugestões gratuitas ficarem genéricas.
  - Troca de provedor com um clique nas Configurações. A memória (respostas
    salvas) é a mesma para os dois. Cada sugestão registra qual provedor a
    gerou, para comparar depois.
  - Uma chamada por conversa gera, em JSON: o resumo "o que a pessoa quer" e
    2–3 sugestões com abordagens diferentes (ex.: direta, mais acolhedora,
    com pergunta de aprofundamento). Se o JSON vier inválido, tenta uma vez
    de novo e depois mostra erro com o botão "Tentar de novo".
- **Quando gerar (chamada do Claude, para controlar custo):** os áudios são
  transcritos automaticamente. O resumo e as sugestões são gerados quando o
  mentor abre a conversa, ficam salvos no banco e só são refeitos se chegar
  mensagem nova ou se o mentor clicar em "Gerar novas". Um contador mostra o
  custo estimado acumulado.
- **Nomes dos contatos (chamada do Claude):** usa o nome do perfil do
  WhatsApp, ou o número quando não houver nome. O mentor pode renomear
  qualquer contato no app.
- **Contexto enviado à IA:** as mensagens da conversa desde a última resposta
  do mentor, mais as ~20 mensagens anteriores como contexto.

## Memória (aprendizado)

- Tabela `approved_replies`: contato, mensagens do mentorado que motivaram a
  resposta, sugestão original, texto final salvo, data.
- Na geração, o prompt inclui como exemplos "do jeito do mentor":
  1. as últimas respostas aprovadas para **o mesmo mentorado**;
  2. as respostas aprovadas mais parecidas com o assunto atual (v1: busca
     por palavras-chave no SQLite; embeddings podem vir depois);
  3. algumas respostas aprovadas recentes, de qualquer mentorado.
- Também usa, como exemplo de estilo, respostas que o mentor de fato enviou
  pelo WhatsApp no histórico importado.
- **Texto salvo e texto enviado (chamada do Claude):** ao salvar, guarda o
  texto do app. Se, nas horas seguintes, o mentor enviar ao mesmo contato uma
  mensagem parecida (porque editou de novo no WhatsApp), a memória passa a
  usar o texto que foi de fato enviado.
- Notas por mentorado (campo livre, editável) também entram no prompt —
  ex.: "está no módulo 3, quer abrir loja".

## Trava de segurança (ritmo lento e proteção contra bloqueio)

Pedido do mentor: nunca fazer ações em lote quando o computador liga de novo,
trabalhar sempre em ritmo lento e cobrir tudo o que acontece no dia a dia
(ligar, desligar, queda de energia etc.).

### Princípios

1. **Uma única porta para o WhatsApp.** Toda ação do app que vai para o
   WhatsApp (baixar áudio, buscar nome/foto, reconectar e enviar)
   passa por uma **fila única com limite de ritmo**. Nada fala com o
   WhatsApp por fora dela.
2. **Ritmo humano, com variação.** Intervalo mínimo entre ações com sorteio
   (ex.: 4–12 s entre downloads de áudio), teto por hora e por dia.
   Valores ficam em configuração, com padrões conservadores.
3. **Aquecimento ao iniciar.** Nos primeiros 15 minutos depois de ligar,
   o ritmo é ainda mais lento (metade do normal), seja qual for o tempo que
   o computador ficou desligado.
4. **Receber é passivo, buscar é controlado.** As mensagens que chegaram com
   o computador desligado são entregues pelo próprio WhatsApp ao reconectar.
   O app só grava o texto. Os áudios entram na fila e são baixados aos
   poucos, primeiro os das conversas mais recentes e "aguardando resposta".
5. **Nada é feito sozinho na volta.** Ao reiniciar, nenhuma ação pendente de
   envio é executada automaticamente (volta a "aguardando confirmação"), e nenhuma geração de sugestões em
   lote é disparada (as sugestões já são geradas só ao abrir a conversa).
6. **Invisível fora dos envios.** O app não aparece como online (`markOnlineOnConnect: false`) e não manda recibos
   de leitura nem "digitando" por conta própria. Só durante um envio confirmado: "digitando…" naquela conversa, as
   mensagens dela marcadas como lidas (opções ligadas por padrão) e depois de volta a "indisponível".
7. **Botão de pausa geral.** Um botão no topo para a fila inteira na hora.
   Um painel de status mostra a conexão, o tamanho da fila, o ritmo atual
   e a última ação.

### Situações do dia a dia e o que o app faz

| Situação | Risco | O que o app faz |
|---|---|---|
| Computador desligado por horas ou dias e ligado de novo | Rajada de downloads e de mensagens | Aquecimento lento; o WhatsApp entrega as mensagens e o app só grava. Áudios entram na fila e são baixados no ritmo, primeiro os mais recentes. Áudios de conversas fora dos 30 dias não são baixados. |
| Queda de energia ou desligamento forçado no meio do trabalho | Banco ou sessão corrompidos, tarefas pela metade | Banco SQLite em modo WAL, gravações em transação. A sessão do WhatsApp é gravada de forma atômica (arquivo temporário e depois renomeia), com cópia de segurança. Tarefas "em andamento" voltam para "pendente" ao reiniciar, sem duplicar (cada tarefa tem o id da mensagem como chave única). |
| Sessão do WhatsApp corrompida mesmo assim | Pedir QR de novo, o que refaz a sincronização inteira | Restaura a última cópia boa da sessão. Só pede QR se a cópia também falhar, e avisa antes. |
| Internet caindo e voltando várias vezes | Reconexões em rajada (padrão de robô) | Reconexão com espera crescente e variação: 10 s, 30 s, 2 min, 5 min, 15 min, até no máximo 30 min. Teto de 6 tentativas por hora. Depois disso, espera o mentor clicar em "Reconectar". |
| Notebook entra em suspensão e acorda (detectado pelo `powerMonitor`) | Mesmo efeito da queda de internet | Tratado como reconexão, com a mesma espera crescente e o aquecimento se ficou mais de 1 h fora. |
| App aberto duas vezes (clique duplo repetido) | Duas conexões no mesmo número, conflito e rajada | Trava de instância única do Electron. A segunda abertura só traz para a frente a janela que já está aberta. |
| WhatsApp desconecta o aparelho (desvinculado pelo celular, ou celular sem internet por cerca de 14 dias) | O app tentar se reconectar em loop | Ao receber "desconectado/logout", para tudo, não tenta de novo e mostra o aviso "Vincule novamente". O novo vínculo exige ação do mentor. |
| Sinal de restrição ou bloqueio vindo do WhatsApp | Agravar o bloqueio | Para a fila inteira, grava o motivo, mostra um alerta e não faz mais nada até o mentor decidir. |
| Versão do WhatsApp Web muda e a biblioteca fica desatualizada | Erros repetidos e reconexões em loop | Detecta erro de versão/protocolo, para e mostra "Atualize o app". Não fica tentando. |
| Muitos contatos novos ou fotos de perfil | Muitas consultas seguidas | Nomes e fotos só são buscados quando a conversa aparece na tela, pela fila e com cache. Sem busca em massa. |
| Primeiro uso (vínculo inicial) | Sincronização grande de histórico | O histórico vem do próprio WhatsApp (passivo). Os áudios dos 30 dias entram na fila com ritmo lento, e a tela mostra o progresso ("baixando 12 de 340 áudios"). Pode levar horas, e isso é intencional. |
| Relógio do computador errado ou mudança de fuso | Cálculo errado da janela de 30 dias e dos limites | Usa o horário das mensagens vindo do WhatsApp para a janela. Os limites de ritmo usam um relógio monotônico. |
| Disco cheio | Falhar ao gravar áudios ou a sessão | Verifica o espaço livre antes de cada download. Abaixo de 1 GB, pausa a fila e avisa. |
| Falha ou limite das APIs de IA (transcrição/Claude) | Gastos repetidos e tentativas em rajada | Até 3 tentativas com espera crescente, depois marca como "falhou" com botão "Tentar de novo". Teto de gasto diário configurável: ao atingir, pausa a IA e avisa. |
| Mentor fecha a janela ou o app no meio da fila (fechar a janela deixa o app na bandeja; "Sair" encerra) | Retomar com tudo de uma vez | A fila é salva no banco. Ao abrir, retoma no mesmo ritmo lento, com aquecimento. |

### Regras do envio de mensagens (v0.4.0; antes "regras extras para a v2")

- **Nenhum envio é automático após religar.** Envio pendente que não saiu
  antes de fechar ou cair expira e volta para "aguardando confirmação": ao abrir, os da fila e os que estavam no
  "digitando…" (ainda não tinham saído) viram `expired`; o job pendente é concluído sem rodar. Envio que espera mais de
  10 min na fila (pausa, sem conexão) também expira. Nunca sai depois de reconectar sem nova confirmação.
  Exceção (v0.8.0, só com a opção ligada): o follow-up do Copiloto marcado como automático é confirmado de novo por
  dentro, com todas as regras, depois de abrir/reconectar (conexão estável, nunca na abertura do horário); um de estado
  desconhecido nunca sai sozinho.
- Confirmação explícita a cada envio (no app; no futuro também no Claude Code): `sendReply` só aceita o token de uso
  único que o `prepareSend` emitiu para exatamente aquele jid + texto, válido por 5 min (tokens só na memória: nenhum
  vale depois de reiniciar). Os guardas do IPC validam o formato.
- Intervalo entre envios de 30 a 90 s, com sorteio (o dobro no aquecimento). Teto de 40 por hora e 200 por dia.
  "Digitando…" proporcional ao tamanho do texto (1,5 s + 35 ms/caractere, até 8 s).
- **Nunca reenviar no escuro:** se o estado de um envio ficou desconhecido
  (o app fechou ou o socket caiu com o pedido de envio em andamento, ou o WhatsApp não confirmou), ele fica `unknown`
  e o app procura na conversa a mensagem do mentor com o id que ele mesmo gerou para o envio: achou, vira
  enviada; senão mostra "Não sei se foi enviada — conferir" e só reenvia com um clique do mentor (nova confirmação).
  Também confere a cada mensagem do mentor que chega e ao abrir o app.
- **Idempotência:** uma chave por resposta aprovada + impressão do texto; um pedido repetido para um envio na fila, em
  andamento ou enviado devolve o mesmo envio.
- Só envia para quem mandou mensagem nos últimos 30 dias (responder, nunca iniciar conversa nem em massa); conferido
  no `prepareSend`, no `sendReply` e de novo na hora do envio.
- **Horário de envio (v0.4.1):** fora dos dias e horários configurados (padrão Seg–Sex, 09:00–18:00, no fuso do
  computador) só sai o envio confirmado com "Forçar envio" (preso ao token). Conferido no `prepareSend`, no `sendReply`
  e no `executeSend` antes do "digitando…" e antes de enviar; o que ainda não saiu quando o horário acaba expira, nunca
  espera para sair depois.

### Como testar a trava

- Testes automáticos da fila: ritmo, teto, aquecimento, retomada após
  "queda" (matar o processo no meio), sem duplicar e expiração de envios.
- Testes do envio: nenhuma escrita sem token confirmado (token de outro texto, outra conversa, vencido ou reutilizado),
  expiração ao reiniciar, estado desconhecido (achado e não achado na conversa), escolha da citação nos grupos, marcar
  como lida só a conversa respondida, espaçamento e tetos do limitador, pausa e cancelamento. O socket falso dos testes
  tem espiões para `sendMessage`, `sendPresenceUpdate` e `readMessages`; fora do bloco de envio, todos os métodos de
  escrita continuam proibidos.
- Build do instalador e testes em Windows feitos por GitHub Actions (máquina Windows).
- Teste manual: desligar a internet, suspender o notebook, abrir o app duas
  vezes e puxar a tomada (ou matar o processo) durante downloads.

## Dados (esboço)

- `contacts` (jid, nome, escondido — sempre 0 desde a v0.3.0, notas, é_grupo)
- `group_members` (grupo, participante: telefone e @lid), `group_sizes` (grupo, nº de participantes) e `message_targets` (mensagem do mentor, quem ela menciona ou cita) — v0.2.3
- `messages` (id, jid, de_mim, timestamp, tipo, texto, caminho_audio,
  transcricao, status_transcricao; em grupos: remetente, nome_remetente,
  menciona_mentor)
- `analyses` (jid, ultima_msg_id, resumo, sugestoes_json, criado_em; `sources_json`, o "Baseado em" — v0.3.0)
- `kb_packages`, `kb_files` (papel, papel automático e motivo, usar), `kb_chunks` (trilha, texto, sensível) e o índice
  FTS5 `kb_fts` — base de conhecimento, v0.3.0
- `messages_fts` (FTS5 de texto + transcrição + remetente, mantido por gatilhos) — busca geral, v0.3.1
- `settings_kv`: `window.state` (janela) e `backup.*` (última cópia, cópia automática) — v0.3.1
- `approved_replies` (como acima)
- `messages.wa_key_json` (chave original da mensagem do contato) e `sends` (envios confirmados: resposta, conversa,
  texto, estado, tentativa, horários, id da mensagem no WhatsApp) — v0.4.0; `kind` (resposta ou avulsa) e `reply_id`
  opcional — v0.6.0
- `jobs` (fila única: tipo, chave única, status, tentativas, próxima_execução)
- `rate_state` e `events` (histórico de ações e de desconexões, para o painel)
- Sessão do Baileys na pasta de dados do app (`%APPDATA%`), com cópia de segurança.

## Deixado para quem constrói

- Estrutura de pastas, nomes, estilo visual (inspirado no WhatsApp, limpo).
- Detalhes do prompt e formato do JSON.
- Fila/limite de concorrência para transcrição e geração.
- Tratamento de reconexão e de erros das APIs.
- Testes: lógica de memória/seleção de exemplos e parsing de mensagens
  com testes automatizados; conexão WhatsApp verificada manualmente.

## v0.4.2 — novo nome: SagaZap

O mentor batizou o app de **SagaZap** e pediu um ícone novo. Só a marca muda; quem já usa a 0.4.1 atualiza sem perder nada.

- **Marca:** `productName`/atalhos/instalador `SagaZap` (`SagaZap-Setup-<versão>.exe`, `SagaZap.exe`), título da janela,
  bandeja, assistente, Configurações, diagnóstico, guia. "SAGA" (o método da mentoria) não muda. Identificadores
  internos (`SagaService`, `window.saga`, `saga.db`, `saga.log`, `saga-media:`) continuam.
- **Ícone:** azulejo verde-azulado (as cores do app) com uma bolha de conversa branca e um raio vazado; uma variante
  mais simples para 16–32 px (bandeja, barra de tarefas). Fonte em `build/icon.svg`/`build/icon-small.svg`, gerado por
  `scripts/make-icon.mjs` (png 1024/512, .ico 16–256, favicon, ícone da bandeja). Não lembra o logo do WhatsApp.
- **Invariantes da atualização:** `appId` igual (`br.com.saga.mentoria`: mesma chave de desinstalação, o NSIS acha a
  instalação antiga e instala na mesma pasta `%LOCALAPPDATA%\Programs\Saga`; instalações novas vão para
  `…\Programs\SagaZap`). Pasta de dados fixada em `%APPDATA%\saga` (`app.setPath('userData', …)` antes de qualquer
  leitura; é a que o Electron derivava do `name` do package.json, que nunca teve `productName`): banco, sessão do
  WhatsApp, `Local State` do `safeStorage`, registros e trava de instância única ficam onde estavam. O package.json não
  ganha `productName` e o app não chama `app.setName` (teste em `tests/main/appPaths.test.ts`).
- **Atalhos e "Iniciar com o Windows":** como o `SagaZap.exe` ainda não existe na pasta, o instalador roda o
  desinstalador antigo sem `--keep-shortcuts` e ele apaga os atalhos "Saga"; o `build/installer.nsh` (`customInstall`)
  ainda apaga `Saga.lnk` que tenha sobrado, aponta um `Saga.lnk` fixado na barra de tarefas para o exe novo e reescreve
  o valor `electron.app.saga` de `HKCU\…\Run` com o caminho novo (vale mesmo quando a atualização é instalada ao sair).
  O app grava o item de login sempre com esse nome e `process.execPath` a cada início.
- **Cópias de segurança:** o arquivo novo é `SagaZap-copia-AAAA-MM-DD.sagabackup`; o rodízio da cópia automática
  reconhece os dois prefixos e ordena pela data.

