import { openDb } from '../../../src/core/db/db'
import { Repo } from '../../../src/core/db/repo'
import { FakeClock } from '../../../src/core/clock'
import type { Cipher } from '../../../src/core/settings'
import type { NormalizedMessage } from '../../../src/core/types'
import { rosterHash } from '../../../src/core/copiloto/identity'

/** Números fictícios (DDD 47 e 11), nenhum é de alguém. */
export const NOW = 1_764_000_000_000
export const MIN = 60_000
export const DAY = 24 * 60 * MIN
export const ANA_PHONE = '5547999998888'
export const ANA = `${ANA_PHONE}@s.whatsapp.net`
/** mentorado com conta antiga do WhatsApp: 12 dígitos, sem o 9 */
export const OLD_PHONE = '554788887777'
export const OLD = `${OLD_PHONE}@s.whatsapp.net`
/** não é mentorado */
export const BIA_PHONE = '5511988887777'
export const BIA = `${BIA_PHONE}@s.whatsapp.net`
export const CAIO_PHONE = '5511977776666'
export const CAIO = `${CAIO_PHONE}@s.whatsapp.net`
export const CAIO_LID = '123456789012345@lid'
export const G_ANA = '120363000000000001@g.us'
export const G_BIA = '120363000000000002@g.us'
export const WEBHOOK = 'https://exemplo.supabase.co/functions/v1/sagazap-webhook'

/** O roster que o servidor manda: os telefones dos mentorados nas duas formas (com e sem o 9). */
export const ROSTER_PHONES = ['5547999998888', '554799998888', '5547988887777', '554788887777']
export const rosterOf = (phones: string[]) => phones.map(rosterHash)

export const fakeCipher: Cipher = {
  isAvailable: () => true,
  encrypt: (s) => Buffer.from(`enc:${s}`),
  decrypt: (b) => {
    const s = b.toString()
    if (!s.startsWith('enc:')) throw new Error('bad')
    return s.slice(4)
  }
}

export function setup() {
  const clock = new FakeClock(NOW)
  const repo = new Repo(openDb(':memory:'), clock)
  let seq = 0
  const add = (jid: string, o: Partial<NormalizedMessage> & { minutesAgo?: number } = {}) => {
    const isGroup = jid.endsWith('@g.us')
    repo.upsertContact({ jid, isGroup })
    const m: NormalizedMessage = {
      id: `m${++seq}`,
      jid,
      fromMe: false,
      kind: 'text',
      text: 'texto de exemplo',
      mediaKeyJson: null,
      durationSec: null,
      ...(isGroup ? { isGroup: true } : {}),
      ...o,
      ts: clock.now() - (o.minutesAgo ?? 1) * MIN
    }
    repo.insertMessage(m)
    return m
  }
  return { clock, repo, add }
}
