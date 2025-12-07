import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import { supabaseAdmin } from '../src/lib/supabase.ts'

type Verse = { chapter: number; verse: number; text: string }
type Chapter = { chapter: number; title?: string; verses: Verse[] }
type Book = { title: string; chapters: Chapter[] }

async function getWorkId(sb: any, workName: string, sourceName?: string, traditionName?: string) {
  // Resolve lineage to find the work ID by name
  let tid: string | undefined
  if (traditionName) {
    const t = await sb.from('traditions').select('id').eq('name', traditionName).maybeSingle()
    if (t.error) throw t.error
    tid = t.data?.id
  }
  let sid: string | undefined
  if (sourceName) {
    const s = await sb.from('sources').select('id').eq('name', sourceName).maybeSingle()
    if (s.error) throw s.error
    sid = s.data?.id
  }
  const w = await sb.from('works').select('id, name, source_id').eq('name', workName).maybeSingle()
  if (w.error) throw w.error
  if (!w.data?.id) throw new Error(`Work not found: ${workName}`)
  return w.data.id as string
}

async function run() {
  const sb = supabaseAdmin()
  const WORK_NAME = process.env.FIX_WORK_NAME || 'Pseudepigrapha'
  const INPUT_DIR = process.env.FIX_INPUT_DIR || path.join('data','pseudepigrapha_json')

  const workId = await getWorkId(sb, WORK_NAME)
  // Load books table for this work to map titles to book ids
  const { data: books, error: bErr } = await sb.from('books').select('id, title, seq').eq('work_id', workId).order('seq', { ascending: true })
  if (bErr) throw bErr
  if (!books || books.length === 0) throw new Error(`No books found for work '${WORK_NAME}'`)
  const bookIdByTitle = new Map<string,string>(books.map((b:any)=>[b.title, b.id]))

  // Step 1: Null out chapter titles for this work
  console.log(`Nulling chapter titles for work '${WORK_NAME}'...`)
  // Fetch chapters to update in batches
  const { data: chapters, error: cErr } = await sb.from('chapters').select('id, book_id, seq, title').in('book_id', books.map((b:any)=>b.id)).limit(10000)
  if (cErr) throw cErr
  if (chapters && chapters.length) {
    const batchSize = 500
    for (let i=0; i<chapters.length; i+=batchSize) {
      const slice = chapters.slice(i, i+batchSize)
      for (const ch of slice) {
        const { error: uErr } = await sb.from('chapters').update({ title: null }).eq('id', ch.id)
        if (uErr) throw uErr
      }
      console.log(`Chapters updated: ${Math.min(i+batchSize, chapters.length)}/${chapters.length}`)
    }
  }

  // Step 2: Repopulate verse texts from parsed JSON input
  console.log(`Repopulating verse texts from '${INPUT_DIR}'...`)
  const files = fs.readdirSync(INPUT_DIR).filter(f=>f.endsWith('.json'))
  let totalUpdated = 0
  for (const f of files) {
    const book: Book = JSON.parse(fs.readFileSync(path.join(INPUT_DIR, f),'utf8'))
    const bid = bookIdByTitle.get(book.title)
    if (!bid) { console.warn(`Skip: book not found in DB -> ${book.title}`); continue }
    // Build rows: book_id, chapter_seq, verse_seq, text
    const verseRows: any[] = []
    for (const ch of book.chapters) {
      for (const v of ch.verses) {
        verseRows.push({ book_id: bid, chapter_seq: ch.chapter, verse_seq: v.verse, text: v.text || '' })
      }
    }
    // Fetch existing verses for this book to preserve chunk_id and update text only
    const { data: existing, error: exErr } = await sb.from('verses').select('id, book_id, chapter_seq, verse_seq, chunk_id').eq('book_id', bid).limit(50000)
    if (exErr) throw exErr
    const byKey = new Map<string, any>()
    for (const v of (existing||[])) byKey.set(`${v.chapter_seq}:${v.verse_seq}`, v)
    const updates = verseRows
      .map(v => { const ex = byKey.get(`${v.chapter_seq}:${v.verse_seq}`); return ex ? { id: ex.id, text: v.text } : null })
      .filter(Boolean) as { id:string; text:string }[]
    // Perform batched updates by id
    const batchSize = 500
    for (let i=0;i<updates.length;i+=batchSize) {
      const slice = updates.slice(i, i+batchSize)
      for (const up of slice) {
        const { error: vErr } = await sb.from('verses').update({ text: up.text }).eq('id', up.id)
        if (vErr) throw vErr
      }
      totalUpdated += slice.length
    }
    console.log(`Updated verses for '${book.title}': ${updates.length}`)
  }
  console.log(`Completed. Total verses updated: ${totalUpdated}`)
}

run().catch(err => { console.error(err); process.exit(1) })
