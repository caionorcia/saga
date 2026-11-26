# Saga — Assistente de respostas para mentorados (WhatsApp)

Data: 2026-11-23 · Status: aprovado

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
5. Ter um botão **Copiar** para o mentor colar a resposta no WhatsApp.

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
  escondidas) ficam apagadas (opacidade ~0,45, selos em cinza), mas na lista e clicáveis; as que pedem resposta ficam
  normais. Vale com todos os filtros e nos dois temas. Lembrado por computador (`localStorage`, com try/catch).

### Sem conversas escondidas (v0.3.0, a pedido do mentor)

- O telefone é estritamente profissional: saíram "Mostrar escondidos" e "Esconder/Mostrar" do menu ⋯ (sem o primeiro,
  esconder seria irreversível) e o método `setHidden` da interface (`SagaApi`, preload e `guards`).
- Migração v11: `contacts.hidden = 0` para todos; a lista dos que estavam escondidos vai para
  `settings_kv['migration.unhidden_jids']` e, ao iniciar, o serviço devolve à fila (`requeue`, no ritmo normal) os áudios
  deles sem transcrição (baixar, ou só transcrever se o arquivo já existe), apaga a lista e registra só contagens
  (`unhidden_requeue`). A coluna e os caminhos do núcleo que olham `hidden` continuam, inofensivos (sempre 0).

## Não-objetivos (v1)

- Enviar mensagens pelo app (fica para a v2).
- Integração com o Claude Code ("responde o Michael") — v2, via servidor MCP
  que expõe: listar respostas aprovadas, ver resposta de um contato, enviar.
- ~~Grupos do WhatsApp.~~ Entraram na v0.1.5 a pedido do mentor (ver "Grupos").
- Rodar em servidor na nuvem / acesso pelo celular (possível v3).
- Multiusuário, login.

## Anti-objetivos (seria fracasso mesmo funcionando)

- Enviar qualquer mensagem sem ação explícita do mentor (risco de bloqueio
  do número e de constrangimento com mentorados).
- Mandar dados das conversas para lugares além das APIs de IA necessárias.
- Marcar mensagens como lidas ou mostrar o mentor "online" de forma diferente
  do normal por causa do app (o app deve se conectar sem marcar como lido e
  sem anunciar presença).
- Sugestões genéricas que não soam como o mentor.

## Restrições

- **Conexão não oficial:** a API oficial do WhatsApp não lê o histórico de um
  número pessoal. Usaremos a biblioteca **Baileys** (protocolo do WhatsApp Web
  multi-dispositivo). Viola os termos do WhatsApp; risco pequeno de bloqueio,
  mitigado por só ler na v1. O mentor está ciente.
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
   WhatsApp (baixar áudio, buscar nome/foto, reconectar e, na v2, enviar)
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
   envio (v2) é executada automaticamente, e nenhuma geração de sugestões em
   lote é disparada (as sugestões já são geradas só ao abrir a conversa).
6. **Invisível.** O app não marca mensagens como lidas, não envia "digitando"
   e não aparece como online (`markOnlineOnConnect: false`, sem recibos de
   leitura).
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

### Regras extras para a v2 (envio de mensagens)

- **Nenhum envio é automático após religar.** Envio pendente que não saiu
  antes de fechar ou cair expira e volta para "aguardando confirmação".
- Confirmação explícita a cada envio (no app ou no Claude Code).
- Intervalo entre envios de 30 a 90 s, com sorteio. Teto por hora e por dia.
  "Digitando…" proporcional ao tamanho do texto.
- **Nunca reenviar no escuro:** se o estado de um envio ficou desconhecido
  (caiu no meio), o app verifica se a mensagem já aparece na conversa antes
  de oferecer reenviar, e sempre pergunta.
- Só envia para quem mandou mensagem antes (responder, nunca iniciar
  conversa em massa).

### Como testar a trava

- Testes automáticos da fila: ritmo, teto, aquecimento, retomada após
  "queda" (matar o processo no meio), sem duplicar e expiração de envios.
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
- `approved_replies` (como acima)
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
