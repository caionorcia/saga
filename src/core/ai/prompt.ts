import type { MessageRow } from '../db/repo'
import type { Example } from '../memory/memory'

export class InvalidOutputError extends Error {
  constructor(detail: string) {
    super(`resposta da IA fora do formato esperado: ${detail}`)
    this.name = 'InvalidOutputError'
  }
}

export interface PromptInput {
  contactName: string
  notes: string | null
  newMessages: MessageRow[]
  /** até 20 mensagens anteriores às novas */
  priorMessages: MessageRow[]
  examples: Example[]
  /** conversa de grupo: cada mensagem leva o nome de quem mandou e o pedido muda (ver `SYSTEM_GROUP`) */
  isGroup?: boolean
}

const SYSTEM = `Você é o assistente de um mentor que conversa com seus mentorados pelo WhatsApp.
Sua tarefa: resumir o que o mentorado quer e sugerir respostas que o mentor possa enviar.

Regras:
- Escreva sempre em português do Brasil (pt-BR).
- Responda SOMENTE com um objeto JSON, sem texto fora dele, neste formato exato:
  {"resumo": string, "sugestoes": string[]}
- "resumo": 1 a 3 frases dizendo o que o mentorado quer ou precisa agora.
- "sugestoes": 2 ou 3 respostas prontas para enviar, cada uma com uma abordagem diferente: uma direta, uma acolhedora e, se houver terceira, uma com pergunta de aprofundamento.
- Imite o tom, o vocabulário, o tamanho e o jeito de escrever do mentor nos exemplos (se houver). Sem exemplos, use um tom natural, próximo e profissional de WhatsApp.
- Escreva como se fosse o próprio mentor, em primeira pessoa. Não invente fatos, preços, datas ou compromissos que não aparecem na conversa.
- Se o mentorado mandou áudio, use a transcrição; "[áudio indisponível]" significa que não foi possível transcrever.
- "[áudio ainda sendo transcrito]" é um áudio que ainda não foi transcrito: não adivinhe o conteúdo dele.`

const SYSTEM_GROUP = `Você é o assistente de um mentor que participa de grupos de mentoria no WhatsApp.
Sua tarefa: dizer o que pedem ao mentor neste grupo e sugerir mensagens que o mentor possa postar no grupo.

Regras:
- Escreva sempre em português do Brasil (pt-BR).
- Responda SOMENTE com um objeto JSON, sem texto fora dele, neste formato exato:
  {"resumo": string, "sugestoes": string[]}
- Cada mensagem aparece como "Nome: texto". "Mentor" é o próprio mentor. "(menciona você)" marca quem mencionou o mentor com @ ou respondeu a uma mensagem dele.
- "resumo": 1 a 3 frases sobre o que pedem ao mentor: perguntas e pedidos dirigidos a ele, menções a ele e dúvidas que ficaram sem resposta, dizendo quem pediu. Não resuma a conversa inteira do grupo. Se ninguém pediu nada ao mentor, diga isso em uma frase.
- "sugestoes": 2 ou 3 mensagens prontas para o mentor postar no grupo, cada uma com uma abordagem diferente (uma direta, uma acolhedora e, se houver terceira, uma que puxe a conversa). Quando ajudar, chame as pessoas pelo nome (ex.: "Carla, ..."), e responda a mais de uma pessoa na mesma mensagem se fizer sentido.
- Imite o tom, o vocabulário, o tamanho e o jeito de escrever do mentor nos exemplos (se houver). Sem exemplos, use um tom natural, próximo e profissional de WhatsApp.
- Escreva como se fosse o próprio mentor, em primeira pessoa. Não invente fatos, preços, datas ou compromissos que não aparecem na conversa.
- Se alguém mandou áudio, use a transcrição; "[áudio indisponível]" significa que não foi possível transcrever.
- "[áudio ainda sendo transcrito]" é um áudio que ainda não foi transcrito: não adivinhe o conteúdo dele.`

const MAX_EXAMPLE_CONTEXT = 500
const MAX_EXAMPLE_REPLY = 800

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max).trimEnd()}…` : s
}

/** Uma linha do prompt: "Mentor: …", "Mentorado: …" ou, em grupo, "Nome (menciona você): …". */
export function render(m: MessageRow, isGroup = false): string {
  const who = m.fromMe
    ? 'Mentor'
    : isGroup
      ? `${m.senderLabel?.trim() || 'Participante'}${m.mentionsMe ? ' (menciona você)' : ''}`
      : 'Mentorado'
  let body: string
  if (m.kind === 'text') body = m.text?.trim() || '[mensagem vazia]'
  else if (m.kind === 'audio') {
    if (m.transcriptStatus === null) body = '[áudio ainda sendo transcrito]'
    else body = m.transcriptStatus === 'done' && m.transcript?.trim() ? `[áudio transcrito] ${m.transcript.trim()}` : '[áudio indisponível]'
  } else body = '[mídia sem texto]'
  return `${who}: ${body}`
}

export function buildPrompt(p: PromptInput): { system: string; user: string } {
  const group = p.isGroup === true
  const line = (m: MessageRow) => render(m, group)
  const parts: string[] = []
  parts.push(group ? `Grupo: ${p.contactName}` : `Mentorado: ${p.contactName}`)
  if (p.notes?.trim()) parts.push(`Notas do mentor sobre ${group ? 'este grupo' : 'este mentorado'}:\n${p.notes.trim()}`)
  if (p.examples.length) {
    parts.push(
      'Exemplos de como o mentor costuma responder (imite este estilo):\n\n' +
        p.examples.map((e) => `Mensagem do mentorado: ${clip(e.context, MAX_EXAMPLE_CONTEXT)}\nResposta do mentor: ${clip(e.reply, MAX_EXAMPLE_REPLY)}`).join('\n\n')
    )
  }
  if (p.priorMessages.length) parts.push(`Conversa anterior (contexto):\n${p.priorMessages.map(line).join('\n')}`)
  parts.push(
    p.newMessages.length
      ? `${group ? 'Mensagens novas no grupo, depois da última mensagem do mentor' : 'Mensagens novas, ainda sem resposta'}:\n${p.newMessages.map(line).join('\n')}`
      : group
        ? 'Mensagens novas: nenhuma. O mentor falou por último no grupo; sugira como dar continuidade.'
        : 'Mensagens novas: nenhuma. O mentor falou por último; sugira como retomar a conversa ou dar continuidade.'
  )
  parts.push('Responda agora apenas com o JSON pedido.')
  return { system: group ? SYSTEM_GROUP : SYSTEM, user: parts.join('\n\n') }
}

/** JSON da resposta da IA (aceita bloco ```json``` e texto em volta); lança `InvalidOutputError`. */
export function extractJson(raw: string): unknown {
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw)
  const candidates = [raw.trim()]
  if (fence) candidates.unshift(fence[1].trim())
  const a = raw.indexOf('{')
  const b = raw.lastIndexOf('}')
  if (a >= 0 && b > a) candidates.push(raw.slice(a, b + 1))
  for (const c of candidates) {
    try {
      return JSON.parse(c)
    } catch {
      /* próximo */
    }
  }
  throw new InvalidOutputError('JSON inválido')
}

export function parseSuggestions(raw: string): { summary: string; suggestions: string[] } {
  const j = extractJson(raw) as { resumo?: unknown; sugestoes?: unknown } | null
  if (!j || typeof j !== 'object' || typeof j.resumo !== 'string' || !Array.isArray(j.sugestoes)) {
    throw new InvalidOutputError('campos "resumo" e "sugestoes" ausentes')
  }
  const suggestions = j.sugestoes
    .filter((s): s is string => typeof s === 'string')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 3)
  if (suggestions.length < 2) throw new InvalidOutputError('menos de 2 sugestões')
  return { summary: j.resumo.trim(), suggestions }
}
