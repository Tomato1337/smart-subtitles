import type { SessionState } from '@/common/types/ipc'

export type MediaMeta = { title: string; artist: string; album: string }

/**
 * System-media-widget text for a session: an episode shows its name and `сериал · S1E2`,
 * a film shows its local title and `оригинал · год`.
 */
export function mediaMetaOf(
 s: Pick<SessionState, 'title' | 'originalTitle' | 'year' | 'season' | 'episode' | 'episodeTitle'>,
): MediaMeta {
 const original = s.originalTitle && s.originalTitle !== s.title ? s.originalTitle : null
 if (s.season !== null && s.episode !== null) {
  return {
   title: s.episodeTitle ?? `Серия ${s.episode}`,
   artist: `${s.title} · S${s.season}E${s.episode}`,
   album: original ?? '',
  }
 }
 const parts: string[] = []
 if (original) parts.push(original)
 if (s.year !== null) parts.push(String(s.year))
 return { title: s.title, artist: parts.join(' · '), album: '' }
}
