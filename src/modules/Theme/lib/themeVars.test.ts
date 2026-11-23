import { describe, expect, test } from 'vitest'
import { themeVars } from './themeVars'

const input = {
  seed: '#062FEE',
  mode: 'dark',
  colors: { surface_container_lowest: '#15151a', on_primary: '#242b62' },
}

describe('themeVars', () => {
  test('maps snake_case roles to MD3 custom properties', () => {
    const v = themeVars(input)
    expect(v['--md-sys-color-surface-container-lowest']).toBe('#15151a')
    expect(v['--md-sys-color-on-primary']).toBe('#242b62')
  })

  test('omits roles the palette does not have', () => {
    expect(themeVars(input)['--md-sys-color-primary']).toBeUndefined()
  })

  test('derives kind colors per mode', () => {
    const dark = themeVars(input)['--app-kind-idiom']
    const light = themeVars({ ...input, mode: 'light' })['--app-kind-idiom']
    expect(dark).toMatch(/^#[0-9a-f]{6}$/)
    expect(light).not.toBe(dark)
  })

  test('emits success roles in both modes', () => {
    const dark = themeVars(input)
    const light = themeVars({ ...input, mode: 'light' })
    expect(dark['--app-success']).toMatch(/^#[0-9a-f]{6}$/)
    expect(dark['--app-success-container']).toMatch(/^#[0-9a-f]{6}$/)
    expect(dark['--app-on-success-container']).toMatch(/^#[0-9a-f]{6}$/)
    expect(light['--app-success']).not.toBe(dark['--app-success'])
  })
})
