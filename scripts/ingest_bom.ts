/*
Book of Mormon Ingestion & Chunking Pipeline
-------------------------------------------
Usage (PowerShell):
  $env:OPENAI_API_KEY="sk-..."; $env:SUPABASE_URL="..."; $env:SUPABASE_SERVICE_ROLE_KEY="..."
  ts-node --esm scripts/ingest_bom.ts --bomTxt data/BookOfMormon.txt --workName "The Book of Mormon" --sourceName "Project Gutenberg" --traditionName "Latter-day Saint" --dryRun

Features:
- Parses Book of Mormon text into books/chapters/verses (handles book introductions).
- Chunks chapters via GPT (or heuristic), saves per-chapter cache under data/chunks_cache_bom/.
- Supports dry run (no DB writes) to inspect chunk JSON.
- Can embed from cache and upload to Supabase with 512-d embeddings.

Flags:
--bomTxt <path> (required)
--workName <string>
--sourceName <string>
--traditionName <string>
--bookFilter <string> only ingest that book
--startAt <BookTitle> begin at a specific book
--dryRun true to skip Supabase writes
--noChunkGPT true to use heuristic chunking
--force true to re-embed/insert chunks even if existing
--cacheChunks false to disable chapter cache
--chunkModel <model> override chunking model
--embedFromCache true to read all chapter caches and skip GPT chunking
--maxRetries <n> --throttleMs <ms> --initialBackoffMs <ms>
*/

import dotenv from 'dotenv'
dotenv.config({ path: '.env' })
dotenv.config({ path: '.env.local' })

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { openai, embedMany, CHUNKING_PROMPT, EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from '../src/lib/openai.ts'
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'
import { createClient } from '@supabase/supabase-js'

interface RawVerse { book: string; chapter: number; verse: number; text: string; book_num?: number }
interface ChunkOutput { chapter_numbers: number[]; verse_numbers: number[]; combined_text: string; verses: { chapter: number; verse: number }[] }

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.warn('Warning: Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY; DB writes will fail unless provided. For dry runs, this is fine.')
}
if (!process.env.OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY in environment. Set it in .env.local or shell.')
  process.exit(1)
}
const SUPABASE_URL = process.env.SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const sb = (SUPABASE_URL && SUPABASE_KEY) ? createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } }) : (null as any)

let MAX_RETRIES = 3
let INITIAL_BACKOFF_MS = 300
let THROTTLE_MS = 0
function sleep(ms: number) { return new Promise(res => setTimeout(res, ms)) }
function isRetryableError(err: any): boolean {
  if (!err) return false
  const msg = (typeof err === 'string' ? err : (err.message || err.details || err.hint || '')) as string
  const code = (err.status || err.code || '') as any
  if (typeof code === 'number' && (code >= 500 || code === 429)) return true
  if (typeof code === 'string' && (/^5\d\d$/.test(code) || code === '429')) return true
  if (/Failed to fetch|ECONNRESET|ENOTFOUND|ETIMEDOUT|fetch failed|network|timeout|Cloudflare/i.test(msg)) return true
  return false
}
async function supabaseRetry<T>(fn: () => Promise<T & { error?: any; status?: number }>, label: string): Promise<T> {
  if (!sb) throw new Error('Supabase client not initialized')
  let attempt = 0
  let backoff = INITIAL_BACKOFF_MS
  for (;;) {
    attempt++
    if (THROTTLE_MS > 0) await sleep(THROTTLE_MS)
    try {
      const res: any = await fn()
      if (!res || !res.error) return res as T
      if (!isRetryableError(res.error) || attempt >= MAX_RETRIES) {
        throw res.error
      }
      console.warn(`[retry] ${label} failed (attempt ${attempt}) -> ${(res.error?.message||res.error)}`)
    } catch (e: any) {
      if (!isRetryableError(e) || attempt >= MAX_RETRIES) throw e
      console.warn(`[retry] ${label} threw (attempt ${attempt}) -> ${(e?.message||e)}`)
    }
    const jitter = Math.floor(Math.random() * (backoff * 0.5))
    const wait = Math.min(5000, backoff + jitter)
    await sleep(wait)
    backoff *= 2
  }
}

function parseArgs() {
  const args = process.argv.slice(2)
  const out: Record<string,string|boolean> = {}
  for (let i=0;i<args.length;i++) {
    const token = args[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    let collected: string[] = []
    for (let j=i+1; j<args.length; j++) {
      if (args[j].startsWith('--')) break
      collected.push(args[j])
    }
    if (!collected.length) { out[key] = 'true'; continue }
    i += collected.length
    let value = collected.join(' ')
    if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
      value = value.slice(1,-1)
    }
    out[key] = value
  }
  return out
}
function ensureDir(p: string) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }) }

// Known ordered books list for BOM (canonical titles)
const BOM_BOOKS_ORDER = [
  'TITLE PAGE',
  'THE TESTIMONY OF THREE WITNESSES',
  'THE TESTIMONY OF EIGHT WITNESSES',
  'THE FIRST BOOK OF NEPHI HIS REIGN AND MINISTRY',
  'THE SECOND BOOK OF NEPHI',
  'THE BOOK OF JACOB',
  'THE BOOK OF ENOS',
  'THE BOOK OF JAROM',
  'THE BOOK OF OMNI',
  'THE WORDS OF MORMON',
  'THE BOOK OF MOSIAH',
  'THE BOOK OF ALMA',
  'THE BOOK OF HELAMAN',
  'THIRD BOOK OF NEPHI',
  'FOURTH NEPHI',
  'THE BOOK OF MORMON',
  'THE BOOK OF ETHER',
  'THE BOOK OF MORONI'
]

// Parser for Book of Mormon: detects book titles from BOM_BOOKS_ORDER, captures introductions as chapter 0, verse 0,
// chapters marked like "1 Nephi Chapter 1" and verses "1:1 ..."
function normalizeHeaderLine(s: string): string {
  // Uppercase, collapse spaces, strip parentheticals, normalize numbers words
  let t = s.toUpperCase().replace(/\s+/g, ' ').trim()
  t = t.replace(/\([^)]*\)\s*$/,'').trim() // remove trailing ( ... )
  t = t.replace(/\bTHREE\b/g, '3').replace(/\bEIGHT\b/g, '8')
  return t
}

function parseBookOfMormonText(filePath: string): RawVerse[] {
  const text = fs.readFileSync(filePath, 'utf8')
  const lines = text.split(/\r?\n/)
  const verses: RawVerse[] = []
  let currentBook = ''
  let currentChapter = 0
  let introBuf: string[] = []
  // Track an in-progress verse to capture wrapped continuation lines
  let pendingVerse: { ch: number; vs: number; parts: string[] } | null = null

  // Prepare regexes allowing optional parenthetical and numeric/word forms
  const bookTitleRegexes = [
    { title: 'TITLE PAGE', re: /^TITLE PAGE$/i },
    { title: 'THE TESTIMONY OF THREE WITNESSES', re: /^THE TESTIMONY OF (?:THREE|3) WITNESSES$/i },
    { title: 'THE TESTIMONY OF EIGHT WITNESSES', re: /^THE TESTIMONY OF (?:EIGHT|8) WITNESSES$/i },
    { title: 'THE FIRST BOOK OF NEPHI HIS REIGN AND MINISTRY', re: /^THE FIRST BOOK OF NEPHI HIS REIGN AND MINISTRY(?:\s*\(.*\))?$/i },
    { title: 'THE SECOND BOOK OF NEPHI', re: /^THE SECOND BOOK OF NEPHI(?:\s*\(.*\))?$/i },
    { title: 'THE BOOK OF JACOB', re: /^THE BOOK OF JACOB$/i },
    { title: 'THE BOOK OF ENOS', re: /^THE BOOK OF ENOS$/i },
    { title: 'THE BOOK OF JAROM', re: /^THE BOOK OF JAROM$/i },
    { title: 'THE BOOK OF OMNI', re: /^THE BOOK OF OMNI$/i },
    { title: 'THE WORDS OF MORMON', re: /^THE WORDS OF MORMON$/i },
    { title: 'THE BOOK OF MOSIAH', re: /^THE BOOK OF MOSIAH$/i },
    { title: 'THE BOOK OF ALMA', re: /^THE BOOK OF ALMA$/i },
    { title: 'THE BOOK OF HELAMAN', re: /^THE BOOK OF HELAMAN$/i },
    { title: 'THIRD BOOK OF NEPHI', re: /^THIRD BOOK OF NEPHI$/i },
    { title: 'FOURTH NEPHI', re: /^FOURTH NEPHI$/i },
    { title: 'THE BOOK OF MORMON', re: /^THE BOOK OF MORMON$/i },
    { title: 'THE BOOK OF ETHER', re: /^THE BOOK OF ETHER$/i },
    { title: 'THE BOOK OF MORONI', re: /^THE BOOK OF MORONI$/i },
  ]
  const chapterHeaderRe = /^(?:\d+\s+)?([A-Za-z][A-Za-z ]+)\s+Chapter\s+(\d+)\s*$/i
  const verseLineRe = /^(\d+):(\d+)\s+(.*)$/
  // Handles lines like "3 Nephi 1:1 ..." or "4 Nephi 1:2 ..."
  const nephiVerseRe = /^(\d+)\s+NEPHI\s+(\d+):(\d+)\s+(.*)$/i

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue
    // book headers
    const bookHit = bookTitleRegexes.find(b => b.re.test(line))
    if (bookHit) {
      // Flush any pending verse for previous book
      if (pendingVerse && currentBook) {
        verses.push({ book: currentBook, chapter: pendingVerse.ch, verse: pendingVerse.vs, text: pendingVerse.parts.join(' ').trim() })
      }
      pendingVerse = null
      // Flush previous book introduction if present
      if (currentBook && introBuf.length) {
        const introText = introBuf.join(' ').trim()
        if (introText) verses.push({ book: currentBook, chapter: 0, verse: 0, text: introText })
      }
      // Start new book
      currentBook = bookHit.title
      currentChapter = 0
      introBuf = []
      continue
    }

    const chMatch = line.match(chapterHeaderRe)
    if (chMatch) {
      // On chapter header, flush any pending verse and any introduction (chapter 0, verse 0)
      if (pendingVerse && currentBook) {
        verses.push({ book: currentBook, chapter: pendingVerse.ch, verse: pendingVerse.vs, text: pendingVerse.parts.join(' ').trim() })
      }
      pendingVerse = null
      if (currentBook && introBuf.length) {
        const introText = introBuf.join(' ').trim()
        if (introText) verses.push({ book: currentBook, chapter: 0, verse: 0, text: introText })
        introBuf = []
      }
      currentChapter = Number(chMatch[2])
      continue
    }

    // Match standard verse lines (e.g., 1:1 ...) or Nephi-form (e.g., 4 NEPHI 1:1 ...)
    let vMatch = line.match(verseLineRe)
    let isNephiForm = false
    if (!vMatch) {
      const nMatch = line.match(nephiVerseRe)
      if (nMatch) { isNephiForm = true; vMatch = [nMatch[0], nMatch[2], nMatch[3], nMatch[4]] as any }
    }
    if (vMatch && currentBook) {
      const [, chStr, vsStr, verseText] = vMatch
      const ch = Number(chStr)
      const vs = Number(vsStr)
      // Flush any previous pending verse before starting a new one
      if (pendingVerse) {
        verses.push({ book: currentBook, chapter: pendingVerse.ch, verse: pendingVerse.vs, text: pendingVerse.parts.join(' ').trim() })
      }
      // Start new pending verse and capture wrapped lines until next verse/header
      // For Nephi-form lines, the chapter is explicit in ch; set currentChapter if still 0
      const effectiveChapter = ch || currentChapter
      if (currentChapter === 0 && effectiveChapter > 0) currentChapter = effectiveChapter
      pendingVerse = { ch: effectiveChapter, vs, parts: [verseText] }
      continue
    }
    // Non-verse/non-chapter line: either continuation of current verse or part of introduction before first verse
    if (currentBook) {
      if (pendingVerse) {
        pendingVerse.parts.push(line)
        continue
      }
      // Collect introduction/prose only before the first verse (currentChapter===0)
      if (currentChapter === 0) {
        introBuf.push(line)
      }
    }
  }
  // Flush any trailing introduction for the last book
  if (pendingVerse && currentBook) {
    verses.push({ book: currentBook, chapter: pendingVerse.ch, verse: pendingVerse.vs, text: pendingVerse.parts.join(' ').trim() })
  }
  if (currentBook && introBuf.length) {
    const introText = introBuf.join(' ').trim()
    if (introText) verses.push({ book: currentBook, chapter: 0, verse: 0, text: introText })
  }
  return verses
}

function groupByBook(raw: RawVerse[]): Map<string, RawVerse[]> {
  const m = new Map<string, RawVerse[]>()
  for (const v of raw) { if (!m.has(v.book)) m.set(v.book, []); m.get(v.book)!.push(v) }
  return m
}

async function chunkChapter(book: string, chapterNumber: number, verses: RawVerse[], chunkModel?: string): Promise<ChunkOutput[]> {
  const payload = { book, chapter: chapterNumber, verses: verses.map(v => ({ verse: v.verse, text: v.text })) }
  const messages: ChatCompletionMessageParam[] = [ { role: 'system', content: CHUNKING_PROMPT }, { role: 'user', content: JSON.stringify(payload) } ]
  const completion = await openai.chat.completions.create({ model: chunkModel || process.env.OPENAI_CHUNK_MODEL || 'gpt-4.1-mini', messages, temperature: 0 })
  let raw = completion.choices[0]?.message?.content?.trim() || ''
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) raw = fence[1].trim()
  const parsed = JSON.parse(raw)
  if (!parsed.chunks || !Array.isArray(parsed.chunks)) throw new Error('Invalid chunk output')
  const verseMap = new Map<number,string>()
  for (const v of verses) verseMap.set(v.verse, v.text)
  const out: ChunkOutput[] = []
  for (const c of parsed.chunks) {
    let vnums: number[] = Array.isArray(c.verse_numbers) ? c.verse_numbers.map((n: any)=>Number(n)).filter((n: number)=>Number.isFinite(n)) : []
    vnums = Array.from(new Set(vnums.filter(n=>verseMap.has(n)))).sort((a,b)=>a-b)
    if (!vnums.length) continue
    const combined = vnums.map(n=>verseMap.get(n)!).join(' ')
    out.push({ chapter_numbers: vnums.map(()=>chapterNumber), verse_numbers: vnums, combined_text: combined, verses: vnums.map(n=>({ chapter: chapterNumber, verse: n })) })
  }
  return out
}

function heuristicChunkChapter(chapterNumber: number, verses: RawVerse[]): ChunkOutput[] {
  const chunks: ChunkOutput[] = []
  const targetMinVerses = 3, targetMaxVerses = 10, targetMinChars = 300, targetMaxChars = 600
  let buf: RawVerse[] = []; let bufChars = 0
  const flush = () => { if (!buf.length) return; const combined = buf.map(v=>v.text).join(' '); chunks.push({ chapter_numbers: buf.map(()=>chapterNumber), verse_numbers: buf.map(v=>v.verse), combined_text: combined, verses: buf.map(v=>({ chapter: chapterNumber, verse: v.verse })) }); buf = []; bufChars = 0 }
  const strongEndRe = /[.!?;:][”'")\]]*\s*$/
  const softStartRe = /^(And|But|Then|For|So|Thus|Therefore|Behold|Now)\b/i
  for (const v of verses) {
    const txt = v.text.trim()
    const willExceedMax = (bufChars + (buf.length ? 1 : 0) + txt.length) > targetMaxChars || (buf.length + 1) > targetMaxVerses
    const hasEnough = buf.length >= targetMinVerses && (bufChars >= targetMinChars)
    if (willExceedMax || (hasEnough && strongEndRe.test(buf[buf.length-1]?.text || '') && softStartRe.test(txt))) flush()
    buf.push(v); bufChars += (bufChars ? 1 : 0) + txt.length
    if (buf.length === targetMaxVerses) flush()
  }
  flush()
  if (chunks.length >= 2 && chunks[chunks.length-1].verse_numbers.length < targetMinVerses) {
    const tail = chunks.pop()!; const prev = chunks.pop()!; const mergedVerses = [...prev.verses, ...tail.verses]
    chunks.push({ chapter_numbers: mergedVerses.map(()=>chapterNumber), verse_numbers: mergedVerses.map(v=>v.verse), combined_text: mergedVerses.map(v=>verses.find(x=>x.verse===v.verse)!.text).join(' '), verses: mergedVerses })
  }
  return chunks
}

// BOM-specific cache dir
const CHUNK_CACHE_DIR = path.join('data','chunks_cache_bom')
function chapterCachePath(book: string, chapterNumber: number) { const safeBook = book.replace(/[\\/:*?"<>|]/g, '_'); return path.join(CHUNK_CACHE_DIR, `${safeBook}_ch${chapterNumber}.json`) }
function validateChapterCoverage(chunks: ChunkOutput[], verses: RawVerse[]) {
  const expected = verses.map(v=>v.verse).sort((a,b)=>a-b)
  const got = Array.from(new Set(chunks.flatMap(c=>c.verse_numbers))).sort((a,b)=>a-b)
  if (expected.length !== got.length) return false
  for (let i=0;i<expected.length;i++) if (expected[i]!==got[i]) return false
  return true
}
function loadCachedChapter(book: string, chapterNumber: number, verses: RawVerse[]): ChunkOutput[] | null {
  try { const p = chapterCachePath(book, chapterNumber); if (!fs.existsSync(p)) return null; const cached = JSON.parse(fs.readFileSync(p,'utf8')) as { chunks: ChunkOutput[] }; if (!cached?.chunks || !Array.isArray(cached.chunks)) return null; if (!validateChapterCoverage(cached.chunks, verses)) return null; return cached.chunks } catch { return null }
}
function saveCachedChapter(book: string, chapterNumber: number, chunks: ChunkOutput[]) { ensureDir(CHUNK_CACHE_DIR); fs.writeFileSync(chapterCachePath(book, chapterNumber), JSON.stringify({ chunks }, null, 2)) }

async function ensureSourceAndTradition(sourceName: string, traditionName: string) {
  const { data: tradRows } = await supabaseRetry(async () => await sb.from('traditions').select('id').eq('name', traditionName).limit(1), 'select traditions') as any
  let traditionId = tradRows?.[0]?.id as string | undefined
  if (!traditionId) { const { data } = await supabaseRetry(async () => await sb.from('traditions').insert({ name: traditionName }).select('id').single(), 'insert tradition') as any; traditionId = data.id }
  const { data: srcRows } = await supabaseRetry(async () => await sb.from('sources').select('id').eq('tradition_id', traditionId).eq('name', sourceName).limit(1), 'select sources') as any
  let sourceId = srcRows?.[0]?.id as string | undefined
  if (!sourceId) { const { data } = await supabaseRetry(async () => await sb.from('sources').insert({ tradition_id: traditionId, name: sourceName }).select('id').single(), 'insert source') as any; sourceId = data.id }
  return { traditionId, sourceId }
}
async function upsertMetadata(sourceId: string, workName: string, booksOrder: string[]) {
  const { data: workRows } = await supabaseRetry(async () => await sb.from('works').select('id,name').eq('source_id', sourceId).eq('name', workName).limit(1), 'select work') as any
  let workId = workRows?.[0]?.id
  if (!workId) { const { data } = await supabaseRetry(async () => await sb.from('works').insert({ source_id: sourceId, name: workName }).select('id').single(), 'insert work') as any; workId = data.id }
  const bookIdMap: Record<string,string> = {}
  for (let i=0;i<booksOrder.length;i++) {
    const title = booksOrder[i]; const seq = i+1
    const { data: existing } = await supabaseRetry(async () => await sb.from('books').select('id').eq('work_id', workId!).eq('seq', seq).limit(1), 'select book') as any
    if (!existing?.[0]) { const { data } = await supabaseRetry(async () => await sb.from('books').insert({ work_id: workId!, seq, title }).select('id').single(), 'insert book') as any; bookIdMap[title] = data.id } else { bookIdMap[title] = existing[0].id }
  }
  return { workId, bookIdMap }
}
async function ensureChapter(bookId: string, chapterSeq: number) {
  const { data: existing } = await supabaseRetry(async () => await sb.from('chapters').select('id').eq('book_id', bookId).eq('seq', chapterSeq).limit(1), 'select chapter') as any
  if (existing?.[0]) return existing[0].id as string
  const { data } = await supabaseRetry(async () => await sb.from('chapters').insert({ book_id: bookId, seq: chapterSeq }).select('id').single(), 'insert chapter') as any
  return data.id as string
}
async function insertChunk(bookId: string, c: ChunkOutput, force: boolean, embeddingVec?: number[]) {
  const startChapter = Math.min(...c.chapter_numbers)
  const endChapter = Math.max(...c.chapter_numbers)
  const combined_hash = crypto.createHash('sha256').update(`${bookId}|${c.chapter_numbers.join(',')}|${c.verse_numbers.join(',')}`).digest('hex')
  if (!force) {
    const { data: existing } = await supabaseRetry(async () => await sb.from('embedding_chunks').select('id').eq('combined_hash', combined_hash).limit(1), 'select embedding_chunk by hash') as any
    if (existing && existing[0]?.id) return existing[0].id as string
  }
  const embedding = embeddingVec ?? (await embedMany([c.combined_text]))[0]
  try {
    const { data } = await supabaseRetry(async () => await sb.from('embedding_chunks').insert({ book_id: bookId, start_chapter: startChapter, end_chapter: endChapter, verse_numbers: c.verse_numbers, chapter_numbers: c.chapter_numbers, combined_text: c.combined_text, embedding, combined_hash }).select('id').single(), 'insert embedding_chunk') as any
    return data.id as string
  } catch (e: any) {
    const { data: existing } = await supabaseRetry(async () => await sb.from('embedding_chunks').select('id').eq('combined_hash', combined_hash).limit(1), 'select embedding_chunk after duplicate') as any
    if (existing && existing[0]?.id) return existing[0].id as string
    throw e
  }
}
async function upsertVerse(bookId: string, chapterSeq: number, verseSeq: number, text: string, chunkId: string) {
  await supabaseRetry(async () => await sb.from('verses').upsert({ book_id: bookId, chapter_seq: chapterSeq, verse_seq: verseSeq, text, chunk_id: chunkId }, { onConflict: 'book_id,chapter_seq,verse_seq' }), 'upsert verse')
}

async function main() {
  const args = parseArgs()
  const bomTxt = args['bomTxt'] as string
  if (!bomTxt) throw new Error('--bomTxt path required')
  const workName = (args['workName'] as string) || 'The Book of Mormon'
  const sourceName = (args['sourceName'] as string) || 'Project Gutenberg'
  const traditionName = (args['traditionName'] as string) || 'Latter-day Saint'
  const bookFilter = (args['bookFilter'] as string) || ''
  const startAt = (args['startAt'] as string) || ''
  const force = args['force'] === 'true'
  const dryRun = args['dryRun'] === 'true'
  const noChunkGPT = args['noChunkGPT'] === 'true'
  const cacheChunks = args['cacheChunks'] === 'false' ? false : true
  const chunkModel = (args['chunkModel'] as string) || undefined
  const embedFromCache = args['embedFromCache'] === 'true'
  const parseOnly = args['parseOnly'] === 'true'
  const useParsedDir = (args['useParsedDir'] as string) || ''
  const maxRetriesArg = args['maxRetries'] as string | undefined
  const throttleMsArg = args['throttleMs'] as string | undefined
  const initialBackoffMsArg = args['initialBackoffMs'] as string | undefined

  if (maxRetriesArg !== undefined) MAX_RETRIES = Math.max(1, Number(maxRetriesArg) || 3)
  if (throttleMsArg !== undefined) THROTTLE_MS = Math.max(0, Number(throttleMsArg) || 0)
  if (initialBackoffMsArg !== undefined) INITIAL_BACKOFF_MS = Math.max(50, Number(initialBackoffMsArg) || 300)

  const mask = (v?: string) => v ? (v.length <= 12 ? v : v.slice(0,4)+'…'+v.slice(-4)) : 'MISSING'
  console.log('BOM Ingest starting', { bomTxt, workName, sourceName, traditionName, bookFilter, startAt, force, dryRun, noChunkGPT, cacheChunks, embedFromCache, chunkModel: chunkModel || process.env.OPENAI_CHUNK_MODEL || 'gpt-4.1-mini', model: EMBEDDING_MODEL, dims: EMBEDDING_DIMENSIONS, maxRetries: MAX_RETRIES, throttleMs: THROTTLE_MS, initialBackoffMs: INITIAL_BACKOFF_MS, SUPABASE_URL: process.env.SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: mask(process.env.SUPABASE_SERVICE_ROLE_KEY), OPENAI_API_KEY: mask(process.env.OPENAI_API_KEY) })

  let rawVerses: RawVerse[] = []
  if (useParsedDir) {
    // Load previously parsed per-book JSONs
    const files = fs.readdirSync(useParsedDir).filter(f=>f.endsWith('.json'))
    for (const f of files) {
      try {
        const o = JSON.parse(fs.readFileSync(path.join(useParsedDir, f),'utf8')) as { book: string; chapters: Record<number, RawVerse[]> }
        for (const chStr of Object.keys(o.chapters)) {
          for (const v of o.chapters[Number(chStr)]) rawVerses.push({ ...v, book: o.book })
        }
      } catch (e) { console.warn('[useParsedDir] failed to read', f, (e as Error).message) }
    }
  } else {
    rawVerses = parseBookOfMormonText(bomTxt)
  }
  if (!rawVerses.length) throw new Error('No verses parsed from BOM text')
  const byBook = groupByBook(rawVerses)
  // Establish order by known list; keep only detected books
  const parsedBooks = Array.from(byBook.keys())
  const booksOrder = BOM_BOOKS_ORDER.filter(b => parsedBooks.includes(b))
  const orderedBooks = (() => { if (!startAt) return booksOrder; const idx = booksOrder.indexOf(startAt); return idx >= 0 ? booksOrder.slice(idx) : booksOrder })()

  let bookIdMap: Record<string,string> = {}
  let workId: string | undefined
  if (!dryRun && sb) {
    const { sourceId } = await ensureSourceAndTradition(sourceName, traditionName)
    const meta = await upsertMetadata(sourceId!, workName, booksOrder)
    bookIdMap = meta.bookIdMap
    workId = meta.workId
  } else {
    bookIdMap = booksOrder.reduce((acc,b)=>{ acc[b] = 'dry-'+b.replace(/\s+/g,'-'); return acc }, {} as Record<string,string>)
  }

  ensureDir(path.join('data','books_bom'))
  ensureDir(path.join('data','chunks_bom'))
  ensureDir(CHUNK_CACHE_DIR)

  const totalVersesAll = rawVerses.length
  let processedVerses = 0

  for (const book of orderedBooks) {
    if (bookFilter && book !== bookFilter) continue
    const verses = byBook.get(book)!
    const bookOut = { book, chapters: verses.reduce<Record<number, RawVerse[]>>((acc, v) => { (acc[v.chapter] ||= []).push(v); return acc }, {}) }
    fs.writeFileSync(path.join('data','books_bom', `${book}.json`), JSON.stringify(bookOut, null, 2))

    if (parseOnly) { console.log('[parseOnly] wrote', `data/books_bom/${book}.json`); processedVerses += verses.length; continue }

    const allChunks: ChunkOutput[] = []
    // Include chapter 0 (introductions) as a single chunk [0:0]
    const chapterKeys = Object.keys(bookOut.chapters).map(n=>Number(n))
    if (chapterKeys.includes(0)) {
      const introVerses = bookOut.chapters[0]
      const introText = introVerses.map(v=>v.text).join(' ').trim()
      if (introText) {
        allChunks.push({
          chapter_numbers: [0],
          verse_numbers: [0],
          combined_text: introText,
          verses: [{ chapter: 0, verse: 0 }]
        })
      }
    }
    for (const chapterNumber of chapterKeys.filter(n=>n>0).sort((a,b)=>a-b)) {
      const chapterVerses = bookOut.chapters[chapterNumber]
      if (embedFromCache || noChunkGPT) {
        const cached = loadCachedChapter(book, chapterNumber, chapterVerses)
        if (cached) { allChunks.push(...cached); continue }
        if (noChunkGPT) { const chChunks = heuristicChunkChapter(chapterNumber, chapterVerses); allChunks.push(...chChunks); if (cacheChunks) saveCachedChapter(book, chapterNumber, chChunks); continue }
      }
      try {
        let chapterChunks: ChunkOutput[] | null = null
        if (cacheChunks) chapterChunks = loadCachedChapter(book, chapterNumber, chapterVerses)
        if (!chapterChunks) { chapterChunks = await chunkChapter(book, chapterNumber, chapterVerses, chunkModel); if (cacheChunks) saveCachedChapter(book, chapterNumber, chapterChunks) }
        allChunks.push(...chapterChunks)
      } catch (e) {
        console.error('Chunking failed, fallback heuristic', book, chapterNumber, (e as Error).message)
        const chChunks = heuristicChunkChapter(chapterNumber, chapterVerses)
        allChunks.push(...chChunks)
      }
    }

    fs.writeFileSync(path.join('data','chunks_bom', `${book}.json`), JSON.stringify({ book, chunks: allChunks }, null, 2))

    if (dryRun || !sb) { console.log('[dryRun] Skipping DB inserts for book', book); continue }

    const bookId = bookIdMap[book]
    const chapterNums = Array.from(new Set(verses.map(v=>v.chapter))).sort((a,b)=>a-b)
    for (const ch of chapterNums) await ensureChapter(bookId, ch)

    const embeddings = await embedMany(allChunks.map(c=>c.combined_text))
    for (let idx=0; idx<allChunks.length; idx++) {
      const chunk = allChunks[idx]
      const chunkId = await insertChunk(bookId, chunk, force, embeddings[idx])
      for (const v of chunk.verses) {
        const verseObj = verses.find(r=>r.chapter===v.chapter && r.verse===v.verse)
        if (!verseObj) continue
        await upsertVerse(bookId, v.chapter, v.verse, verseObj.text, chunkId)
      }
    }
    processedVerses += verses.length
    const pct = ((processedVerses / totalVersesAll) * 100).toFixed(2)
    console.log(`Completed book ${book} (${processedVerses}/${totalVersesAll} verses, ${pct}% )`)
  }

  console.log('BOM ingestion complete.')
}

main().catch(e => { console.error(e); process.exit(1) })
