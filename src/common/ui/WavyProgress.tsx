import { useCallback, useId, useLayoutEffect, useRef, type CSSProperties } from 'react'
import { waveGeom } from './wave'

type Props = {
 value: number
 buffer?: number
 amp: number
 len: number
 stroke: number
 animated: boolean
 thumb?: boolean
 className?: string
}

/** One wavelength in the SVG; the CSS keyframes shift the path by exactly this much per period. */
const PHASE_HZ = 0.9

/**
 * Wavy progress line. The travel is a CSS transform of a pre-built path (no per-frame JavaScript),
 * so the wave stays smooth and never invalidates the document styles, which used to make hover
 * transitions blink. Everything else is drawn through refs on prop changes only.
 */
export function WavyProgress(p: Props) {
 const span = useRef<HTMLSpanElement>(null)
 const svg = useRef<SVGSVGElement>(null)
 const track = useRef<SVGLineElement>(null)
 const buffer = useRef<SVGLineElement>(null)
 const wave = useRef<SVGPathElement>(null)
 const stop = useRef<SVGCircleElement>(null)
 const thumb = useRef<SVGRectElement>(null)
 const clip = useRef<SVGRectElement>(null)
 const size = useRef({ w: 0, h: 0 })
 const drawn = useRef({ d: '', track: '', buffer: '', stop: '', thumb: '', clip: '' })
 const latest = useRef(p)
 latest.current = p
 const clipId = `wavy-${useId().replace(/[^A-Za-z0-9_-]/g, '_')}`

 const draw = useCallback(() => {
  const root = svg.current
  const { w, h } = size.current
  if (!root || !w) return
  const o = latest.current
  const s = o.stroke
  const g = waveGeom(w, h, {
   value: o.value,
   buffer: o.buffer,
   amp: o.amp,
   len: o.len,
   stroke: s,
   phase: 0,
   thumb: !!o.thumb,
  })
  if (root.getAttribute('viewBox') !== `0 0 ${w} ${h}`) root.setAttribute('viewBox', `0 0 ${w} ${h}`)
  const line = (el: SVGLineElement | null, range: [number, number] | null, key: 'track' | 'buffer') => {
   if (!el) return
   const sig = range ? `${range[0].toFixed(2)}|${range[1].toFixed(2)}` : ''
   if (drawn.current[key] === sig) return
   drawn.current[key] = sig
   el.style.display = range ? '' : 'none'
   if (!range) return
   el.setAttribute('x1', String(range[0]))
   el.setAttribute('x2', String(range[1]))
   el.setAttribute('y1', String(h / 2))
   el.setAttribute('y2', String(h / 2))
   el.setAttribute('stroke-width', String(s))
  }
  // The wave is built with phase 0 and a margin of one wavelength on both sides: the CSS
  // animation slides it by one wavelength per period, so no gap ever appears at the edges.
  const x = Math.max(0, Math.min(1, o.value)) * w
  const end = Math.max(s / 2, x - (o.thumb ? 8 : 5))
  let d = ''
  if (x > s) {
   for (let px = s / 2 - o.len; px <= end + o.len; px += 1.5) {
    const y = h / 2 + o.amp * Math.sin((px / o.len) * 2 * Math.PI)
    d += `${d ? 'L' : 'M'}${px.toFixed(1)} ${y.toFixed(2)}`
   }
  }
  if (wave.current && drawn.current.d !== d) {
   drawn.current.d = d
   wave.current.setAttribute('d', d)
   wave.current.setAttribute('stroke-width', String(s))
  }
  const clipSig = x > s ? `${(s / 2).toFixed(2)}|${end.toFixed(2)}|${h}` : ''
  if (clip.current && drawn.current.clip !== clipSig) {
   drawn.current.clip = clipSig
   clip.current.setAttribute('x', String(s / 2))
   clip.current.setAttribute('y', '0')
   clip.current.setAttribute('width', String(Math.max(0, end - s / 2)))
   clip.current.setAttribute('height', String(h))
  }
  line(track.current, g.track, 'track')
  line(buffer.current, g.buffer, 'buffer')
  const stopSig = `${g.stopX.toFixed(2)}|${s}`
  if (stop.current && drawn.current.stop !== stopSig) {
   drawn.current.stop = stopSig
   stop.current.setAttribute('cx', String(g.stopX))
   stop.current.setAttribute('cy', String(h / 2))
   stop.current.setAttribute('r', String(s / 2.6))
  }
  if (thumb.current && g.thumbX !== null) {
   const hh = h - 4
   const sig = `${g.thumbX.toFixed(2)}|${h}`
   if (drawn.current.thumb !== sig) {
    drawn.current.thumb = sig
    thumb.current.setAttribute('x', String(g.thumbX - 2.5))
    thumb.current.setAttribute('y', String(h / 2 - hh / 2))
    thumb.current.setAttribute('height', String(hh))
   }
  }
 }, [])

 // The size is measured once and then only on resize: never inside an animation frame.
 useLayoutEffect(() => {
  const el = span.current
  if (!el) return
  const measure = () => { size.current = { w: el.clientWidth, h: el.clientHeight } }
  measure()
  draw()
  if (typeof ResizeObserver === 'undefined') return
  const ro = new ResizeObserver(() => { measure(); draw() })
  ro.observe(el)
  return () => ro.disconnect()
 }, [draw])

 useLayoutEffect(() => {
  draw()
 }, [p.value, p.buffer, p.thumb, p.stroke, draw])

 return (
  <span
   ref={span}
   className={`wavy${p.className ? ` ${p.className}` : ''}`}
   aria-hidden="true"
   style={{ '--wave-len': `${p.len}px`, '--wave-period': `${(1 / PHASE_HZ).toFixed(3)}s` } as CSSProperties}
  >
   <svg ref={svg}>
    <defs>
     <clipPath id={clipId}>
      <rect ref={clip} />
     </clipPath>
    </defs>
    <line ref={track} className="w-track" />
    <line ref={buffer} className="w-buffer" />
    {/* Only the wave travels. The clip sits on the static group, so it, the track and the thumb stay put. */}
    <g clipPath={`url(#${clipId})`}>
     <path ref={wave} className={p.animated ? 'w-wave wavy-run' : 'w-wave wavy-run wavy-paused'} />
    </g>
    <circle ref={stop} className="w-stop" />
    {p.thumb ? <rect ref={thumb} className="w-thumb" width={5} rx={2.5} /> : null}
   </svg>
  </span>
 )
}
