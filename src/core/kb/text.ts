/**
 * Texto dos arquivos da base: decodificação (.md/.txt), extração de .docx (sem dependências: é um .zip com XML)
 * e normalização usada na busca (minúsculas, sem acentos).
 */
import { KbImportError, readZip } from './zip'

/** UTF-8 (sem BOM); se não for UTF-8 válido, Latin-1 (arquivos antigos do Windows). Quebras de linha viram `\n`. */
export function decodeText(buf: Buffer): string {
  let s: string
  try {
    s = new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    s = buf.toString('latin1')
  }
  return s.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
}

/** Parece texto (sem bytes nulos no começo)? Evita indexar um binário renomeado para .md. */
export function looksLikeText(buf: Buffer): boolean {
  const n = Math.min(buf.length, 4096)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return false
  return true
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function unescapeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

/**
 * Texto de um .docx em markdown simples: um parágrafo por linha em branco, e os estilos de título
 * ("Heading 1".."Heading 4", "Título 1"…) viram `#`..`####`.
 */
export function docxToText(buf: Buffer, maxBytes: number): string {
  const { entries } = readZip(buf, (p) => p === 'word/document.xml', { fileBytes: maxBytes * 4, totalBytes: maxBytes * 4, maxFiles: 1 })
  const doc = entries[0]
  if (!doc) throw new KbImportError('Não foi possível ler o texto deste .docx.')
  const xml = doc.data.toString('utf8')
  const out: string[] = []
  for (const m of xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>|<w:p\/>/g)) {
    const p = m[0]
    const style = /<w:pStyle\s+w:val="([^"]+)"/.exec(p)?.[1] ?? ''
    const level = /^(heading|t[ií]tulo|ttulo)([1-4])$/i.exec(style.replace(/[\s_-]/g, ''))?.[2]
    let text = ''
    for (const r of p.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>/g)) {
      if (r[0] === '<w:tab/>') text += '\t'
      else if (r[0] === '<w:br/>') text += '\n'
      else text += unescapeXml(r[1])
    }
    text = text.trim()
    if (!text) continue
    out.push(level ? `${'#'.repeat(Number(level))} ${text}` : text)
  }
  return out.join('\n\n')
}

/** Minúsculas, sem acentos (como o `remove_diacritics` do índice). */
export function fold(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}
