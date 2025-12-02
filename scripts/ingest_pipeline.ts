/*
Ingestion & Chunking Pipeline
=============================
Usage (PowerShell):
  $env:OPENAI_API_KEY="sk-..."
  node scripts/ingest_pipeline.js --bibleTxt data/kjv_raw.txt --workName "King James Bible" --bookFilter "Genesis" --dryRun

Steps:
1. Parse raw KJV .txt into structured { book -> chapters -> verses }.
2. For each chapter call GPT to produce semantic chunks (3-10 verses) using CHUNKING_PROMPT.
3. Accumulate chunk objects per book, persist JSON to disk under data/chunks/<book>.json.
4. Generate 512-dim embeddings for each chunk (text-embedding-3-small, dimensions:512).
5. Insert books/chapters/verses/chunks rows into Supabase (idempotent: upserts by natural keys).
6. Link each verse to its chunk_id.

Raw Bible File Format Expectation:
----------------------------------
File lines in one of these forms (flexible parser attempts detection):
  Genesis 1:1 In the beginning God created the heaven and the earth.
OR
  1:1 In the beginning God created the heaven and the earth. (when a current book context is maintained)
If your file differs, adjust parseBibleText().

Idempotency Strategy:
---------------------
- We first ensure a work row exists (by name).
- For each book, ensure book row exists (by work_id + seq).
- For each chapter ensure chapter row exists (book_id + seq).
- For chunks: deterministic hash (sha256) of book + chapter_numbers + verse_numbers used as natural key; if exists, skip embedding reinsertion unless --force.
- For verses: upsert on (book_id, chapter_seq, verse_seq); then update chunk_id.

CLI Flags:
---------
--bibleTxt <path> (required)
--workName <string> default: "Bible"
--bookFilter <BookName> only ingest that book
--force  regenerate embeddings and overwrite chunks
--dryRun no writes, only logs & local JSON outputs

Outputs:
--------
- data/books/<Book>.json   parsed verses structure.
- data/chunks/<Book>.json  chunking result for that book.

Requires:
---------
- Node 18+
- OPENAI_API_KEY env var
- SUPABASE_URL & SUPABASE_SERVICE_ROLE_KEY env vars (for writes)
*/

// Load environment variables from both .env and .env.local (Next.js keeps secrets in .env.local)
import dotenv from 'dotenv'
dotenv.config({ path: '.env' })
dotenv.config({ path: '.env.local' })

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
// NOTE: ESM + ts-node requires explicit .js extension mapping to TS source.
// Import TS module without forced .js extension so ts-node ESM loader can transpile on-the-fly
// Explicit .ts extension for NodeNext/ts-node ESM resolution under Node 22
import { openai, embedMany, CHUNKING_PROMPT, EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from '../src/lib/openai.ts'
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'
import { createClient } from '@supabase/supabase-js'

interface RawVerse { book: string; chapter: number; verse: number; text: string; book_num?: number }
interface ChunkOutput { chapter_numbers: number[]; verse_numbers: number[]; combined_text: string; verses: { chapter: number; verse: number }[] }

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment. Set them in .env.local or shell.')
  process.exit(1)
}
if (!process.env.OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY in environment. Set it in .env.local or shell.')
  process.exit(1)
}
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } })

// -------- Retry/Backoff & Throttling for Supabase calls --------
let MAX_RETRIES = 3
let INITIAL_BACKOFF_MS = 300
let THROTTLE_MS = 0

function sleep(ms: number) { return new Promise(res => setTimeout(res, ms)) }

function isRetryableError(err: any): boolean {
  if (!err) return false
  const msg = (typeof err === 'string' ? err : (err.message || err.details || err.hint || '')) as string
  const code = (err.status || err.code || '') as any
  // Retry on network/HTTP 5xx/429 or transient fetch failures
  if (typeof code === 'number' && (code >= 500 || code === 429)) return true
  if (typeof code === 'string' && (/^5\d\d$/.test(code) || code === '429')) return true
  if (/Failed to fetch|ECONNRESET|ENOTFOUND|ETIMEDOUT|fetch failed|network|timeout|Cloudflare/i.test(msg)) return true
  return false
}

async function supabaseRetry<T>(fn: () => Promise<T & { error?: any; status?: number }>, label: string): Promise<T> {
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
    // exponential backoff with jitter, capped
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
    // Collect subsequent tokens until next flag or end to allow multi-word values.
    let collected: string[] = []
    for (let j=i+1; j<args.length; j++) {
      if (args[j].startsWith('--')) break
      collected.push(args[j])
    }
    if (!collected.length) {
      out[key] = 'true'
      continue
    }
    // Advance i past consumed tokens
    i += collected.length
    let value = collected.join(' ')
    // Strip wrapping single/double quotes if present
    if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
      value = value.slice(1,-1)
    }
    out[key] = value
  }
  return out
}

function ensureDir(p: string) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }) }

// Basic parser for KJV style lines.
function parseBibleText(filePath: string): RawVerse[] {
  const text = fs.readFileSync(filePath, 'utf8')
  const lines = text.split(/\r?\n/)
  const verses: RawVerse[] = []

  // Detect Gutenberg KJV format (BOOK XX Name + verse lines XX:CCC:VVV Text)
  const isGutenberg = lines.some(l => /^BOOK\s+\d+\s+/.test(l.trim()))

  if (isGutenberg) {
    const bookNumToTitle: Record<string,string> = {}
    let currentBookNum = ''
    let currentVerseObj: RawVerse | null = null
    for (const rawLine of lines) {
      const line = rawLine.replace(/\r?\n/g,'').trim()
      if (!line) { currentVerseObj = null; continue }
      const bookHeader = line.match(/^BOOK\s+(\d+)\s+(.+)$/)
      if (bookHeader) {
        const [, num, title] = bookHeader
        currentBookNum = num.padStart(2,'0')
        bookNumToTitle[currentBookNum] = title.trim()
        currentVerseObj = null
        continue
      }
      const verseMatch = line.match(/^(\d+):(\d+):(\d+)\s+(.*)$/)
      if (verseMatch) {
        const [, bNum, chStr, vsStr, verseTextStart] = verseMatch
        const bKey = bNum.padStart(2,'0')
        const bookTitle = bookNumToTitle[bKey] || bookNumToTitle[currentBookNum] || 'Unknown'
        currentBookNum = bKey
        const chapter = Number(chStr)
        const verse = Number(vsStr)
        currentVerseObj = { book: bookTitle, chapter, verse, text: verseTextStart.trim(), book_num: Number(bNum) }
        verses.push(currentVerseObj)
        continue
      }
      // Continuation lines append to last verse (if any)
      if (currentVerseObj) {
        currentVerseObj.text += ' ' + line
      }
    }
    return verses
  }

  // Fallback legacy simple parser
  let currentBook = ''
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue
    const fullMatch = line.match(/^([A-Za-z0-9][A-Za-z0-9 .'\-]*?)\s+(\d+):(\d+)\s+(.*)$/)
    if (fullMatch) {
      let [, book, ch, vs, verseText] = fullMatch
      book = book.replace(/\s+/g,' ').trim()
      currentBook = book
      verses.push({ book, chapter: Number(ch), verse: Number(vs), text: verseText })
      continue
    }
    if (/^[A-Za-z0-9][A-Za-z0-9 '\-]*(?:\s+[A-Za-z0-9][A-Za-z0-9 '\-]*)*$/.test(line) && !/\d+:\d+/.test(line)) {
      currentBook = line.replace(/\s+/g,' ').trim()
      continue
    }
    const shortMatch = line.match(/^(\d+):(\d+)\s+(.*)$/)
    if (shortMatch && currentBook) {
      const [, ch, vs, verseText] = shortMatch
      verses.push({ book: currentBook, chapter: Number(ch), verse: Number(vs), text: verseText })
      continue
    }
  }
  return verses
}

function groupByBook(raw: RawVerse[]): Map<string, RawVerse[]> {
  const m = new Map<string, RawVerse[]>()
  for (const v of raw) {
    if (!m.has(v.book)) m.set(v.book, [])
    m.get(v.book)!.push(v)
  }
  return m
}

async function chunkChapter(book: string, chapterNumber: number, verses: RawVerse[], chunkModel?: string): Promise<ChunkOutput[]> {
  // Prepare payload for GPT chunking
  const payload = {
    book,
    chapter: chapterNumber,
    verses: verses.map(v => ({ verse: v.verse, text: v.text }))
  }
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: CHUNKING_PROMPT },
    { role: 'user', content: JSON.stringify(payload) }
  ]
  const completion = await openai.chat.completions.create({ model: chunkModel || process.env.OPENAI_CHUNK_MODEL || 'gpt-4.1-mini', messages, temperature: 0 })
  let raw = completion.choices[0]?.message?.content?.trim() || ''
  // Extract JSON if wrapped in code fences
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) raw = fence[1].trim()
  let parsed: any
  try { parsed = JSON.parse(raw) } catch { throw new Error('Chunking JSON parse failed for chapter '+chapterNumber+': '+raw.slice(0,200)) }
  if (!parsed.chunks || !Array.isArray(parsed.chunks)) throw new Error('Invalid chunk output structure')
  // Rebuild from authoritative chapter verses; then fix sizes to [3,10]
  const verseMap = new Map<number,string>()
  for (const v of verses) verseMap.set(v.verse, v.text)
  const prelim: ChunkOutput[] = []
  for (const c of parsed.chunks) {
    let vnums: number[] = []
    if (Array.isArray(c.verse_numbers)) vnums = c.verse_numbers.map((n: any)=>Number(n)).filter((n: number)=>Number.isFinite(n))
    else if (Array.isArray(c.verses)) vnums = c.verses.map((v: any)=>Number(v.verse)).filter((n: number)=>Number.isFinite(n))
    // sanitize within chapter, unique, sorted
    vnums = Array.from(new Set(vnums.filter(n=>verseMap.has(n)))).sort((a,b)=>a-b)
    if (!vnums.length) continue
    const combined = vnums.map(n=>verseMap.get(n)!).join(' ')
    prelim.push({
      chapter_numbers: vnums.map(()=>chapterNumber),
      verse_numbers: vnums,
      combined_text: combined,
      verses: vnums.map(n=>({ chapter: chapterNumber, verse: n }))
    })
  }
  // Fix sizes: split >10, merge <3 with neighbors
  const fixed: ChunkOutput[] = []
  let carrySmall: ChunkOutput | null = null
  function pushChunkFromNums(vnums: number[]) {
    const combined = vnums.map(n=>verseMap.get(n)!).join(' ')
    fixed.push({
      chapter_numbers: vnums.map(()=>chapterNumber),
      verse_numbers: vnums,
      combined_text: combined,
      verses: vnums.map(n=>({ chapter: chapterNumber, verse: n }))
    })
  }
  for (let c of prelim) {
    let vnums = c.verse_numbers.slice()
    // attach any pending small to front
    if (carrySmall) {
      vnums = Array.from(new Set([...carrySmall.verse_numbers, ...vnums])).sort((a,b)=>a-b)
      carrySmall = null
    }
    // split big chunks
    while (vnums.length > 10) {
      const head = vnums.slice(0, 8)
      pushChunkFromNums(head)
      vnums = vnums.slice(8)
    }
    // handle small
    if (vnums.length < 3) {
      // try merge with previous if room
      if (fixed.length && fixed[fixed.length-1].verse_numbers.length + vnums.length <= 10) {
        const prevV = Array.from(new Set([...fixed[fixed.length-1].verse_numbers, ...vnums])).sort((a,b)=>a-b)
        fixed.pop()
        pushChunkFromNums(prevV)
      } else {
        carrySmall = {
          chapter_numbers: vnums.map(()=>chapterNumber),
          verse_numbers: vnums,
          combined_text: '',
          verses: vnums.map(n=>({ chapter: chapterNumber, verse: n }))
        }
      }
    } else {
      pushChunkFromNums(vnums)
    }
  }
  // finalize any trailing small chunk by merging into last if needed
  if (carrySmall) {
    if (fixed.length && fixed[fixed.length-1].verse_numbers.length + carrySmall.verse_numbers.length <= 10) {
      const prevV = Array.from(new Set([...fixed[fixed.length-1].verse_numbers, ...carrySmall.verse_numbers])).sort((a,b)=>a-b)
      fixed.pop()
      pushChunkFromNums(prevV)
    } else if (fixed.length >= 1) {
      // rebalance: borrow from previous to reach 3 if possible
      let prev = fixed[fixed.length-1].verse_numbers.slice()
      while (carrySmall.verse_numbers.length < 3 && prev.length > 3) {
        const moved = prev.pop()!
        carrySmall.verse_numbers.push(moved)
        carrySmall.verse_numbers.sort((a,b)=>a-b)
      }
      fixed.pop()
      pushChunkFromNums(prev)
      if (carrySmall.verse_numbers.length >= 3 && carrySmall.verse_numbers.length <= 10) {
        pushChunkFromNums(carrySmall.verse_numbers)
      } else {
        // as last resort, merge back into previous
        const last = fixed.pop()!
        const merged = Array.from(new Set([...last.verse_numbers, ...carrySmall.verse_numbers])).sort((a,b)=>a-b)
        // split if exceeds 10
        while (merged.length > 10) {
          pushChunkFromNums(merged.splice(0,8))
        }
        pushChunkFromNums(merged)
      }
    }
  }

  return fixed
}

// Cheap heuristic chunking: aim for 3–10 verses per chunk and ~300–500 chars.
function heuristicChunkChapter(chapterNumber: number, verses: RawVerse[]): ChunkOutput[] {
  const chunks: ChunkOutput[] = []
  const targetMinVerses = 3
  const targetMaxVerses = 10
  const targetMinChars = 300
  const targetMaxChars = 600

  let buf: RawVerse[] = []
  let bufChars = 0

  const flush = () => {
    if (!buf.length) return
    const combined = buf.map(v=>v.text).join(' ')
    chunks.push({
      chapter_numbers: buf.map(()=>chapterNumber),
      verse_numbers: buf.map(v=>v.verse),
      combined_text: combined,
      verses: buf.map(v=>({ chapter: chapterNumber, verse: v.verse }))
    })
    buf = []
    bufChars = 0
  }

  const strongEndRe = /[.!?;:][”'")\]]*\s*$/
  const softStartRe = /^(And|But|Then|For|So|Thus|Therefore|Behold|Now)\b/i

  for (const v of verses) {
    const txt = v.text.trim()
    const willExceedMax = (bufChars + (buf.length ? 1 : 0) + txt.length) > targetMaxChars || (buf.length + 1) > targetMaxVerses
    const hasEnough = buf.length >= targetMinVerses && (bufChars >= targetMinChars)
    // Prefer to cut at strong punctuation when we already have enough content and next verse likely begins new thought
    if (willExceedMax || (hasEnough && strongEndRe.test(buf[buf.length-1]?.text || '') && softStartRe.test(txt))) {
      flush()
    }
    buf.push(v)
    bufChars += (bufChars ? 1 : 0) + txt.length
    if (buf.length >= targetMinVerses && (bufChars >= targetMinChars)) {
      // If current verse ends a sentence and next verse probably starts a new one, close here
      if (strongEndRe.test(txt)) {
        // Peek next: if next starts soft, maybe keep joining unless already large
        // We'll be conservative and flush when at or above min chars
        flush()
      }
    }
    // Hard split if we reached max verses
    if (buf.length === targetMaxVerses) flush()
  }
  // finalize
  flush()
  // Merge tail if last chunk too small
  if (chunks.length >= 2 && chunks[chunks.length-1].verse_numbers.length < targetMinVerses) {
    const tail = chunks.pop()!
    const prev = chunks.pop()!
    const mergedVerses = [...prev.verses, ...tail.verses]
    chunks.push({
      chapter_numbers: mergedVerses.map(()=>chapterNumber),
      verse_numbers: mergedVerses.map(v=>v.verse),
      combined_text: mergedVerses.map(v=>verses.find(x=>x.verse===v.verse)!.text).join(' '),
      verses: mergedVerses
    })
  }
  return chunks
}

// -------- Chapter-level GPT chunk cache --------
const CHUNK_CACHE_DIR = path.join('data','chunks_cache')

function chapterCachePath(book: string, chapterNumber: number) {
  const safeBook = book.replace(/[\\/:*?"<>|]/g, '_')
  return path.join(CHUNK_CACHE_DIR, `${safeBook}_ch${chapterNumber}.json`)
}

function validateChapterCoverage(chunks: ChunkOutput[], verses: RawVerse[]) {
  const expected = verses.map(v=>v.verse).sort((a,b)=>a-b)
  const got = Array.from(new Set(chunks.flatMap(c=>c.verse_numbers))).sort((a,b)=>a-b)
  if (expected.length !== got.length) return false
  for (let i=0;i<expected.length;i++) if (expected[i]!==got[i]) return false
  return true
}

function loadCachedChapter(book: string, chapterNumber: number, verses: RawVerse[]): ChunkOutput[] | null {
  try {
    const p = chapterCachePath(book, chapterNumber)
    if (!fs.existsSync(p)) return null
    const cached = JSON.parse(fs.readFileSync(p,'utf8')) as { chunks: ChunkOutput[] }
    if (!cached || !cached.chunks || !Array.isArray(cached.chunks)) return null
    // quick validation of coverage
    if (!validateChapterCoverage(cached.chunks, verses)) return null
    return cached.chunks
  } catch {
    return null
  }
}

function saveCachedChapter(book: string, chapterNumber: number, chunks: ChunkOutput[]) {
  ensureDir(CHUNK_CACHE_DIR)
  fs.writeFileSync(chapterCachePath(book, chapterNumber), JSON.stringify({ chunks }, null, 2))
}

function deterministicChunkHash(book: string, c: ChunkOutput) {
  const key = `${book}|${c.chapter_numbers.join(',')}|${c.verse_numbers.join(',')}`
  return crypto.createHash('sha256').update(key).digest('hex')
}

async function ensureSourceAndTradition(sourceName: string, traditionName: string) {
  // Tradition
  let { data: tradRows } = await supabaseRetry(async () => await sb.from('traditions').select('id').eq('name', traditionName).limit(1), 'select traditions') as any
  let traditionId = tradRows?.[0]?.id as string | undefined
  if (!traditionId) {
    const { data } = await supabaseRetry(async () => await sb.from('traditions').insert({ name: traditionName }).select('id').single(), 'insert tradition') as any
    traditionId = data.id
  }
  // Source
  let { data: srcRows } = await supabaseRetry(async () => await sb.from('sources').select('id').eq('tradition_id', traditionId).eq('name', sourceName).limit(1), 'select sources') as any
  let sourceId = srcRows?.[0]?.id as string | undefined
  if (!sourceId) {
    const { data } = await supabaseRetry(async () => await sb.from('sources').insert({ tradition_id: traditionId, name: sourceName }).select('id').single(), 'insert source') as any
    sourceId = data.id
  }
  return { traditionId, sourceId }
}

async function upsertMetadata(sourceId: string, workName: string, booksOrder: string[]) {
  // Work
  let { data: workRows } = await supabaseRetry(async () => await sb.from('works').select('id,name').eq('source_id', sourceId).eq('name', workName).limit(1), 'select work') as any
  let workId = workRows?.[0]?.id
  if (!workId) {
    const { data } = await supabaseRetry(async () => await sb.from('works').insert({ source_id: sourceId, name: workName }).select('id').single(), 'insert work') as any
    workId = data.id
  }
  // Books
  const bookIdMap: Record<string,string> = {}
  for (let i=0;i<booksOrder.length;i++) {
    const title = booksOrder[i]
    const seq = i+1
    const { data: existing } = await supabaseRetry(async () => await sb.from('books').select('id').eq('work_id', workId!).eq('seq', seq).limit(1), 'select book') as any
    if (!existing?.[0]) {
      const { data } = await supabaseRetry(async () => await sb.from('books').insert({ work_id: workId!, seq, title }).select('id').single(), 'insert book') as any
      bookIdMap[title] = data.id
    } else {
      bookIdMap[title] = existing[0].id
    }
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
  // Determine chapter bounds
  const startChapter = Math.min(...c.chapter_numbers)
  const endChapter = Math.max(...c.chapter_numbers)
  const combined_hash = crypto.createHash('sha256').update(`${bookId}|${c.chapter_numbers.join(',')}|${c.verse_numbers.join(',')}`).digest('hex')
  if (!force) {
    const { data: existing } = await supabaseRetry(
      async () =>
        await sb
          .from('embedding_chunks')
          .select('id')
          .eq('combined_hash', combined_hash)
          .limit(1),
      'select embedding_chunk by hash'
    ) as any
    if (existing && existing[0]?.id) return existing[0].id as string
  }

  // Embed (use provided vector if available)
  const embedding = embeddingVec ?? (await embedMany([c.combined_text]))[0]

  // Insert; if unique violation on combined_hash occurs, re-select existing
  try {
    const { data } = await supabaseRetry(
      async () =>
        await sb
          .from('embedding_chunks')
          .insert({
            book_id: bookId,
            start_chapter: startChapter,
            end_chapter: endChapter,
            verse_numbers: c.verse_numbers,
            chapter_numbers: c.chapter_numbers,
            combined_text: c.combined_text,
            embedding,
            combined_hash
          })
          .select('id')
          .single(),
      'insert embedding_chunk'
    ) as any
    return data.id as string
  } catch (e: any) {
    const { data: existing } = await supabaseRetry(
      async () =>
        await sb
          .from('embedding_chunks')
          .select('id')
          .eq('combined_hash', combined_hash)
          .limit(1),
      'select embedding_chunk after duplicate'
    ) as any
    if (existing && existing[0]?.id) return existing[0].id as string
    throw e
  }
}

async function upsertVerse(bookId: string, chapterSeq: number, verseSeq: number, text: string, chunkId: string) {
  // Use atomic UPSERT to avoid duplicate-key errors during retries.
  await supabaseRetry(
    async () =>
      await sb
        .from('verses')
        .upsert(
          { book_id: bookId, chapter_seq: chapterSeq, verse_seq: verseSeq, text, chunk_id: chunkId },
          { onConflict: 'book_id,chapter_seq,verse_seq' }
        ),
    'upsert verse'
  )
}

async function main() {
  const args = parseArgs()
  const bibleTxt = args['bibleTxt'] as string
  if (!bibleTxt) throw new Error('--bibleTxt path required')
  const workName = (args['workName'] as string) || 'Bible'
  const bookFilter = (args['bookFilter'] as string) || ''
  const force = args['force'] === 'true'
  const dryRun = args['dryRun'] === 'true'
  const noChunkGPT = args['noChunkGPT'] === 'true'
  const cacheChunks = args['cacheChunks'] === 'false' ? false : true
  const chunkModel = (args['chunkModel'] as string) || undefined
  const sourceName = (args['sourceName'] as string) || 'Project Gutenberg'
  const traditionName = (args['traditionName'] as string) || 'Christian'
  const startAt = (args['startAt'] as string) || ''
  const maxRetriesArg = args['maxRetries'] as string | undefined
  const throttleMsArg = args['throttleMs'] as string | undefined
  const initialBackoffMsArg = args['initialBackoffMs'] as string | undefined

  // Configure retry/backoff/throttle
  if (maxRetriesArg !== undefined) MAX_RETRIES = Math.max(1, Number(maxRetriesArg) || 3)
  if (throttleMsArg !== undefined) THROTTLE_MS = Math.max(0, Number(throttleMsArg) || 0)
  if (initialBackoffMsArg !== undefined) INITIAL_BACKOFF_MS = Math.max(50, Number(initialBackoffMsArg) || 300)

  // Diagnostic dump of required envs (masked for safety except first/last 4 chars)
  const mask = (v?: string) => v ? (v.length <= 12 ? v : v.slice(0,4)+'…'+v.slice(-4)) : 'MISSING'
  console.log('Ingest starting', {
    bibleTxt,
    workName,
    bookFilter,
    force,
    dryRun,
    noChunkGPT,
    cacheChunks,
    chunkModel: chunkModel || process.env.OPENAI_CHUNK_MODEL || 'gpt-4.1-mini',
    sourceName,
    traditionName,
    startAt,
    model: EMBEDDING_MODEL,
    dims: EMBEDDING_DIMENSIONS,
    maxRetries: MAX_RETRIES,
    throttleMs: THROTTLE_MS,
    initialBackoffMs: INITIAL_BACKOFF_MS,
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: mask(process.env.SUPABASE_SERVICE_ROLE_KEY),
    OPENAI_API_KEY: mask(process.env.OPENAI_API_KEY)
  })

  const rawVerses = parseBibleText(bibleTxt)
  if (!rawVerses.length) throw new Error('No verses parsed')
  const byBook = groupByBook(rawVerses)
  const booksOrder = Array.from(byBook.keys()).sort((a,b)=>{
    const av = rawVerses.find(v=>v.book===a && v.book_num!==undefined)?.book_num ?? 999
    const bv = rawVerses.find(v=>v.book===b && v.book_num!==undefined)?.book_num ?? 999
    if (av===999 && bv===999) return 0
    return av - bv
  })
  // If startAt provided, slice ordered list starting from that book (inclusive)
  const orderedBooks = (() => {
    if (!startAt) return booksOrder
    const idx = booksOrder.indexOf(startAt)
    if (idx >= 0) return booksOrder.slice(idx)
    console.warn(`[warn] --startAt '${startAt}' not found in parsed books; processing all books`)
    return booksOrder
  })()
  let bookIdMap: Record<string,string> = {}
  let workId: string | undefined
  if (!dryRun) {
    const { sourceId } = await ensureSourceAndTradition(sourceName, traditionName)
    if (!sourceId) throw new Error('Failed to resolve sourceId')
    const meta = await upsertMetadata(sourceId, workName, booksOrder)
    bookIdMap = meta.bookIdMap
    workId = meta.workId
  } else {
    // Provide placeholder IDs for logging without DB writes
    bookIdMap = booksOrder.reduce((acc,b)=>{ acc[b] = 'dry-'+b.replace(/\s+/g,'-'); return acc }, {} as Record<string,string>)
  }

  ensureDir(path.join('data','books'))
  ensureDir(path.join('data','chunks'))

  const totalVersesAll = rawVerses.length
  let processedVerses = 0

  for (const book of orderedBooks) {
    if (bookFilter && book !== bookFilter) continue
    const verses = byBook.get(book)!;
    // Dump per-book raw structure
    const bookOut = {
      book,
      chapters: verses.reduce<Record<number, RawVerse[]>>((acc, v) => { (acc[v.chapter] ||= []).push(v); return acc }, {})
    }
    fs.writeFileSync(path.join('data','books', `${book}.json`), JSON.stringify(bookOut, null, 2))

    const allChunks: ChunkOutput[] = []
    // Iterate chapters
    for (const chapterNumber of Object.keys(bookOut.chapters).map(n=>Number(n)).sort((a,b)=>a-b)) {
      const chapterVerses = bookOut.chapters[chapterNumber]
      if (noChunkGPT) {
        const chChunks = heuristicChunkChapter(chapterNumber, chapterVerses)
        allChunks.push(...chChunks)
        continue
      }
      try {
        // Try cache first
        let chapterChunks: ChunkOutput[] | null = null
        if (cacheChunks) {
          chapterChunks = loadCachedChapter(book, chapterNumber, chapterVerses)
        }
        if (!chapterChunks) {
          chapterChunks = await chunkChapter(book, chapterNumber, chapterVerses, chunkModel)
          if (cacheChunks) saveCachedChapter(book, chapterNumber, chapterChunks)
        }
        allChunks.push(...chapterChunks)
      } catch (e) {
        console.error('Chunking failed, fallback naive segmentation', book, chapterNumber, (e as Error).message)
        const chChunks = heuristicChunkChapter(chapterNumber, chapterVerses)
        allChunks.push(...chChunks)
      }
    }

    // Persist chunk JSON
    fs.writeFileSync(path.join('data','chunks', `${book}.json`), JSON.stringify({ book, chunks: allChunks }, null, 2))

    if (dryRun) { console.log('[dryRun] Skipping DB inserts for book', book); continue }

    const bookId = bookIdMap[book]
    // Insert chapters quickly (ensure existence)
    const chapterNums = Array.from(new Set(verses.map(v=>v.chapter))).sort((a,b)=>a-b)
    for (const ch of chapterNums) await ensureChapter(bookId, ch)

    // Batch-embed all chunks for this book to reduce HTTP overhead
    const embeddings = await embedMany(allChunks.map(c=>c.combined_text))

    // Insert chunks + verses
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

  console.log('Ingestion complete. 100% of selected verses processed.')
}

main().catch(e => { console.error(e); process.exit(1) })
