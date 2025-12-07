/*
Transform Pearl of Great Price JSON into normalized per-book JSON
Usage (PowerShell):
  ts-node --esm scripts/transform_pearl_json.ts --input data/pearl-of-great-price.json --outDir data/pearl_json

Output format per book:
{
  book: "Moses",
  order: 1,
  chapters: [
    { number: 1, verses: [ { number: 1, text: "..." }, ... ] },
    ...
  ]
}
*/

import fs from 'fs'
import path from 'path'

interface PearlVerse { reference: string; text: string; verse: number }
interface PearlChapter { chapter: number | string; reference?: string; verses: PearlVerse[] }
interface PearlBook { book: string; chapters: PearlChapter[] }
interface PearlRoot { books: PearlBook[] }

interface OutVerse { number: number; text: string }
interface OutChapter { number: number; verses: OutVerse[] }
interface OutBook { book: string; order: number; chapters: OutChapter[] }

const PEARL_ORDER = [
  'Moses',
  'Abraham',
  'Joseph Smith—Matthew',
  'Articles of Faith'
]

function parseArgs() {
  const args = process.argv.slice(2)
  const out: Record<string,string> = {}
  for (let i=0; i<args.length; i++) {
    const t = args[i]
    if (!t.startsWith('--')) continue
    const key = t.slice(2)
    const val = args[i+1] && !args[i+1].startsWith('--') ? args[i+1] : ''
    if (val) i++
    out[key] = val
  }
  return out
}

function ensureDir(p: string) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }) }

function shouldSkipChapter(ch: PearlChapter): boolean {
  const ref = (ch.reference || '').toLowerCase()
  if (ref.includes('facsimile')) return true
  const chapStr = String(ch.chapter).toLowerCase()
  if (chapStr.includes('facsimile')) return true
  return false
}

function normalizeBook(b: PearlBook): OutBook | null {
  const title = b.book.trim()
  if (!PEARL_ORDER.includes(title)) {
    // Ignore facsimiles or unknown books
    if (/facsimile/i.test(title)) return null
  }
  const order = PEARL_ORDER.indexOf(title) + 1 || 0
  const out: OutBook = { book: title, order, chapters: [] }
  for (const ch of b.chapters) {
    if (shouldSkipChapter(ch)) continue
    const num = typeof ch.chapter === 'number' ? ch.chapter : parseInt(String(ch.chapter).replace(/[^0-9]/g,''), 10)
    if (!Number.isFinite(num)) continue
    const verses: OutVerse[] = []
    for (const v of ch.verses) {
      const vn = typeof v.verse === 'number' ? v.verse : parseInt(String(v.verse).replace(/[^0-9]/g,''), 10)
      if (!Number.isFinite(vn)) continue
      const text = (v.text || '').trim()
      if (!text) continue
      // Skip any facsimile labeled verse
      if (/facsimile/i.test(v.reference || '')) continue
      verses.push({ number: vn, text })
    }
    if (verses.length) out.chapters.push({ number: num, verses })
  }
  // Drop books with no chapters
  if (out.chapters.length === 0) return null
  return out
}

function main() {
  const args = parseArgs()
  const input = args.input || 'data/pearl-of-great-price.json'
  const outDir = args.outDir || 'data/pearl_json'
  const raw = fs.readFileSync(input, 'utf8')
  const json: PearlRoot = JSON.parse(raw)
  ensureDir(outDir)
  let count = 0
  for (const b of json.books) {
    const out = normalizeBook(b)
    if (!out) continue
    const fname = `${out.book.replace(/\s+/g,'')}.json`
    const fpath = path.join(outDir, fname)
    fs.writeFileSync(fpath, JSON.stringify(out, null, 2) + '\n', 'utf8')
    count++
    console.log(`Wrote ${out.book} -> ${fpath}`)
  }
  console.log(`Done. Books written: ${count}`)
}

main()
