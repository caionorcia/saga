import { useEffect, useMemo, useState } from 'react'
import { MEMBERSHIP_TEXT, membershipLine, type MembershipGroupOption, type MembershipSlotView, type MembershipView } from '../../../shared/membership'
import { Info } from './SettingsParts'

const KIND_SUFFIX: Record<MembershipGroupOption['kind'], string> = { community: ' (comunidade)', announce: '', group: '' }

/** sem acento e minúsculas, para procurar pelo nome */
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

function SlotPicker({ slot, groups, onPick }: { slot: MembershipSlotView; groups: MembershipGroupOption[]; onPick: (jid: string | null) => void }) {
  const [q, setQ] = useState('')
  const id = `mgroup-${slot.key}`
  const shown = useMemo(() => {
    const f = fold(q.trim())
    const list = f ? groups.filter((g) => fold(g.name).includes(f)) : groups
    // o escolhido fica na lista mesmo fora da busca (ou se a conta não estiver mais nele)
    if (slot.jid && !list.some((g) => g.jid === slot.jid)) {
      const cur = groups.find((g) => g.jid === slot.jid)
      return [cur ?? { jid: slot.jid, name: slot.name ?? 'grupo escolhido (sem nome aqui)', kind: 'group' as const }, ...list]
    }
    return list
  }, [q, groups, slot.jid, slot.name])
  return (
    <div className="mgroup" data-testid={`mgroup-${slot.key}`}>
      <label htmlFor={id} className="mgroup-label">
        {slot.label}
      </label>
      <div className="mgroup-pick">
        <input type="search" placeholder="Procurar…" aria-label={`Procurar grupo para ${slot.label}`} value={q} onChange={(e) => setQ(e.target.value)} />
        <select id={id} value={slot.jid ?? ''} onChange={(e) => onPick(e.target.value || null)}>
          <option value="">Não conferir</option>
          {shown.map((g) => (
            <option key={g.jid} value={g.jid}>
              {g.name}
              {KIND_SUFFIX[g.kind]}
            </option>
          ))}
        </select>
      </div>
      <p className="help mgroup-last" data-testid={`mgroup-last-${slot.key}`}>
        {slot.jid ? (slot.last ? membershipLine(slot.last) : 'Ainda não conferido') : 'Não conferido'}
      </p>
    </div>
  )
}

/**
 * v0.11.0 (Adendo v1.4): "Grupos da mentoria". O mentor escolhe qual grupo (ou comunidade) do WhatsApp é cada marca do
 * perfil no Copiloto; o SagaZap confere uma vez por dia e quando entra alguém. Só os mentorados do roster vão, em hash.
 */
export function MentorGroups({ view, enabled, onView }: { view: MembershipView; enabled: boolean; onView: (v: MembershipView) => void }) {
  const [groups, setGroups] = useState<MembershipGroupOption[]>([])
  const [msg, setMsg] = useState<{ text: string; bad: boolean } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    window.saga
      .copilotoMembershipGroups()
      .then((g) => alive && setGroups(g))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  const pick = async (key: MembershipSlotView['key'], jid: string | null) => {
    setMsg(null)
    try {
      onView(await window.saga.copilotoSetMembershipGroup(key, jid))
      setMsg({ text: 'Salvo ✓', bad: false })
    } catch {
      setMsg({ text: 'Não foi possível salvar. Tente de novo.', bad: true })
    }
  }

  const check = async () => {
    setBusy(true)
    setMsg(null)
    try {
      const r = await window.saga.copilotoCheckMembership()
      if (r.ok) {
        onView(r.view)
        setMsg({ text: MEMBERSHIP_TEXT.queued, bad: false })
      } else setMsg({ text: r.message, bad: true })
    } catch {
      setMsg({ text: 'Não foi possível conferir agora. Tente de novo.', bad: true })
    } finally {
      setBusy(false)
    }
  }

  const anyChosen = view.slots.some((s) => s.jid)
  const waiting = view.manualAvailableAt !== null && view.manualAvailableAt > Date.now()

  return (
    <section className="s-card" aria-labelledby="copiloto-mgroups-title" data-testid="copiloto-mgroups">
      <h3 id="copiloto-mgroups-title">Grupos da mentoria</h3>
      <p className="help">
        Escolha qual grupo (ou comunidade) do WhatsApp é cada um. O SagaZap confere quem participa uma vez por dia, no começo
        do horário de envio, e quando alguém entra; o Copiloto marca no perfil do mentorado.
      </p>
      <div className="mgroups">
        {view.slots.map((s) => (
          <SlotPicker key={s.key} slot={s} groups={groups} onPick={(jid) => void pick(s.key, jid)} />
        ))}
      </div>
      <div className="export-row">
        <button type="button" className="btn" disabled={busy || !enabled || !anyChosen || waiting} onClick={() => void check()}>
          Conferir agora
        </button>
      </div>
      <Info summary="O que vai para o Copiloto?">
        Só um código (hash) do telefone de quem já está na lista de mentorados do Copiloto. Ninguém mais sai do computador:
        nem nomes, nem a lista de participantes. Comunidade: vale quem está nela (o grupo de avisos dela). Quem saiu do grupo
        não é desmarcado.
      </Info>
      <p className={`s-msg ${msg?.bad ? 'field-error small' : 'ok-text small'}`} role="status" aria-live="polite">
        {msg?.text ?? (waiting ? 'Conferência pedida há pouco: dá para pedir de novo daqui a alguns minutos.' : ' ')}
      </p>
      {view.lastProblem && <p className="field-error small">{view.lastProblem}</p>}
    </section>
  )
}
