// Basic parsing of plain text files into chapters and verses

function splitIntoSentences(text: string): string[] {
  // Split on ., !, ? while keeping delimiter
  const parts = text
    .replace(/\r\n/g, '\n')
    .split(/(?<=[.!?])\s+(?=[A-Z\d\(\"'])/)
    .map(s => s.trim())
    .filter(Boolean)
  return parts
}

export function autoGenerateVerses(text: string, targetWords = 25): string[] {
  const sentences = splitIntoSentences(text)
  const verses: string[] = []
  let current: string[] = []
  let count = 0
  for (const s of sentences) {
    const words = s.split(/\s+/).filter(Boolean)
    if (count + words.length > targetWords && current.length > 0) {
      verses.push(current.join(' '))
      current = []
      count = 0
    }
    current.push(s)
    count += words.length
  }
  if (current.length) verses.push(current.join(' '))
  return verses
}

export function detectChapters(raw: string): { title: string; body: string }[] {
  const lines = raw.replace(/\r\n/g, '\n').split('\n')
  const chapters: { title: string; body: string }[] = []
  let buffer: string[] = []
  let currentTitle: string | null = null
  const push = () => {
    if (buffer.length) {
      chapters.push({ title: currentTitle ?? 'Chapter', body: buffer.join('\n').trim() })
      buffer = []
      currentTitle = null
    }
  }

  const chapterHeader = /^(chapter|ch\.|section)\s+([ivxlcdm]+|\d+)/i
  for (const line of lines) {
    if (chapterHeader.test(line.trim())) {
      push()
      currentTitle = line.trim()
    } else {
      buffer.push(line)
    }
  }
  push()
  if (chapters.length === 0) return [{ title: 'Chapter 1', body: raw }]
  return chapters
}

export function parseVersesFromChapterBody(body: string): string[] {
  const lines = body.replace(/\r\n/g, '\n').split('\n').map(l => l.trim())
  const versePattern = /^(\d{1,3})\s+(.+)/
  const verses: string[] = []
  let hasExplicit = false
  for (const ln of lines) {
    const m = ln.match(versePattern)
    if (m) {
      hasExplicit = true
      verses.push(m[2].trim())
    }
  }
  if (hasExplicit && verses.length) return verses
  // fallback to auto-generate
  return autoGenerateVerses(lines.join(' ').replace(/\s+/g, ' ').trim())
}

export function parsePlainTextToChaptersAndVerses(raw: string) {
  const chapters = detectChapters(raw)
  return chapters.map((c, idx) => ({
    seq: idx + 1,
    title: c.title,
    verses: parseVersesFromChapterBody(c.body)
  }))
}
