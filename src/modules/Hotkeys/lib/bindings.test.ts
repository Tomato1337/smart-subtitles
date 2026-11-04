import { describe, expect, test } from 'vitest'
import { comboOf } from '@/common/utilities/keys'
import { DEFAULT_BINDINGS } from './actions'
import { actionFor, keyLabel, overridesOf, parseOverrides, rebind, withKey } from './bindings'

const plain = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false }

describe('rebind', () => {
  test('takes the combo from the action that held it', () => {
    const { bindings, stolen } = rebind(DEFAULT_BINDINGS, 'replay', 'KeyS')
    expect(bindings.replay).toBe('KeyS')
    expect(bindings.sidebar).toBeNull()
    expect(stolen).toBe('sidebar')
    expect(actionFor(bindings, 'KeyS')).toBe('replay')
  })
  test('the same combo on the same action steals nothing', () => {
    expect(rebind(DEFAULT_BINDINGS, 'replay', 'KeyR').stolen).toBeNull()
  })
})

describe('parseOverrides', () => {
  test('keeps string and null entries of known actions, drops anything else', () => {
    const b = parseOverrides('{"replay":"KeyQ","bogus":"KeyW","chat":5}')
    expect(b.replay).toBe('KeyQ')
    expect(b.chat).toBe('KeyC')
    expect(Object.hasOwn(b, 'bogus')).toBe(false)
  })
  test('garbage falls back to the defaults', () => {
    expect(parseOverrides('not json')).toEqual(DEFAULT_BINDINGS)
    expect(parseOverrides('[]')).toEqual(DEFAULT_BINDINGS)
  })
  test('a duplicated combo stays with the first action in list order', () => {
    // «Повторить реплику» (replay) стоит в списке выше «Диалогов» (sidebar), поэтому дубль остаётся за ней.
    const b = parseOverrides('{"replay":"KeyS"}')
    expect(b.replay).toBe('KeyS')
    expect(b.sidebar).toBeNull()
    // Обратный случай: назначенная позже клавиша не отбирает код у действия, которое выше в списке.
    const c = parseOverrides('{"sidebar":"KeyR"}')
    expect(c.replay).toBe('KeyR')
    expect(c.sidebar).toBeNull()
  })
})

describe('overridesOf', () => {
  test('keeps only what differs from the defaults', () => {
    expect(overridesOf(rebind(DEFAULT_BINDINGS, 'replay', 'KeyQ').bindings)).toEqual({ replay: 'KeyQ' })
    expect(overridesOf(DEFAULT_BINDINGS)).toEqual({})
  })
})

describe('comboOf', () => {
  test('joins the held modifiers with the code', () => {
    expect(comboOf({ code: 'ArrowLeft', ...plain, shiftKey: true })).toBe('Shift+ArrowLeft')
    expect(comboOf({ code: 'KeyP', ...plain, ctrlKey: true, shiftKey: true })).toBe('Ctrl+Shift+KeyP')
  })
  test('a bare modifier is not a combo', () => {
    expect(comboOf({ code: 'ShiftLeft', ...plain, shiftKey: true })).toBeNull()
  })
})

describe('keyLabel', () => {
  test('renders modifiers and readable key codes', () => {
    expect(keyLabel('Ctrl+BracketLeft')).toBe('Ctrl+[')
    expect(keyLabel('Space')).toBe('Пробел')
    expect(keyLabel('Shift+ArrowLeft')).toBe('Shift+←')
    expect(keyLabel('KeyF')).toBe('F')
    expect(keyLabel('F5')).toBe('F5')
    expect(keyLabel(null)).toBe('—')
  })
})

describe('withKey', () => {
  test('adds the key only while the action has one', () => {
    expect(withKey('Диалоги', 'KeyS')).toBe('Диалоги (S)')
    expect(withKey('Диалоги', null)).toBe('Диалоги')
  })
})
