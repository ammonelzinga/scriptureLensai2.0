import fs from 'fs'
import path from 'path'

type Verse = { chapter: number; verse: number; text: string }
type Chapter = { chapter: number; title?: string; verses: Verse[] }
type Book = { title: string; chapters: Chapter[] }

const romanMap: Record<string, number> = {I:1,II:2,III:3,IV:4,V:5,VI:6,VII:7,VIII:8,IX:9,X:10,XI:11,XII:12,XIII:13,XIV:14,XV:15,XVI:16,XVII:17,XVIII:18,XIX:19,XX:20,XXI:21,XXII:22,XXIII:23,XXIV:24,XXV:25,XXVI:26,XXVII:27,XXVIII:28,XXIX:29,XXX:30}
function romanToInt(s: string): number | null {
  const t = s.trim().toUpperCase()
  return romanMap[t] ?? null
}

const BOOK_TITLES = [
  'The First Book of Adam and Eve',
  'The Second Book of Adam and Eve',
  'The Secrets of Enoch',
  'The Psalms of Solomon',
  'The Odes of Solomon',
  'The Letter of Aristeas',
  'The Fourth Book of Maccabees',
  'The Story of Ahikar',
  'The Testament of Reuben',
  'The Testament of Simeon',
  'The Testament of Levi',
  'The Testament of Judah',
  'The Testament of Issachar',
  'The Testament of Zebulun',
  'The Testament of Dan',
  'The Testament of Naphtali',
  'The Testament of Gad',
  'The Testament of Asher',
  'The Testament of Joseph',
  'The Testament of Benjamin'
]

function isPageTag(line: string) { return /<page\s+\d+>/i.test(line) }
function isBracketPage(line: string) { return /\[p\.\s*\d+\]/i.test(line) }
function isRutherford(line: string) { return /rutherford/i.test(line) }

function parseFile(inputPath: string): Book[] {
  const raw = fs.readFileSync(inputPath, 'utf8')
  const lines = raw.split(/\r?\n/)
  const books: Book[] = []
  let currentBook: Book | null = null
  let currentChapter: Chapter | null = null
  let pendingTitle: string | null = null
  let chapterPrelude: string = ''

  const norm = (s: string) => s.replace(/\s+/g,' ').trim().toLowerCase()
  const isExactBookTitle = (t: string) => BOOK_TITLES.some(b => norm(t) === norm(b))
  const isBookHeader = (line: string, i: number) => {
    const t = norm(line)
    if (isExactBookTitle(line)) return BOOK_TITLES.find(b => norm(b) === t) || null
    // Handle split headers like "THE SECOND BOOK OF" then next line "Adam and Eve"
    if (/^the\s+(first|second)\s+book\s+of\s*$/i.test(line.trim())) {
      // next non-empty line becomes subject
      for (let j = i+1; j < lines.length; j++) { const nxt = lines[j].trim(); if (!nxt) continue; const full = `The ${line.trim().split(/\s+/)[1][0].toUpperCase()+line.trim().split(/\s+/)[1].slice(1).toLowerCase()} Book of ${nxt}`; if (isExactBookTitle(full)) return full; break; }
    }
    // Handle THE TESTAMENT OF <name> (name may be broken or on next line)
    if (/^\s*the\s+testament\s+of\b/i.test(line)) {
      const after = line.replace(/^\s*the\s+testament\s+of\s*/i,'').trim()
      if (after) {
        const full = `The Testament of ${after}`
        if (isExactBookTitle(full)) return full
      } else {
        // look ahead for next non-empty line as name
        for (let j = i+1; j < lines.length; j++) { const nxt = lines[j].trim(); if (!nxt) continue; const full2 = `The Testament of ${nxt}`; if (isExactBookTitle(full2)) return full2; break; }
      }
    }
    // Direct exact matches like THE SECRETS OF ENOCH, etc.
    const direct = line.trim().replace(/^THE\s+/,'The ').replace(/\s+/g,' ').trim()
    if (isExactBookTitle(direct)) return direct
    return null
  }
  const isChapterHeader = (line: string) => {
    const m = /^\s*CHAP\.?\s+([IVXLCDM]+)\.?\s*$/i.exec(line)
    if (!m) return null
    const n = romanToInt(m[1])
    if (!n) return null
    return n
  }
  const isVerseStart = (line: string) => {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (!m) return null
    return { n: parseInt(m[1], 10), rest: m[2] }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line || !line.trim()) continue
    if (isPageTag(line) || isBracketPage(line) || isRutherford(line)) continue

    const header = isBookHeader(line, i)
    if (header) {
      // start new book
      if (currentBook) {
        // flush any open chapter
        if (currentChapter && currentChapter.verses.length) currentBook.chapters.push(currentChapter)
        books.push(currentBook)
      }
      currentBook = { title: header, chapters: [] }
      currentChapter = null
      pendingTitle = null
      continue
    }

    const chNum = isChapterHeader(line)
    if (chNum) {
      // new chapter
      if (!currentBook) {
        // if no book yet, try to use pendingTitle or create unknown
        currentBook = { title: pendingTitle || 'Untitled', chapters: [] }
      }
      if (currentChapter && currentChapter.verses.length) currentBook.chapters.push(currentChapter)
      currentChapter = { chapter: chNum, title: pendingTitle || undefined, verses: [] }
      chapterPrelude = ''
      pendingTitle = null
      continue
    }

    const v = isVerseStart(line)
    if (v) {
      if (!currentBook) {
        currentBook = { title: pendingTitle || 'Untitled', chapters: [] }
      }
      if (!currentChapter) {
        currentChapter = { chapter: 1, title: pendingTitle || undefined, verses: [] }
        pendingTitle = null
      }
      // If we have prelude text accumulated before the first numbered verse, emit it as verse 1
      if (chapterPrelude.trim().length && !currentChapter.verses.some(x => x.verse === 1)) {
        currentChapter.verses.push({ chapter: currentChapter.chapter, verse: 1, text: chapterPrelude.trim() })
        chapterPrelude = ''
      }
      currentChapter.verses.push({ chapter: currentChapter.chapter, verse: v.n, text: v.rest.trim() })
    } else {
      // treat as heading/title line between book/chapter
      const t = line.trim()
      if (t && !/^CHAP\./i.test(t)) pendingTitle = t
      // or continuation of previous verse
      if (currentChapter) {
        if (currentChapter.verses.length) {
          const last = currentChapter.verses[currentChapter.verses.length - 1]
          last.text = `${last.text} ${t}`.trim()
        } else {
          // accumulate prelude lines before the first numbered verse as verse 1
          chapterPrelude = (chapterPrelude ? `${chapterPrelude} ${t}` : t).trim()
        }
      }
    }
  }
  // flush tail
  if (currentBook) {
    if (currentChapter && currentChapter.verses.length) currentBook.chapters.push(currentChapter)
    books.push(currentBook)
  }
  return books
}

function main() {
  const input = path.join('data', 'PseudepigraphaOldTestament.txt')
  const outDir = path.join('data', 'pseudepigrapha_json')
  if (!fs.existsSync(input)) throw new Error(`Input not found: ${input}`)
  const books = parseFile(input)
  fs.mkdirSync(outDir, { recursive: true })
  for (const b of books) {
    const fn = path.join(outDir, `${b.title}.json`)
    fs.writeFileSync(fn, JSON.stringify(b, null, 2), 'utf8')
  }
  console.log(`Parsed ${books.length} books to ${outDir}`)
}
// ESM entrypoint: invoke main immediately
main()
