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
- **Roda localmente** no computador do mentor (Windows ou Mac — a confirmar),
  aberto no navegador em `http://localhost`. Mensagens recebidas com o app
  fechado chegam quando ele reabre.
- **Custos de API:** transcrição e sugestões usam APIs pagas (centavos por
  conversa). Chaves ficam num arquivo `.env` local.
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

- **Stack:** Node.js + TypeScript. Backend Express; frontend React (Vite);
  banco **SQLite** (arquivo local). Baileys para o WhatsApp.
- **Transcrição:** API Whisper (OpenAI, modelo de transcrição em pt-BR).
  Isolada atrás de uma interface para trocar de provedor depois.
- **Resumo e sugestões:** API do Claude (modelo configurável no `.env`).
  Uma chamada por conversa gera, em JSON: resumo "o que a pessoa quer" + 2–3
  sugestões com abordagens diferentes (ex.: direta, mais acolhedora,
  com pergunta de aprofundamento).
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

## Dados (esboço)

- `contacts` (jid, nome, escondido, notas)
- `messages` (id, jid, de_mim, timestamp, tipo, texto, caminho_audio,
  transcricao, status_transcricao)
- `analyses` (jid, ultima_msg_id, resumo, sugestoes_json, criado_em)
- `approved_replies` (como acima)
- Sessão do Baileys em pasta local (`auth/`), fora do git.

## Deixado para quem constrói

- Estrutura de pastas, nomes, estilo visual (inspirado no WhatsApp, limpo).
- Detalhes do prompt e formato do JSON.
- Fila/limite de concorrência para transcrição e geração.
- Tratamento de reconexão e de erros das APIs.
- Testes: lógica de memória/seleção de exemplos e parsing de mensagens
  com testes automatizados; conexão WhatsApp verificada manualmente.
