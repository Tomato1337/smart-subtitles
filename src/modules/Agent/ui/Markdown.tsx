import { memo } from 'react'
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'
import { Icon } from '@/common/ui/Icon'

type Props = {
  text: string
  /** Start time label of a cue (`1:23`), null if the film has no such cue. */
  cueTime: (cueIdx: number) => string | null
  cueText: (cueIdx: number) => string
  onCue: (cueIdx: number) => void
}

/** `[229]` outside code → `[229](cue:229)`, so cue references become seek buttons. */
export function linkCues(md: string): string {
  return md
    .split(/(```[\s\S]*?```|`[^`\n]*`)/)
    .map((part, i) => (i % 2 ? part : part.replace(/\[(\d{1,5})\](?![(:])/g, '[$1](cue:$1)')))
    .join('')
}

const urlTransform = (url: string) => (url.startsWith('cue:') ? url : defaultUrlTransform(url))

/** Agent reply as Markdown (GFM) in the app's type scale; cue numbers jump to the cue. */
export const Markdown = memo(function Markdown({ text, cueTime, cueText, onCue }: Props) {
  const components: Components = {
    h1: ({ children }) => <h3 className="type-title-medium type-emph mb-2 mt-3 first:mt-0">{children}</h3>,
    h2: ({ children }) => <h3 className="type-title-medium type-emph mb-2 mt-3 first:mt-0">{children}</h3>,
    h3: ({ children }) => <h4 className="type-title-small mb-1.5 mt-3 first:mt-0">{children}</h4>,
    h4: ({ children }) => <h4 className="type-title-small mb-1.5 mt-3 first:mt-0">{children}</h4>,
    p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
    ul: ({ children }) => <ul className="mb-2 list-disc space-y-1 pl-5 last:mb-0">{children}</ul>,
    ol: ({ children }) => <ol className="mb-2 list-decimal space-y-1 pl-5 last:mb-0">{children}</ol>,
    li: ({ children }) => <li className="pl-0.5">{children}</li>,
    strong: ({ children }) => <strong className="font-semibold text-[var(--md-sys-color-on-surface)]">{children}</strong>,
    blockquote: ({ children }) => (
      <blockquote className="mb-2 border-l-2 border-[var(--md-sys-color-primary)] pl-3 text-[var(--md-sys-color-on-surface-variant)] last:mb-0 [&>p]:mb-1">{children}</blockquote>
    ),
    hr: () => <hr className="my-3 border-[var(--md-sys-color-outline-variant)]" />,
    code: ({ children, className }) =>
      className ? (
        <code className={`${className} block`}>{children}</code>
      ) : (
        <code className="rounded-[var(--md-sys-shape-corner-extra-small)] bg-[var(--md-sys-color-surface-container)] px-1 py-0.5 text-[0.92em]">{children}</code>
      ),
    pre: ({ children }) => <pre className="mb-2 overflow-x-auto rounded-[var(--md-sys-shape-corner-small)] bg-[var(--md-sys-color-surface-container)] p-2 text-[0.92em] last:mb-0">{children}</pre>,
    table: ({ children }) => <div className="mb-2 overflow-x-auto last:mb-0"><table className="w-full border-collapse text-left">{children}</table></div>,
    th: ({ children }) => <th className="border-b border-[var(--md-sys-color-outline-variant)] px-2 py-1 font-semibold text-[var(--md-sys-color-on-surface-variant)]">{children}</th>,
    td: ({ children }) => <td className="border-t border-[var(--md-sys-color-outline-variant)] px-2 py-1 align-top">{children}</td>,
    a: ({ href, children }) => {
      const m = href?.match(/^cue:(\d+)$/)
      if (m) {
        const i = Number(m[1])
        const time = cueTime(i)
        if (time === null) return <span>[{children}]</span>
        return (
          <button
            type="button"
            title={cueText(i)}
            onClick={() => onCue(i)}
            className="morph type-label-medium mx-0.5 inline-flex h-7 items-center gap-0.5 rounded-[var(--md-sys-shape-corner-small)] bg-[var(--md-sys-color-secondary-container)] pl-1 pr-2 align-middle font-semibold tabular-nums text-[var(--md-sys-color-on-secondary-container)] active:rounded-[14px]"
          >
            <Icon name="play_arrow" size={18} fill />{time}
          </button>
        )
      }
      // External links would navigate the app's webview away: show them as text.
      return <span className="underline decoration-dotted" title={href}>{children}</span>
    },
  }
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} urlTransform={urlTransform} components={components}>
      {linkCues(text)}
    </ReactMarkdown>
  )
})
