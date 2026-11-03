import lemmatizer from 'wink-lemmatizer'

/** First lemma that differs from the token (verb, noun, adjective), else the token itself. */
export function lemma(token: string): string {
  const t = token.toLowerCase()
  for (const f of [lemmatizer.verb, lemmatizer.noun, lemmatizer.adjective]) {
    const l = f(t)
    if (l !== t) return l
  }
  return t
}

/** Lemma key of a word or phrase: lower-case `[a-z']+` tokens, each lemmatized, space-joined. */
export function lemmaKey(text: string): string {
  return (text.toLowerCase().match(/[a-z']+/g) ?? []).map(lemma).join(' ')
}
