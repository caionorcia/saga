# SagaZap → Copiloto da Saga: contrato de integração (v1)

Status: aprovado pelo mentor em 2026-11-26 (enviar tudo, incluindo grupos, só de mentorados cadastrados).

## Objetivo

O SagaZap (app Windows) envia ao Copiloto da Saga (Lovable + Supabase) o que acontece no WhatsApp profissional do mentor.
O Copiloto passa a ter, por mentorado:
- mensagens, com os áudios já transcritos;
- alertas;
- o estado de "Para responder";
- os resumos;
- as respostas enviadas.

Não são enviados:
- chaves de IA;
- a memória de estilo (respostas aprovadas);
- a base de conhecimento;
- arquivos de mídia (vai só "tem anexo");
- nada de contatos que não sejam mentorados cadastrados.

## Arquitetura

```
SagaZap (SQLite local) ──outbox──► POST https://<projeto>.supabase.co/functions/v1/sagazap-webhook
                                    Authorization: Bearer <código SagaZap>
                                    └─► service role → RPC ingest_sagazap_events (só service_role)
                                        → tabelas whatsapp_* do Copiloto
```

**Autenticação.** Um código secreto compartilhado (≥ 32 bytes aleatórios, base64url):
- O SagaZap gera o código no botão "Gerar código".
- O mentor cola o código como secret `SAGAZAP_WEBHOOK_SECRET` no Lovable Cloud.
- A comparação no servidor é em tempo constante.
- O SagaZap guarda o código com safeStorage.
- O SagaZap nunca tem a chave de serviço do Supabase.

**Logs.** Nunca há payload nem texto de mensagem em log, de nenhum lado. As falhas vão para o `monitorIntegration('sagazap-webhook')`, que só registra categorias fixas.

## Só mentorados cadastrados

1. **Roster.** `POST {action:"roster"}` devolve `{ version: 1, phones: string[] }`.
   - Cada item é `sha256hex("sagazap-v1:" + telefoneNormalizado)`.
   - Os telefones vêm de `mentorados.telefone` e `mentorados.whatsapp_segunda_cadeira`, só de mentorados ativos.
   - **Nono dígito:** para celular BR, vão as duas formas, com e sem o 9 depois do DDD. O WhatsApp de contas antigas usa `55DD8XXXXXXX` (12 dígitos), sem o 9.
   - **Normalização** (dos dois lados, igual): fica só com os dígitos. Com 10 ou 11 dígitos, ganha o prefixo 55.
2. **Filtro no SagaZap.** O SagaZap só põe na fila:
   - conversas individuais cujo telefone está no roster;
   - grupos em que algum participante está no roster.

   Ele atualiza o roster ao ativar a integração e depois a cada 6 h. Se entrar um mentorado novo, o histórico dessa conversa (até 30 dias) entra na fila.
3. **Conferência no servidor.** O servidor confere de novo cada evento, porque ele é a fonte da verdade:
   - `chat.phones` precisa resolver para exatamente 1 mentorado.
   - Se não resolver para nenhum, o evento é descartado sem gravar nada (`skipped_unmatched`).
   - Se resolver para mais de um, também é descartado (`skipped_ambiguous`).

   Em grupo, `chat.phones` traz só os telefones dos participantes que estão no roster. Telefones de quem não é mentorado nunca saem do computador.

## Envio

- O corpo é `{ version: 1, events: Event[] }`, com no máximo 100 eventos e 512 KB.
- A resposta 200 é `{ results: [{ id, status }] }`, com um resultado por evento. `status` pode ser:
  - `stored`
  - `updated`
  - `duplicate`
  - `skipped_unmatched`
  - `skipped_ambiguous`
  - `invalid`
- Como o SagaZap trata cada resposta:

| Resposta | O que o SagaZap faz |
|---|---|
| 200, qualquer status | marca o evento como concluído (não reenvia) |
| 401 | para a fila e mostra "Código do Copiloto inválido" |
| 400 | marca o lote inteiro como inválido |
| 413 | divide o lote |
| 429, 5xx ou erro de rede | nova tentativa com espera crescente (1 min → 30 min) |

- O ritmo é de 1 requisição por vez, com ≥ 2 s entre lotes. Isso é HTTPS para o Supabase e não toca no WhatsApp.
- **Carga inicial:** ao ativar, vão os últimos 30 dias das conversas filtradas. Depois disso, o envio é incremental.

## Identificadores

- `chat.key` = `sha256hex("sagazap-chat-v1:" + jid)`. É estável, e o JID não sai do computador.
- `id` de mensagem = `"sz1:m:" + sha256hex(jid + "|" + waMessageId)`, truncado em 40 hex.
- `id` de alerta = `"sz1:a:" + idLocal`.

Os ids de estado de resposta (`"sz1:r:" + chat.key`) e de resumo (`"sz1:s:" + chat.key`) são um por conversa. Um envio novo com o mesmo id **atualiza** o registro (upsert).

Uma mensagem reenviada com o mesmo id também atualiza: é o caso do áudio que ganhou transcrição.

## Eventos

`Chat` é o mesmo em todos:

```ts
type Chat = { key: string; kind: 'individual' | 'group'; name: string | null; phones: string[] /* normalizados */ }
```

### message
```ts
{ type: 'message', id, chat: Chat,
  direction: 'inbound' | 'outbound',
  sender: { phone: string | null /* só se estiver no roster */, name: string | null, is_mentor: boolean },
  message_type: 'text' | 'audio' | 'image' | 'document' | 'other',
  sent_at: string /* ISO-8601 */,
  text: string | null /* texto, ou a transcrição do áudio */,
  is_transcription: boolean,
  transcription_status: 'done' | 'failed' | 'unavailable' | 'pending' | null,
  has_media: boolean,
  sent_via_sagazap: boolean /* envio direto confirmado pelo mentor */ }
```

### alert
```ts
{ type: 'alert', id, chat: Chat,
  kind: 'urgente' | 'desanimo' | 'reuniao' | 'travado' | 'esperando',
  detail: string, message_id: string | null /* id sz1:m: */,
  source: 'ai' | 'rule' | 'user', created_at: string,
  status: 'open' | 'dismissed', dismissed_at: string | null,
  feedback: null | { verdict: 'up' | 'down', reason_code: string | null, reason_text: string | null, correct_kind: string | null } }
```

### reply_state (uma por conversa)
```ts
{ type: 'reply_state', id, chat: Chat,
  last_inbound_message_id: string | null, waiting_since: string | null,
  needs_reply: boolean | null /* null = ainda não classificado: fica na lista */,
  decided_by: 'rule' | 'ai' | 'mentor' | null, reason: string | null,
  resolution: null | 'replied' | 'replied_in_group' | 'not_needed', updated_at: string }
```

### summary (uma por conversa, a mais recente)
```ts
{ type: 'summary', id, chat: Chat, summary: string, last_message_id: string | null, generated_at: string }
```

## Mapeamento no Copiloto

O detalhamento fica na migration da integração no repositório do Copiloto.

- **message → `whatsapp_messages`**
  - O `id` vai em `whatsapp_message_id`.
  - Colunas novas:
    - `source = 'sagazap'`;
    - `chat_key`, `chat_kind` e `chat_name`;
    - `sender_name`;
    - `is_transcription` e `transcription_status`;
    - `sent_via_sagazap`.
  - O contato vem pelo telefone já casado.
- **alert → `whatsapp_actions`**
  - `action_key = id`;
  - categoria e origem em colunas novas;
  - a prioridade segue o tipo:

    | Tipo | Prioridade |
    |---|---|
    | urgente | urgent |
    | desanimo, travado | high |
    | reuniao, esperando | medium |

  - `dismissed` vira `completed` ou `dismissed`;
  - o feedback vai em jsonb.
- **reply_state** → uma ação "Responder" por conversa (`action_key = id`). Fica `pending` enquanto precisar de resposta e `completed` quando for resolvida.
- **summary → `whatsapp_conversation_summaries`**. É uma linha por mentorado e conversa, com a chave de origem numa coluna nova.

## Privacidade (LGPD)

- **Finalidade:** o acompanhamento dos mentorados pela equipe da Saga. O destino foi autorizado pelo mentor.
- **Só mentorados:** só vão dados de mentorados cadastrados, e o servidor descarta o resto sem gravar.
- **Acesso:** a leitura no Copiloto segue a RLS que já existe, `can_access_whatsapp()`.
- **Desligar:** a integração vem desligada. Ao desligar, a fila local é apagada. Os dados já enviados ficam no Copiloto, e apagá-los é decisão do mentor, lá.

---

# Adendo v1.1 — Follow-up do Copiloto enviado pelo SagaZap (2026-11-26)

Aprovado pelo mentor: a equipe escreve o follow-up no Copiloto; o SagaZap busca a fila, mostra o aviso na
conversa, abre o texto no campo de **mensagem avulsa** (editável) e o mentor confirma cada envio. Valem todas as
travas da mensagem avulsa, **inclusive a regra dos 30 dias** (o mentorado sempre já conversou com o mentor).
Follow-up não entra na memória de respostas.

Mesma URL e mesmo `Authorization: Bearer` do contrato v1. Mesmo corpo `{version: 1, ...}`.

## `{action: "followups_pending"}` → 200
```ts
{ version: 1, followups: Array<{
  id: string,                     // uuid do Copiloto
  target: { kind: 'individual', phone_hashes: string[] }   // sha256hex("sagazap-v1:" + telefone), as duas formas do 9º dígito
        | { kind: 'group', chat_key: string },             // o mesmo chat.key que o SagaZap enviou
  text: string,                   // ≤ 4000 caracteres
  author: string | null,          // nome de quem escreveu (só para mostrar)
  created_at: string              // ISO com fuso
}> }
```
- Devolve no máximo 50, mais antigos primeiro, só de mentorados ativos; marca cada um como entregue ao SagaZap
  (`delivered_at`). Pode devolver de novo um já entregue que ainda não recebeu status (o SagaZap deduplica por `id`).
- O SagaZap pergunta a cada 5 min (e ao abrir/ligar a integração), na mesma fila de 1 requisição por vez.

## `{action: "followup_update", updates: [...]}` → 200 `{results: [{id, status}]}`
```ts
updates: Array<{ id: string,
  status: 'sent' | 'declined' | 'failed',
  final_text: string | null,      // texto enviado (se o mentor editou, o editado)
  sent_at: string | null,         // ISO com fuso
  reason: string | null           // curto; ex.: 'fora_30_dias', 'conversa_nao_encontrada', 'recusado_pelo_mentor'
}>  // ≤ 100
```
- `results[].status`: `updated` | `duplicate` (já tinha status final) | `cancelled` (a equipe cancelou antes) | `invalid`.
- O SagaZap envia o status assim que o envio é confirmado (eco) ou recusado; reenvia com a mesma espera crescente.

## Cancelamento
Se a equipe cancelar no Copiloto, o próximo `followups_pending` não traz mais o item; se o SagaZap já mostrou o
aviso, o `followup_update` volta `cancelled` e o SagaZap remove o aviso (se ainda não enviou).

## Implementação no SagaZap (v0.7.0)
- A busca vem depois dos eventos pendentes da fila (no máximo alguns minutos de atraso durante a carga inicial).
- `final_text` vai com no máximo 10000 caracteres; o texto do envio é limitado a 4000 na tela.
- Resultado `invalid` (por item, ou 400 no lote) é final: não reenvia. `cancelled` de um já enviado conta como
  confirmado (o Copiloto guarda o envio).
- Envio que não saiu (falha, fora do horário, cancelado pelo mentor) não vira `failed`: o aviso volta a esperar o
  mentor, que envia de novo ou recusa.
