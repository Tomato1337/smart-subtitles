import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'
import { Markdown } from './Markdown'

describe('Markdown', () => {
  test('drops markdown images so prompt-injected URLs never trigger GET requests', () => {
    const html = renderToStaticMarkup(
      <Markdown
        text={'Смотри [12] ![x](http://127.0.0.1:47800/api/setup/llm/models) текст'}
        cueTime={(i) => (i === 12 ? '0:12' : null)}
        cueText={() => 'Line 12'}
        onCue={vi.fn()}
      />,
    )
    expect(html).not.toContain('<img')
    expect(html).not.toContain('47800')
    expect(html).toContain('0:12')
    expect(html).toContain('текст')
  })
})
