import { expect, test } from 'vitest'
import { tokenize } from './tokens'

test('words and punctuation with exact offsets', () => {
  const t = tokenize("He's bailing, OK?")
  expect(t.map((x) => x.text).join('')).toBe("He's bailing, OK?")
  const words = t.filter((x) => x.isWord).map((x) => x.text)
  expect(words).toEqual(["He's", 'bailing', 'OK'])
  const ok = t.find((x) => x.text === 'OK')!
  expect("He's bailing, OK?".slice(ok.start, ok.end)).toBe('OK')
})
