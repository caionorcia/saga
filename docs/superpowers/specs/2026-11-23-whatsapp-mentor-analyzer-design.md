# Saga — Assistente de respostas para mentorados (WhatsApp)

Data: 2026-11-23 · Status: rascunho para aprovação

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
    esconder contatos que não são mentorados (persistente).
  - **Centro:** histórico da conversa (mensagens de ambos os lados, com
    data/hora); áudios aparecem como texto transcrito (com opção de ouvir o
    original). No topo, um resumo curto: "O que a pessoa quer".
  - **Direita:** 2–3 sugestões de resposta; cada uma pode ser editada num
    campo de texto; botões **Salvar** (grava na memória) e **Copiar**
    (copia para a área de transferência). Botão para gerar novas sugestões.
- Memória de aprendizado: respostas salvas viram exemplos nas próximas
  gerações (ver "Memória").

## Não-objetivos (v1)

- Enviar mensagens pelo app (fica para a v2).
- Integração com o Claude Code ("responde o Michael") — v2, via servidor MCP
  que expõe: listar respostas aprovadas, ver resposta de um contato, enviar.
- Grupos do WhatsApp.
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
  (necessário porque o WhatsApp muda e a biblioteca precisa acompanhar).
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

- `contacts` (jid, nome, escondido, notas)
- `messages` (id, jid, de_mim, timestamp, tipo, texto, caminho_audio,
  transcricao, status_transcricao)
- `analyses` (jid, ultima_msg_id, resumo, sugestoes_json, criado_em)
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
