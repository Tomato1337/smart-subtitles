/**
 * Renders one Anki card template the way Anki does for the parts a preview needs: sections, field
 * filters and the front side on the back. Scripts are dropped — the preview runs sandboxed.
 */

type Chunk =
  | { kind: 'text'; text: string }
  | { kind: 'var'; raw: string }
  | { kind: 'section'; name: string; inverted: boolean; body: Chunk[] }

/** Parses `{{#Field}}…{{/Field}}`, `{{^Field}}…{{/Field}}` and `{{field}}`/`{{filter:field}}`. */
function parse(tpl: string, from = 0, until?: string): { chunks: Chunk[]; next: number } {
  const chunks: Chunk[] = []
  let i = from
  while (i < tpl.length) {
    const start = tpl.indexOf('{{', i)
    if (start < 0) {
      chunks.push({ kind: 'text', text: tpl.slice(i) })
      return { chunks, next: tpl.length }
    }
    if (start > i) chunks.push({ kind: 'text', text: tpl.slice(i, start) })
    const end = tpl.indexOf('}}', start)
    if (end < 0) {
      chunks.push({ kind: 'text', text: tpl.slice(start) })
      return { chunks, next: tpl.length }
    }
    const raw = tpl.slice(start + 2, end).trim()
    i = end + 2
    if (raw.startsWith('/')) {
      if (until !== undefined && raw.slice(1).trim() === until) return { chunks, next: i }
      continue
    }
    if (raw.startsWith('#') || raw.startsWith('^')) {
      const name = raw.slice(1).trim()
      const inner = parse(tpl, i, name)
      chunks.push({ kind: 'section', name, inverted: raw.startsWith('^'), body: inner.chunks })
      i = inner.next
      continue
    }
    chunks.push({ kind: 'var', raw })
  }
  return { chunks, next: i }
}

/** `{{type:Word}}` on the front is a text box, on the back the answer next to what was typed. */
const TYPE_BOX = '<input type="text" disabled>'

function renderVar(raw: string, values: Record<string, string>, side: 'front' | 'back', frontHtml: string): string {
  if (raw === 'FrontSide') return frontHtml
  const colon = raw.indexOf(':')
  if (colon < 0) return values[raw] ?? ''
  const filter = raw.slice(0, colon).trim()
  // Anki's tts filter reads `tts en_US voices=…:Field`: the field is the last segment.
  const field = raw.slice(colon + 1).split(':').pop()!.trim()
  const value = values[field] ?? ''
  if (filter.startsWith('tts')) return value
  switch (filter) {
    case 'type':
      return side === 'front' ? TYPE_BOX : `<code>${value}</code>`
    case 'cloze':
      return side === 'front' ? '[...]' : `<b class="cloze">${value}</b>`
    case 'text':
      return value.replace(/<[^>]*>/g, '').trim()
    case 'hint':
      return value
    default:
      return value
  }
}

function render(chunks: Chunk[], values: Record<string, string>, side: 'front' | 'back', frontHtml: string): string {
  return chunks
    .map((c) => {
      if (c.kind === 'text') return c.text
      if (c.kind === 'var') return renderVar(c.raw, values, side, frontHtml)
      const filled = (values[c.name] ?? '').trim() !== ''
      return (c.inverted ? !filled : filled) ? render(c.body, values, side, frontHtml) : ''
    })
    .join('')
}

/** One side of the card: `frontHtml` fills `{{FrontSide}}` on the back. */
export function renderCard(
  tpl: string,
  values: Record<string, string>,
  side: 'front' | 'back',
  frontHtml?: string,
): string {
  const html = render(parse(tpl.replace(/<script[\s\S]*?<\/script>/gi, '')).chunks, values, side, frontHtml ?? '')
  return html.replace(/\[sound:[^\]]+\]/g, '<span class="ss-sound">🔊</span>')
}
