/** Pacotes sintéticos para os testes da base de conhecimento (textos inventados) e um gravador mínimo de .zip. */
import { crc32, deflateRawSync } from 'node:zlib'

export interface ZipFileSpec {
  name: string
  data: string | Buffer
  /** 0 = sem compressão; 8 = deflate (padrão) */
  method?: 0 | 8
  /** tamanho declarado (para simular um .zip mentiroso) */
  fakeSize?: number
  /** marca como link simbólico (Unix) */
  symlink?: boolean
}

/** Monta um .zip em memória (sem ZIP64). */
export function makeZip(files: ZipFileSpec[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const f of files) {
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8')
    const method = f.method ?? 8
    const body = method === 8 ? deflateRawSync(raw) : raw
    const name = Buffer.from(f.name, 'utf8')
    const crc = crc32(raw)
    const size = f.fakeSize ?? raw.length
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x800, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(size, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, body)
    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014b50, 0)
    cen.writeUInt16LE(f.symlink ? (3 << 8) | 20 : 20, 4)
    cen.writeUInt16LE(20, 6)
    cen.writeUInt16LE(0x800, 8)
    cen.writeUInt16LE(method, 10)
    cen.writeUInt32LE(crc, 16)
    cen.writeUInt32LE(body.length, 20)
    cen.writeUInt32LE(size, 24)
    cen.writeUInt16LE(name.length, 28)
    cen.writeUInt32LE(f.symlink ? (0o120777 << 16) >>> 0 : 0, 38)
    cen.writeUInt32LE(offset, 42)
    centrals.push(cen, name)
    offset += local.length + name.length + body.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, eocd])
}

export const RULES_MD = `# Regras e tom do método

## Postura nas mensagens
- Fale em frases curtas, como parceiro do mentorado.
- Termine sempre com uma pergunta ou um próximo passo.

## Vocabulário
- "Proposta de valor", "cliente ideal", "pacote essencial".

## Checklist final
- [ ] Revisou a ortografia?
- [ ] Conferiu os anexos?
`

export const PRICES_MD = `# Pacotes de preço

## Três pacotes
Lorem ipsum: monte sempre três pacotes, do mais completo ao essencial. O pacote do meio é o recomendado e concentra o que mais gera resultado para o cliente.

## Como apresentar o preço
O preço vem depois da conversa sobre o objetivo. Dolor sit amet: primeiro entenda o que o cliente quer resolver, depois mostre os pacotes.
`

export const MEETING_MD = `# Da conversa à reunião

## Convite para a reunião
Quando o cliente pede só o valor, agradeça e convide para uma reunião curta com dia e horário sugeridos. Consectetur adipiscing elit.

## Depois da reunião
Mande um resumo em até um dia. Sed do eiusmod tempor incididunt ut labore.
`

/** Material "interno": muitos nomes de pessoas inventados e valores. */
export const INTERNAL_MD = `# Anotações de atendimentos

Na conversa com a Joana Prado ficou combinado o pacote de R$ 4.500. O Breno Matos pediu R$ 2.000 e a Lia Torres fechou por R$ 3.100.
Também falaram com a Carla Neves, o Diogo Ramos, a Elisa Faria, o Fábio Lemos, a Gabi Rocha, o Heitor Sales e a Íris Duarte.
Ana Lima, Bruno Costa e Caio Souza ficaram para a próxima semana.
`

export const README_MD = `# Leia-me do pacote

Como instalar: copie a pasta para o seu assistente.

## Avisos
- \`conhecimento/05-bastidores.md\` tem trechos de atendimentos reais. É material interno da equipe.
`

/** Pacote completo: pasta raiz única, repetidos, um .zip dentro, uma imagem e um aviso de interno. */
export function demoPackageZip(): Buffer {
  return makeZip([
    { name: 'Metodo Exemplo/LEIA-ME.md', data: README_MD },
    { name: 'Metodo Exemplo/conhecimento/01-regras-e-tom.md', data: RULES_MD },
    { name: 'Metodo Exemplo/conhecimento/02-pacotes-de-preco.md', data: PRICES_MD },
    { name: 'Metodo Exemplo/conhecimento/03-conversa-ate-a-reuniao.md', data: MEETING_MD },
    { name: 'Metodo Exemplo/conhecimento/05-bastidores.md', data: '# Bastidores\n\nLorem ipsum interno, com anotações da equipe sobre a turma.\n' },
    { name: 'Metodo Exemplo/skills/metodo/references/02-pacotes-de-preco.md', data: PRICES_MD },
    { name: 'Metodo Exemplo/skills/metodo/SKILL.md', data: '---\nname: metodo\ndescription: Atende mentorados no método exemplo, com pacotes e convite para reunião.\n---\n\n# Método\n\nLeia as referências.\n' },
    { name: 'Metodo Exemplo/anuncios/ganchos.md', data: '# Ganchos\n\nTrês ganchos de anúncio para vídeos curtos, lorem ipsum.\n' },
    { name: 'Metodo Exemplo/atendimentos.md', data: INTERNAL_MD },
    { name: 'Metodo Exemplo/copia.zip', data: Buffer.from('PK\u0003\u0004nao-e-texto') },
    { name: 'Metodo Exemplo/capa.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]) }
  ])
}
