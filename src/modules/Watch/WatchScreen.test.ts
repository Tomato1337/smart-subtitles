import { describe, expect, test, vi } from 'vitest'
import { cardDedupKey, shouldFinishSessionClose, shouldIgnorePlayerHotkey } from './WatchScreen'

class FakeElement {
  matches: string[]
  constructor(matches: string[] = []) {
    this.matches = matches
  }
  closest(selector: string) {
    return selector.split(',').some((part) => this.matches.includes(part.trim())) ? this : null
  }
}

describe('shouldIgnorePlayerHotkey', () => {
  test('ignores IME composition and Process/229 keys', () => {
    expect(shouldIgnorePlayerHotkey({ isComposing: true, key: ' ', keyCode: 32, code: 'Space', target: null }, { explainOpen: false })).toBe(true)
    expect(shouldIgnorePlayerHotkey({ isComposing: false, key: 'Process', keyCode: 229, code: 'KeyK', target: null }, { explainOpen: false })).toBe(true)
    expect(shouldIgnorePlayerHotkey({ isComposing: false, key: 'k', keyCode: 229, code: 'KeyK', target: null }, { explainOpen: false })).toBe(true)
  })

  test('suppresses hotkeys when an interactive overlay or ExplainPopover is open', () => {
    const docWithMenu = { querySelector: (sel: string) => (sel.includes('[role="menu"]') ? {} : null) } as unknown as Document
    const cleanDoc = { querySelector: () => null } as unknown as Document
    expect(shouldIgnorePlayerHotkey({ isComposing: false, key: 'k', keyCode: 75, code: 'KeyK', target: null }, { explainOpen: false, doc: docWithMenu })).toBe(true)
    expect(shouldIgnorePlayerHotkey({ isComposing: false, key: 'k', keyCode: 75, code: 'KeyK', target: null }, { explainOpen: true, doc: cleanDoc })).toBe(true)
    expect(shouldIgnorePlayerHotkey({ isComposing: false, key: 'k', keyCode: 75, code: 'KeyK', target: null }, { explainOpen: false, doc: cleanDoc })).toBe(false)
  })

  test('does not hijack Space from focused controls, while allowing other hotkeys', () => {
    vi.stubGlobal('Element', FakeElement)
    try {
      const btn = new FakeElement(['button']) as unknown as EventTarget
      const cleanDoc = { querySelector: () => null } as unknown as Document
      expect(shouldIgnorePlayerHotkey({ isComposing: false, key: ' ', keyCode: 32, code: 'Space', target: btn }, { explainOpen: false, doc: cleanDoc })).toBe(true)
      expect(shouldIgnorePlayerHotkey({ isComposing: false, key: 'f', keyCode: 70, code: 'KeyF', target: btn }, { explainOpen: false, doc: cleanDoc })).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('does not hijack slider arrow/Home/End navigation', () => {
    vi.stubGlobal('Element', FakeElement)
    try {
      const slider = new FakeElement(['[role="slider"]']) as unknown as EventTarget
      const cleanDoc = { querySelector: () => null } as unknown as Document
      expect(shouldIgnorePlayerHotkey({ isComposing: false, key: 'ArrowLeft', keyCode: 37, code: 'ArrowLeft', target: slider }, { explainOpen: false, doc: cleanDoc })).toBe(true)
      expect(shouldIgnorePlayerHotkey({ isComposing: false, key: 'f', keyCode: 70, code: 'KeyF', target: slider }, { explainOpen: false, doc: cleanDoc })).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('WatchScreen guards', () => {
  test('cardDedupKey isolates mediaId, cueIdx, and span', () => {
    expect(cardDedupKey('m1', 12, null)).toBe('m1:12:')
    expect(cardDedupKey('m1', 12, 'take off')).toBe('m1:12:take off')
  })

  test('shouldFinishSessionClose prevents stale sessionClose from closing a newly opened session', () => {
    expect(shouldFinishSessionClose('s1', 's1')).toBe(true)
    expect(shouldFinishSessionClose(null, 's1')).toBe(true)
    expect(shouldFinishSessionClose('s2', 's1')).toBe(false)
  })
})
