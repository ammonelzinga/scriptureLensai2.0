import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'
import { supabaseAdmin } from '../src/lib/supabase.ts'
import { embedText, CHUNKING_PROMPT, openai } from '../src/lib/openai.ts'

type Verse = { chapter: number; verse: number; text: string }
type Chapter = { chapter: number; title?: string; verses: Verse[] }
type Book = { title: string; chapters: Chapter[] }

type Chunk = {
  start_chapter: number
  end_chapter: number
  verse_ids: string[]
  text: string
  embedding?: number[]
}

// Cheaper default chat model (override via env OPENAI_CHUNK_MODEL)
const CHUNK_MODEL = process.env.OPENAI_CHUNK_MODEL || 'gpt-4.1-mini'
function ensureDir(p: string) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }) }
function sleep(ms: number) { return new Promise(res => setTimeout(res, ms)) }

async function chatChunkStrict(items: { id: string; text: string }[], book?: string, chapter?: number) {
  const payload = {
    book: book || 'Unknown',
    chapter: chapter || 0,
    verses: items.map(it => {
      const parts = it.id.split(':');
      return { verse: Number(parts[2]), text: it.text }
    })
  }
  const STRICT_PROMPT = `${CHUNKING_PROMPT}\n\nHard constraints:\n- EVERY chunk MUST have between 3 and 10 verses inclusive, EXCEPT when the entire chapter has fewer than 3 verses (then use a single chunk of 1–2).\n- If remaining verses at the end are fewer than 3, MERGE them with the previous chunk so the previous stays ≤10.\n- Do not emit any chunk with <3 verses unless the entire chapter has <3 verses.`
  const res = await openai.chat.completions.create({
    model: CHUNK_MODEL,
    temperature: 0,
    messages: [
      { role: 'system', content: STRICT_PROMPT },
      { role: 'user', content: JSON.stringify(payload) }
    ]
  })
  let content = res.choices[0]?.message?.content || '{}'
  // Prefer fenced JSON if present
  const fence = content.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) content = fence[1].trim()
  else {
    const match = content.match(/\{[\s\S]*\}/)
    if (match) content = match[0]
  }
  content = content.replace(/,\s*\]/g, ']').replace(/,\s*\}/g, '}')
  let parsed: any
  try {
    parsed = JSON.parse(content)
  } catch (e) {
    // Fallback: minimal structure
    parsed = { chunks: [] }
  }
  const chunksOut: Chunk[] = (parsed.chunks || []).map((c:any)=>{
    const verse_ids = (c.verses || []).map((v:any)=>`${payload.book}:${v.chapter}:${v.verse}`)
    return {
      start_chapter: Math.min(...c.chapter_numbers),
      end_chapter: Math.max(...c.chapter_numbers),
      verse_ids,
      text: c.combined_text,
    }
  })
  return chunksOut
}

// Per-chapter cache directory and coverage validation
const CHAPTER_CACHE_DIR = path.join('data','chunks_cache_pseudepigrapha')
function chapterCachePath(book: string, chapterNumber: number) { const safe = book.replace(/[\\/:*?"<>|]/g, '_'); return path.join(CHAPTER_CACHE_DIR, `${safe}_ch${chapterNumber}.json`) }
function validateChapterCoverage(chunks: Chunk[], verses: Verse[]) {
  const expected = verses.map(v=>v.verse).sort((a,b)=>a-b)
  const got = Array.from(new Set(chunks.flatMap(c=>c.verse_ids.map(id=>Number(id.split(':')[2]))))).sort((a,b)=>a-b)
  if (expected.length !== got.length) return false
  for (let i=0;i<expected.length;i++) if (expected[i]!==got[i]) return false
  return true
}

async function ensureLineage(traditionName: string, sourceName: string, workName: string, bookTitle: string) {
  const sb = supabaseAdmin()
  const { data: t1, error: tErr } = await sb.from('traditions').select('id').eq('name', traditionName).maybeSingle()
  if (tErr) throw tErr
  let tid = t1?.id
  if (!tid) {
    const ins = await sb.from('traditions').insert({ name: traditionName }).select('id').single()
    if (ins.error) throw ins.error
    tid = ins.data!.id
  }
  const { data: s1, error: sErr } = await sb.from('sources').select('id').eq('name', sourceName).eq('tradition_id', tid).maybeSingle()
  if (sErr) throw sErr
  let sid = s1?.id
  if (!sid) {
    const ins = await sb.from('sources').insert({ name: sourceName, tradition_id: tid }).select('id').single()
    if (ins.error) throw ins.error
    sid = ins.data!.id
  }
  const { data: w1, error: wErr } = await sb.from('works').select('id').eq('name', workName).eq('source_id', sid).maybeSingle()
  if (wErr) throw wErr
  let wid = w1?.id
  if (!wid) {
    const ins = await sb.from('works').insert({ name: workName, source_id: sid }).select('id').single()
    if (ins.error) throw ins.error
    wid = ins.data!.id
  }
  const { data: b1, error: b1Err } = await sb.from('books').select('id, seq').eq('work_id', wid).order('seq', { ascending: false }).limit(1)
  if (b1Err) throw b1Err
  const nextSeq = (b1 && b1.length ? (b1[0].seq + 1) : 1)
  const { data: b2, error: b2Err } = await sb.from('books').select('id').eq('work_id', wid).eq('title', bookTitle).maybeSingle()
  if (b2Err) throw b2Err
  let bid = b2?.id
  if (!bid) {
    const ins = await sb.from('books').insert({ work_id: wid, seq: nextSeq, title: bookTitle }).select('id').single()
    if (ins.error) throw ins.error
    bid = ins.data!.id
  }
  return { sb, tid: tid!, sid: sid!, wid: wid!, bid: bid! }
}

async function aiChunkChapter(bookName: string, chapter: Chapter, strictJson: boolean, cachePath?: string): Promise<Chunk[]> {
  const items = chapter.verses.map(v => ({ id: `${bookName}:${chapter.chapter}:${v.verse}`, text: v.text }))
  const chapterCache = cachePath || chapterCachePath(bookName, chapter.chapter)
  if (fs.existsSync(chapterCache)) {
    try { const cached = JSON.parse(fs.readFileSync(chapterCache, 'utf8')) as Chunk[]; if (validateChapterCoverage(cached, chapter.verses)) return cached } catch {}
  }
  if (strictJson) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await chatChunkStrict(items, bookName, chapter.chapter)
        ensureDir(CHAPTER_CACHE_DIR)
        fs.writeFileSync(chapterCache, JSON.stringify(res, null, 2), 'utf8')
        return res
      } catch (e: any) {
        if (e?.code === 'rate_limit_exceeded' || e?.status === 429) { await sleep(500 * (attempt + 1)); continue }
        throw e
      }
    }
    return []
  }
  // naive fallback: chunk in fixed windows of 5
  const chunks: Chunk[] = []
  for (let i = 0; i < items.length; i += 5) {
    const window = items.slice(i, i + 5)
    const text = window.map(it => it.text).join(' ')
    chunks.push({ start_chapter: chapter.chapter, end_chapter: chapter.chapter, verse_ids: window.map(w => w.id), text })
  }
  ensureDir(CHAPTER_CACHE_DIR); fs.writeFileSync(chapterCache, JSON.stringify(chunks, null, 2), 'utf8')
  return chunks
}

async function main() {
  const argv = yargs(hideBin(process.argv))
    .option('strictJson', { type: 'boolean', default: true })
    .option('useCache', { type: 'boolean', default: false })
    .option('embed', { type: 'boolean', default: true })
    .option('workName', { type: 'string', default: 'Pseudepigrapha (Old Testament)'} )
    .option('sourceName', { type: 'string', default: 'Apocrypha'})
    .option('traditionName', { type: 'string', default: 'Jewish'})
    .option('inputDir', { type: 'string', default: path.join('data', 'pseudepigrapha_json') })
    .option('outDir', { type: 'string', default: path.join('data', 'chunks_pseudepigrapha') })
    .option('useCache', { type: 'boolean', default: false })
    .option('only', { type: 'string' })
    .option('startAt', { type: 'string' })
    .parseSync()

  const dir = argv.inputDir!
  let files = fs.readdirSync(dir).filter(f => f.endsWith('.json'))
  if (argv.only) files = files.filter(f => f.replace(/\.json$/,'') === argv.only)
  if (argv.startAt) {
    const idx = files.findIndex(f => f.replace(/\.json$/,'') === argv.startAt)
    if (idx !== -1) files = files.slice(idx)
  }
  for (const f of files) {
    const book: Book = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
    const { sb, bid } = await ensureLineage(argv.traditionName!, argv.sourceName!, argv.workName!, book.title)
    // ensure chapters
    for (const ch of book.chapters) {
      await sb.from('chapters').upsert({ book_id: bid, seq: ch.chapter, title: ch.title || null }, { onConflict: 'book_id,seq' })
    }
    // chunk + embed + upsert chunks
    fs.mkdirSync(argv.outDir!, { recursive: true })
    const bookChunkPath = path.join(argv.outDir!, `${book.title}.json`)
    let allChunks: Chunk[] = []
    for (const ch of book.chapters) {
      const chCache = argv.useCache ? path.join(argv.outDir!, `${book.title}__chapter_${ch.chapter}.json`) : undefined
      const chunks = await aiChunkChapter(book.title, ch, argv.strictJson!, chCache)
      allChunks.push(...chunks)
    }
    // Write per-book chunks file
    fs.writeFileSync(bookChunkPath, JSON.stringify(allChunks, null, 2), 'utf8')
    // embed
    for (const c of allChunks) {
      c.embedding = await embedText(c.text)
    }
    // upsert chunks
    const rowsRaw = allChunks.map(c => {
      const refs = c.verse_ids.map(id => { const p = id.split(':'); return { chapter: parseInt(p[1],10), verse: parseInt(p[2],10) } })
      const chapter_numbers = refs.map(r=>r.chapter)
      const verse_numbers = refs.map(r=>r.verse)
      const combined_text = c.text
      const combined_hash = crypto.createHash('sha1').update(`${bid}|${chapter_numbers.join(',')}|${verse_numbers.join(',')}`).digest('hex')
      return { book_id: bid, start_chapter: c.start_chapter, end_chapter: c.end_chapter, verse_numbers, chapter_numbers, combined_text, embedding: c.embedding, combined_hash }
    })
    const uniq = new Map<string, any>()
    for (const r of rowsRaw) if (!uniq.has(r.combined_hash)) uniq.set(r.combined_hash, r)
    const rows = Array.from(uniq.values())
    const { data: upserted, error } = await sb.from('embedding_chunks').upsert(rows as any, { onConflict: 'combined_hash' }).select('id, combined_hash')
    if (error) throw error
    const idByHash = new Map<string, string>((upserted || []).map((r:any)=>[r.combined_hash, r.id]))
    // upsert verses with actual text
    // Build a lookup of verse text from parsed book
    const verseTextByKey = new Map<string, string>()
    for (const ch of book.chapters) {
      for (const v of ch.verses) {
        verseTextByKey.set(`${ch.chapter}:${v.verse}`, v.text || '')
      }
    }
    const vUniq = new Map<string, any>()
    for (const c of allChunks) {
      const refs = c.verse_ids.map(id => { const p = id.split(':'); return { chapter: parseInt(p[1],10), verse: parseInt(p[2],10) } })
      const chapter_numbers = refs.map(r=>r.chapter)
      const verse_numbers = refs.map(r=>r.verse)
      const h = crypto.createHash('sha1').update(`${bid}|${chapter_numbers.join(',')}|${verse_numbers.join(',')}`).digest('hex')
      const chunk_id = idByHash.get(h); if (!chunk_id) continue
      for (const r of refs) {
        const key = `${bid}|${r.chapter}|${r.verse}`
        if (!vUniq.has(key)) {
          const txt = verseTextByKey.get(`${r.chapter}:${r.verse}`) || ''
          vUniq.set(key, { book_id: bid, chapter_seq: r.chapter, verse_seq: r.verse, text: txt, chunk_id })
        }
      }
    }
    const verseRows = Array.from(vUniq.values())
    if (verseRows.length) {
      const { error: vErr } = await sb.from('verses').upsert(verseRows as any, { onConflict: 'book_id,chapter_seq,verse_seq' })
      if (vErr) throw vErr
    }
    console.log(`Ingested ${book.title}: ${rows.length} chunks, ${verseRows.length} verses`)
  }
}

// ESM-friendly entrypoint
main()
