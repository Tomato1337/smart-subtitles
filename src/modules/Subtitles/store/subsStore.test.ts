import { beforeEach, describe, expect, test } from 'vitest'
import { useSubsStore } from './subsStore'

describe('useSubsStore', () => {
  beforeEach(() => {
    useSubsStore.getState().reset('media-1', 0)
  })

  test('setCues clears stale failedBatches when cues reload', () => {
    const s = useSubsStore.getState()
    s.markFailed(0)
    s.markFailed(40)
    expect(useSubsStore.getState().failedBatches.size).toBe(2)

    useSubsStore.getState().setCues([{ idx: 0, start: 1, end: 2, text: 'Hi', ru: null }], [])
    expect(useSubsStore.getState().failedBatches.size).toBe(0)
  })

  test('setChoosing tracks in-flight selection per mediaId independently', () => {
    const s = useSubsStore.getState()
    s.setChoosing('media-1', 'sub-a')
    s.setChoosing('media-2', 'sub-b')
    expect(useSubsStore.getState().choosingByMedia).toEqual({
      'media-1': 'sub-a',
      'media-2': 'sub-b',
    })

    useSubsStore.getState().setChoosing('media-1', null)
    expect(useSubsStore.getState().choosingByMedia).toEqual({
      'media-1': null,
      'media-2': 'sub-b',
    })
  })
})
