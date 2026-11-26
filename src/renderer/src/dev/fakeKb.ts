/**
 * Base de conhecimento de demonstração (textos inventados) para o `window.saga` falso: a tela de configurações,
 * os "Baseado em" das sugestões e o visualizador de trechos na pré-visualização e nos testes da interface.
 */
import { KB_MANUAL_PACKAGE, type KbChunkView, type KbFilePatch, type KbImportResult, type KbPackageView, type KbRole, type KbSource } from '../../../shared/kb'

interface DemoChunk {
  heading: string
  text: string
}

interface DemoFile {
  path: string
  title: string
  role: KbRole
  reason: string
  chunks: DemoChunk[]
}

export const DEMO_KB_PACKAGE = 'Método Exemplo (demonstração)'

const DEMO_FILES: DemoFile[] = [
  {
    path: 'LEIA-ME.md',
    title: 'LEIA-ME',
    role: 'desligado',
    reason: 'Instruções de uso do pacote (não é conteúdo do método)',
    chunks: [{ heading: 'Como instalar', text: 'Copie a pasta para o seu assistente e abra de novo. Lorem ipsum dolor sit amet.' }]
  },
  {
    path: 'anuncios/roteiros-de-anuncio.md',
    title: 'Roteiros de anuncio',
    role: 'desligado',
    reason: 'Anúncios e copies: não servem para responder mentorados',
    chunks: [{ heading: 'Gancho', text: 'Três ganchos de exemplo para vídeos curtos. Consectetur adipiscing elit.' }]
  },
  {
    path: 'conhecimento/01-regras-e-tom.md',
    title: 'Regras e tom',
    role: 'regras',
    reason: 'Regras e instruções: valem para toda sugestão',
    chunks: [
      {
        heading: 'Postura nas mensagens',
        text: '- Fale com o mentorado como parceiro, em frases curtas.\n- Termine com uma pergunta ou um próximo passo claro.\n- Nunca prometa resultado com número exato.'
      },
      { heading: 'Vocabulário', text: '- "Proposta de valor", "cliente ideal", "pacote essencial", "pacote completo".' }
    ]
  },
  {
    path: 'conhecimento/02-pacotes-de-preco.md',
    title: 'Pacotes de preco',
    role: 'conhecimento',
    reason: 'Conteúdo do método',
    chunks: [
      {
        heading: 'Três pacotes, do mais completo ao essencial',
        text:
          'Monte sempre três opções: a completa, a recomendada e a essencial. A recomendada é a que o cliente mais escolhe, então ela concentra o que mais gera resultado.\n\n' +
          'Apresente da mais completa para a essencial: assim a do meio parece natural. Cobrar por hora deixa o cliente contando o relógio; o pacote fechado fala do resultado que ele vai ter.'
      },
      {
        heading: 'Como apresentar o preço',
        text: 'O preço vem depois da conversa sobre o objetivo do cliente, nunca antes. Primeiro entenda o que ele quer resolver, depois mostre as opções e pergunte qual faz mais sentido para ele.'
      }
    ]
  },
  {
    path: 'conhecimento/03-conversa-ate-a-reuniao.md',
    title: 'Conversa ate a reuniao',
    role: 'conhecimento',
    reason: 'Conteúdo do método',
    chunks: [
      {
        heading: 'Remarcar sem perder o ritmo',
        text: 'Quando o mentorado pede para mudar a reunião, ofereça duas opções de horário já na resposta e confirme o que vai ser visto. Assim a conversa não esfria.'
      },
      {
        heading: 'Quando o cliente pede só o valor',
        text: 'Agradeça o interesse, diga que o valor depende do que ele precisa e convide para uma conversa rápida com dia e horário sugeridos.'
      }
    ]
  },
  {
    path: 'conhecimento/04-perfil-e-conteudo.md',
    title: 'Perfil e conteudo',
    role: 'conhecimento',
    reason: 'Conteúdo do método',
    chunks: [
      { heading: 'Descrição do perfil', text: 'Em uma linha: para quem você trabalha e qual resultado entrega. Na segunda, a prova principal. Na terceira, o convite.' },
      { heading: 'Publicações fixadas', text: 'Fixe três: quem você é, um resultado de cliente e como contratar.' }
    ]
  },
  {
    path: 'conhecimento/05-atendimentos-internos.md',
    title: 'Atendimentos internos',
    role: 'interno',
    reason: 'O próprio pacote avisa que é material interno',
    chunks: [{ heading: 'Anotações de atendimento', text: 'Anotações da equipe sobre atendimentos (demonstração). Lorem ipsum dolor sit amet.' }]
  }
]

interface FakeFile {
  id: number
  packageId: number
  path: string
  title: string
  role: KbRole
  autoRole: KbRole
  reason: string
  enabled: boolean
  chunks: Array<DemoChunk & { id: number }>
}

interface FakePackage {
  id: number
  name: string
  kind: 'package' | 'manual'
  enabled: boolean
  importedAt: number
  skipped: number
  duplicates: number
}

const textSize = (f: FakeFile) => f.chunks.reduce((n, c) => n + new TextEncoder().encode(c.text).length, 0)
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

export interface FakeKb {
  kbList(): Promise<KbPackageView[]>
  kbImport(kind: 'archive' | 'folder'): Promise<KbImportResult>
  kbAddFile(): Promise<KbImportResult>
  kbAddText(title: string, text: string): Promise<KbImportResult>
  kbUpdateFile(fileId: number, patch: KbFilePatch): Promise<void>
  kbSetPackageEnabled(packageId: number, enabled: boolean): Promise<void>
  kbRemovePackage(packageId: number): Promise<void>
  kbGetChunk(chunkId: number): Promise<KbChunkView | null>
  /** "Baseado em" para as mensagens de um contato (busca simples por palavras, como demonstração) */
  sourcesFor(text: string): KbSource[]
}

export function createFakeKb(now: number, opts: { empty?: boolean } = {}): FakeKb {
  const packages: FakePackage[] = []
  const files: FakeFile[] = []
  let seq = 0
  const addPackage = (name: string, kind: FakePackage['kind'], list: DemoFile[], extra: Partial<FakePackage> = {}) => {
    const p: FakePackage = { id: ++seq, name, kind, enabled: true, importedAt: now - 2 * 86_400_000, skipped: 0, duplicates: 0, ...extra }
    packages.push(p)
    for (const f of list) {
      files.push({
        id: ++seq,
        packageId: p.id,
        path: f.path,
        title: f.title,
        role: f.role,
        autoRole: f.role,
        reason: f.reason,
        enabled: true,
        chunks: f.chunks.map((c) => ({ ...c, id: ++seq }))
      })
    }
    return p
  }
  if (!opts.empty) {
    addPackage(DEMO_KB_PACKAGE, 'package', DEMO_FILES, { skipped: 2, duplicates: 3 })
    addPackage(KB_MANUAL_PACKAGE, 'manual', [
      {
        path: 'Perguntas da turma.md',
        title: 'Perguntas da turma',
        role: 'conhecimento',
        reason: 'Conteúdo do método',
        chunks: [{ heading: 'Serviço recorrente', text: 'Serviço recorrente entra como pacote mensal, com o que está incluído por mês e o prazo mínimo.' }]
      }
    ])
  }

  const pkgOf = (f: FakeFile) => packages.find((p) => p.id === f.packageId)!
  const crumb = (f: FakeFile, c: DemoChunk) => `${pkgOf(f).name} › ${f.title} › ${c.heading}`
  const ok = (name: string, list: FakeFile[], replaced: boolean): KbImportResult => ({
    status: 'imported',
    packageName: name,
    files: list.length,
    sections: list.reduce((n, f) => n + f.chunks.length, 0),
    skipped: 0,
    duplicates: 0,
    replaced
  })
  const manual = () => packages.find((p) => p.kind === 'manual') ?? addPackage(KB_MANUAL_PACKAGE, 'manual', [])
  const addManual = (path: string, title: string, text: string): KbImportResult => {
    const p = manual()
    const old = files.findIndex((f) => f.packageId === p.id && f.path === path)
    if (old >= 0) files.splice(old, 1)
    const f: FakeFile = { id: ++seq, packageId: p.id, path, title, role: 'conhecimento', autoRole: 'conhecimento', reason: 'Conteúdo do método', enabled: true, chunks: [{ id: ++seq, heading: title, text }] }
    files.push(f)
    return ok(p.name, [f], old >= 0)
  }

  return {
    kbList: async () =>
      [...packages]
        .sort((a, b) => Number(a.kind === 'manual') - Number(b.kind === 'manual') || a.name.localeCompare(b.name))
        .map((p) => ({
          ...p,
          files: files
            .filter((f) => f.packageId === p.id)
            .sort((a, b) => a.path.localeCompare(b.path))
            .map((f) => ({
              id: f.id,
              path: f.path,
              title: f.title,
              role: f.role,
              autoRole: f.autoRole,
              roleReason: f.reason,
              enabled: f.enabled,
              size: textSize(f),
              sections: f.chunks.length
            }))
        })),
    kbImport: async (kind) => {
      // demonstração: reimporta o pacote de exemplo (troca o de mesmo nome)
      const old = packages.find((p) => p.name === DEMO_KB_PACKAGE)
      if (old) {
        packages.splice(packages.indexOf(old), 1)
        for (let i = files.length - 1; i >= 0; i--) if (files[i].packageId === old.id) files.splice(i, 1)
      }
      const p = addPackage(DEMO_KB_PACKAGE, 'package', DEMO_FILES, { importedAt: Date.now(), skipped: kind === 'folder' ? 0 : 2, duplicates: 3 })
      return ok(p.name, files.filter((f) => f.packageId === p.id), !!old)
    },
    kbAddFile: async () => addManual('Anotacoes.md', 'Anotacoes', 'Anotações de exemplo adicionadas na demonstração.'),
    kbAddText: async (title, text) => addManual(`${title.trim()}.md`, title.trim(), text.trim()),
    kbUpdateFile: async (id, patch) => {
      const f = files.find((x) => x.id === id)
      if (!f) throw new Error('arquivo não encontrado')
      if (patch.role) f.role = patch.role
      if (patch.enabled !== undefined) f.enabled = patch.enabled
    },
    kbSetPackageEnabled: async (id, enabled) => {
      const p = packages.find((x) => x.id === id)
      if (!p) throw new Error('pacote não encontrado')
      p.enabled = enabled
    },
    kbRemovePackage: async (id) => {
      const i = packages.findIndex((x) => x.id === id)
      if (i < 0) throw new Error('pacote não encontrado')
      packages.splice(i, 1)
      for (let j = files.length - 1; j >= 0; j--) if (files[j].packageId === id) files.splice(j, 1)
    },
    kbGetChunk: async (id) => {
      for (const f of files) {
        const c = f.chunks.find((x) => x.id === id)
        if (c) return { id, breadcrumb: crumb(f, c), text: c.text }
      }
      return null
    },
    sourcesFor: (text) => {
      const t = fold(text)
      const wanted: Array<[RegExp, string]> = [
        [/(pacote|cobr|precific|preco)/, 'Três pacotes, do mais completo ao essencial'],
        [/(recorrente)/, 'Serviço recorrente'],
        [/(reuniao|adiar|remarc)/, 'Remarcar sem perder o ritmo'],
        [/(instagram|perfil|fixad)/, 'Descrição do perfil']
      ]
      const out: KbSource[] = []
      for (const [re, heading] of wanted) {
        if (!re.test(t) || out.length >= 3) continue
        for (const f of files) {
          const c = f.chunks.find((x) => x.heading === heading)
          if (c && f.enabled && f.role === 'conhecimento' && pkgOf(f).enabled) out.push({ chunkId: c.id, breadcrumb: crumb(f, c) })
        }
      }
      return out
    }
  }
}
