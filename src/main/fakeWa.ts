import { EventEmitter } from 'node:events'
import type { Repo } from '../core/db/repo'
import { loadDemo } from '../core/demo'
import type { WaClientLike } from '../core/service'
import type { ConnState } from '../core/wa/client'

/**
 * Cliente do WhatsApp falso (`SAGA_FAKE_WA=1`): sem rede, grava as conversas de demonstração (pessoas e grupos) no banco
 * e fica "conectado". Só é carregado quando a variável de ambiente existe.
 */
export class FakeWaClient extends EventEmitter implements WaClientLike {
  private status: ConnState | null = null

  constructor(private readonly repo: Repo) {
    super()
  }

  async start(): Promise<void> {
    const now = Date.now()
    for (const c of loadDemo(now)) {
      this.repo.upsertContact({ jid: c.jid, pushName: c.pushName, isGroup: c.isGroup })
      if (c.customName) this.repo.renameContact(c.jid, c.customName)
      if (c.notes) this.repo.setNotes(c.jid, c.notes)
      for (const m of c.messages) {
        this.repo.insertMessage(m)
        if (m.hasAudio) this.repo.setAudioPath(m.id, `${m.id}.ogg`)
        if (m.transcriptStatus) this.repo.setTranscript(m.id, m.transcript, m.transcriptStatus)
      }
      const last = c.messages[c.messages.length - 1]
      if (c.analysis && last) this.repo.saveAnalysis(c.jid, last.id, c.analysis.provider, c.analysis.summary, c.analysis.suggestions)
    }
    this.repo.setSetting('wa.everConnected', '1')
    this.status = 'open'
    this.emit('status', 'open')
  }

  async stop(): Promise<void> {}
  async manualReconnect(): Promise<void> {}
  onResumeFromSleep(): void {}
  getStatus(): ConnState | null {
    return this.status
  }
  isDiskLow(): boolean {
    return false
  }
  async recheckDisk(): Promise<void> {}
}
