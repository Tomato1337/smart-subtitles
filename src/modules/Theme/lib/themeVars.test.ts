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

  test('lifts flat dark on-surface and dim container text while keeping variant distinct', () => {
    const v = themeVars({
      seed: '#bcc2ff',
      mode: 'dark',
      colors: {
        surface: '#15151a',
        on_surface: '#c7c5d1',
        on_surface_variant: '#c7c5d1',
        primary_container: '#3e4a9c',
        on_primary_container: '#bfc2e4',
        secondary_container: '#3e436d',
        on_secondary_container: '#afb3dd',
        tertiary_container: '#8b3627',
        on_tertiary_container: '#e9b9b0',
        error_container: '#7d2b25',
        on_error_container: '#f4dddb',
      },
    })
    expect(v['--md-sys-color-on-surface']).toBe('#e2e1e7')
    expect(v['--md-sys-color-on-surface-variant']).toBe('#c7c5d1')
    expect(v['--md-sys-color-on-primary-container']).toBe('#e7e9f5')
    expect(v['--md-sys-color-on-secondary-container']).toBe('#d3d5ec')
    expect(v['--md-sys-color-on-tertiary-container']).toBe('#f7e5e2')
    // Already >= 6.5:1: left untouched.
    expect(v['--md-sys-color-on-error-container']).toBe('#f4dddb')
  })

  test('keeps already high-contrast light roles unchanged', () => {
    const v = themeVars({
      seed: '#4d58aa',
      mode: 'light',
      colors: {
        surface: '#fcf8ff',
        on_surface: '#24213f',
        on_surface_variant: '#5e5a85',
        primary_container: '#b5bcff',
        on_primary_container: '#1f2a7a',
      },
    })
    expect(v['--md-sys-color-on-surface']).toBe('#24213f')
    expect(v['--md-sys-color-on-primary-container']).toBe('#1f2a7a')
  })
})
