/**
 * v0.11.0 (Adendo v1.4): o tipo de cada grupo de que a conta participa, como o WhatsApp informa na consulta dos grupos
 * (`groupFetchAllParticipating`) e nos eventos `groups.upsert`/`groups.update` do Baileys 7: comunidade (`isCommunity`),
 * grupo de avisos da comunidade (`isCommunityAnnounce`) e a comunidade a que um grupo pertence (`linkedParent`).
 * Guardado no computador (configuração `wa.groupKinds`); nunca sai dele.
 */
import type { Repo } from '../db/repo'

export const GROUP_KINDS_SETTING = 'wa.groupKinds'

export interface GroupKind {
  /** é uma comunidade (o grupo "pai") */
  c?: 1
  /** é o grupo de avisos de uma comunidade */
  a?: 1
  /** a comunidade a que este grupo pertence */
  p?: string
}

export interface GroupKinds {
  /** epoch ms da última consulta de todos os grupos (0 = nunca) */
  at: number
  /** os grupos de que a conta participa (pela última consulta e pelos eventos depois dela) */
  groups: Record<string, GroupKind>
}

/** O que se lê de um grupo do Baileys (`GroupMetadata`) para isso. */
export interface GroupKindLike {
  id?: string | null
  isCommunity?: boolean | null
  isCommunityAnnounce?: boolean | null
  linkedParent?: string | null
}

const isGroup = (j: unknown): j is string => typeof j === 'string' && j.endsWith('@g.us')

export function loadGroupKinds(repo: Pick<Repo, 'getSetting'>): GroupKinds {
  try {
    const v = JSON.parse(repo.getSetting(GROUP_KINDS_SETTING) ?? 'null') as { at?: unknown; groups?: unknown } | null
    const groups: Record<string, GroupKind> = {}
    if (v?.groups && typeof v.groups === 'object') {
      for (const [jid, k] of Object.entries(v.groups as Record<string, unknown>)) {
        if (!isGroup(jid) || !k || typeof k !== 'object') continue
        const x = k as Record<string, unknown>
        groups[jid] = { ...(x.c === 1 ? { c: 1 as const } : {}), ...(x.a === 1 ? { a: 1 as const } : {}), ...(isGroup(x.p) ? { p: x.p } : {}) }
      }
    }
    return { at: typeof v?.at === 'number' ? v.at : 0, groups }
  } catch {
    return { at: 0, groups: {} }
  }
}

function apply(into: Record<string, GroupKind>, g: GroupKindLike): void {
  if (!isGroup(g.id)) return
  const cur: GroupKind = { ...(into[g.id] ?? {}) }
  // só o que veio no evento muda (um `groups.update` de assunto não traz os outros campos)
  if (typeof g.isCommunity === 'boolean') {
    if (g.isCommunity) cur.c = 1
    else delete cur.c
  }
  if (typeof g.isCommunityAnnounce === 'boolean') {
    if (g.isCommunityAnnounce) cur.a = 1
    else delete cur.a
  }
  if (isGroup(g.linkedParent)) cur.p = g.linkedParent
  into[g.id] = cur
}

/**
 * Guarda os tipos. `full` (a consulta de todos): troca a lista inteira (o que sumiu, a conta saiu). Senão junta (um grupo
 * novo, um evento). Devolve se mudou.
 */
export function saveGroupKinds(repo: Pick<Repo, 'getSetting' | 'setSetting'>, list: ReadonlyArray<GroupKindLike>, full: boolean, now: number): boolean {
  const cur = loadGroupKinds(repo)
  const groups: Record<string, GroupKind> = full ? {} : { ...cur.groups }
  for (const g of list) apply(groups, g)
  const next: GroupKinds = { at: full ? now : cur.at, groups }
  const raw = JSON.stringify(next)
  if (raw === JSON.stringify(cur)) return false
  repo.setSetting(GROUP_KINDS_SETTING, raw)
  return true
}

/**
 * Os grupos de onde vêm os participantes de um grupo escolhido: ele mesmo e, se for uma comunidade, o grupo de avisos
 * dela (todo membro da comunidade está nele).
 */
export function sourceGroups(jid: string, kinds: GroupKinds): string[] {
  if (kinds.groups[jid]?.c !== 1) return [jid]
  const announce = Object.entries(kinds.groups)
    .filter(([j, k]) => j !== jid && k.p === jid && k.a === 1)
    .map(([j]) => j)
    .sort()
  return [jid, ...announce]
}
