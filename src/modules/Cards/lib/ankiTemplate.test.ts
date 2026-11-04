import { expect, it } from 'vitest'
import { renderCard } from './ankiTemplate'

const values = {
  Word: 'bring',
  ClozeText: "It'll [...] him joy.",
  FullSentence: "It'll bring him joy.",
  WordAudio: '[sound:bring_1.mp3]',
  Image: '',
  Clip: '',
}

it('shows and hides sections, and inverts them', () => {
  expect(renderCard('{{#Image}}pic{{/Image}}x', values, 'front')).toBe('x')
  expect(renderCard('{{#Word}}[{{Word}}]{{/Word}}', values, 'front')).toBe('[bring]')
  expect(renderCard('{{^Image}}no pic{{/Image}}', values, 'front')).toBe('no pic')
  // A whitespace-only field counts as empty, as in Anki.
  expect(renderCard('{{#Image}}pic{{/Image}}!', { Image: '   ' }, 'front')).toBe('!')
})

it('nests sections', () => {
  const tpl = '{{#Word}}{{#Image}}both{{/Image}}{{^Image}}{{Word}}{{/Image}}{{/Word}}'
  expect(renderCard(tpl, values, 'front')).toBe('bring')
  expect(renderCard(tpl, { ...values, Image: '<img src="x">' }, 'front')).toBe('both')
})

it('puts the front side into the back template', () => {
  const front = renderCard('<div>{{ClozeText}}</div>', values, 'front')
  expect(front).toBe("<div>It'll [...] him joy.</div>")
  expect(renderCard('{{FrontSide}}<hr>{{Word}}', values, 'back', front)).toBe("<div>It'll [...] him joy.</div><hr>bring")
})

it('renders the type and cloze filters per side', () => {
  expect(renderCard('{{type:Word}}', values, 'front')).toBe('<input type="text" disabled>')
  expect(renderCard('{{type:Word}}', values, 'back')).toBe('<code>bring</code>')
  expect(renderCard('{{cloze:Word}}', values, 'front')).toBe('[...]')
  expect(renderCard('{{cloze:Word}}', values, 'back')).toBe('<b class="cloze">bring</b>')
})

it('strips tags for text, keeps hint and unknown filters as the value', () => {
  expect(renderCard('{{text:Image}}', { Image: '<img src="x"> hi' }, 'front')).toBe('hi')
  expect(renderCard('{{hint:Word}}', values, 'front')).toBe('bring')
  expect(renderCard('{{tts en_US voices=Alex:Word}}', values, 'front')).toBe('bring')
  expect(renderCard('{{unknown:Word}}', values, 'front')).toBe('bring')
  expect(renderCard('{{Missing}}', values, 'front')).toBe('')
})

it('turns sound tags into a speaker and drops scripts', () => {
  expect(renderCard('{{WordAudio}}', values, 'back')).toBe('<span class="ss-sound">🔊</span>')
  expect(renderCard('a<script>alert(1)</script>b', values, 'front')).toBe('ab')
})
