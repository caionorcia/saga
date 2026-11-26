/**
 * Base de conhecimento (v0.3.0): tipos compartilhados entre o core, o processo principal e a interface.
 * Só tipos e constantes: nada daqui depende do Electron nem do banco.
 */

/**
 * Papel de um arquivo da base:
 * - `regras`: sempre ligado; um resumo curto das regras vai no pedido de toda sugestão;
 * - `conhecimento`: trechos buscados quando a conversa pede; aparecem em "Baseado em";
 * - `interno`: trechos buscados só como orientação (a IA não cita nomes, preços nem trechos literais); sem "Baseado em";
 * - `desligado`: não é usado.
 */
export type KbRole = 'regras' | 'conhecimento' | 'interno' | 'desligado'
export const KB_ROLES: ReadonlyArray<KbRole> = ['regras', 'conhecimento', 'interno', 'desligado']

export const KB_ROLE_LABELS: Record<KbRole, string> = {
  regras: 'Regras (sempre)',
  conhecimento: 'Conhecimento',
  interno: 'Interno (só orientação)',
  desligado: 'Desligado'
}

/** Nome do "pacote" que junta os arquivos adicionados um a um e os textos colados. */
export const KB_MANUAL_PACKAGE = 'Arquivos avulsos'

/** Limites da importação. */
export const KB_LIMITS = {
  /** soma dos textos de um pacote */
  totalBytes: 20 * 1024 * 1024,
  /** um arquivo */
  fileBytes: 2 * 1024 * 1024,
  /** quantos arquivos um pacote pode ter (os de texto) */
  files: 500,
  /** arquivo .zip/.skill no disco */
  archiveBytes: 25 * 1024 * 1024,
  /** título de um texto colado */
  titleChars: 120,
  /** texto colado */
  pasteChars: 200_000
} as const

export interface KbFileView {
  id: number
  /** caminho dentro do pacote (ex.: `conhecimento/01-aulas.md`) */
  path: string
  /** nome para exibir (sem número nem extensão) */
  title: string
  role: KbRole
  /** o papel que o Saga escolheu ao importar (o mentor pode trocar) */
  autoRole: KbRole
  /** por que o Saga escolheu esse papel, em pt-BR */
  roleReason: string
  enabled: boolean
  /** bytes do texto */
  size: number
  /** seções (títulos) encontradas */
  sections: number
}

export interface KbPackageView {
  id: number
  name: string
  /** `package` = importado de .zip/.skill/pasta; `manual` = arquivos avulsos e textos colados */
  kind: 'package' | 'manual'
  enabled: boolean
  /** epoch ms */
  importedAt: number
  /** arquivos ignorados na importação (não são texto, grandes demais, .zip dentro do .zip…) */
  skipped: number
  /** arquivos repetidos (mesmo conteúdo) que entraram uma vez só */
  duplicates: number
  files: KbFileView[]
}

export type KbImportResult =
  | {
      status: 'imported'
      packageName: string
      files: number
      sections: number
      skipped: number
      duplicates: number
      /** já existia um pacote com esse nome e ele foi substituído */
      replaced: boolean
    }
  | { status: 'canceled' }
  | { status: 'error'; message: string }

/** Um trecho mostrado em "Baseado em" (só trechos de conhecimento). */
export interface KbSource {
  chunkId: number
  /** "Pacote › Arquivo › Seção" */
  breadcrumb: string
}

export interface KbChunkView {
  id: number
  breadcrumb: string
  text: string
}

export interface KbFilePatch {
  role?: KbRole
  enabled?: boolean
}
