import dotenv from 'dotenv'
import fs from 'fs'
import path from 'path'
import { createClient } from '@supabase/supabase-js'

dotenv.config({ path: '.env' })
dotenv.config({ path: '.env.local' })

const url = process.env.SUPABASE_URL!
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!
if (!url || !key) throw new Error('Missing Supabase env vars')
const sb = createClient(url, key, { auth: { persistSession: false } })

async function getBookIdMap(workName: string) {
  const { data: workRows, error: wErr } = await sb.from('works').select('id').eq('name', workName).limit(1)
  if (wErr) throw wErr
  if (!workRows?.[0]) throw new Error('Work not found: ' + workName)
  const workId = workRows[0].id
  const { data: bookRows, error: bErr } = await sb.from('books').select('id,title,seq').eq('work_id', workId).order('seq',{ascending:true})
  if (bErr) throw bErr
  const m: Record<string,string> = {}
  for (const b of bookRows) m[b.title] = b.id
  return { workId, bookIdMap: m }
}

interface ChunkFile { book: string; chunks: { chapter_numbers: number[]; verse_numbers: number[]; combined_text: string }[] }

function loadChunkFiles(dir: string): ChunkFile[] {
  const out: ChunkFile[] = []
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue
    const raw = JSON.parse(fs.readFileSync(path.join(dir,f),'utf8'))
    if (raw && raw.book && Array.isArray(raw.chunks)) out.push(raw as ChunkFile)
  }
  return out
}

async function verify(workName: string) {
  const chunkFiles = loadChunkFiles(path.join('data','chunks'))
  const { bookIdMap } = await getBookIdMap(workName)
  const problems: string[] = []
  let totalExpectedChunks = 0
  let totalDbChunks = 0
  let totalVersesLinked = 0
  let totalVersesDistinct = 0

  for (const cf of chunkFiles) {
    totalExpectedChunks += cf.chunks.length
    const bookId = bookIdMap[cf.book]
    if (!bookId) { problems.push(`Book missing in DB: ${cf.book}`); continue }
    const { data: dbChunks, error: cErr } = await sb.from('embedding_chunks').select('id,chapter_numbers,verse_numbers').eq('book_id', bookId)
    if (cErr) { problems.push(`Chunk query error for ${cf.book}: ${cErr.message}`); continue }
    totalDbChunks += (dbChunks?.length || 0)
    // Quick per-book count mismatch
    if ((dbChunks?.length || 0) !== cf.chunks.length) {
      problems.push(`Chunk count mismatch for ${cf.book}: expected ${cf.chunks.length} got ${dbChunks?.length || 0}`)
    }
    // Verse linkage verification
    const { data: verses, error: vErr } = await sb.from('verses').select('id,chapter_seq,verse_seq,chunk_id').eq('book_id', bookId)
    if (vErr) { problems.push(`Verse query error for ${cf.book}: ${vErr.message}`); continue }
    totalVersesLinked += (verses?.length || 0)
    const distinctChunkIds = new Set(verses?.map(v=>v.chunk_id))
    totalVersesDistinct += distinctChunkIds.size
    if (distinctChunkIds.size < (dbChunks?.length || 0)) {
      problems.push(`Some chunks not referenced by verses in ${cf.book}: distinct chunk refs ${distinctChunkIds.size} < chunk rows ${(dbChunks?.length || 0)}`)
    }
  }

  console.log('Verification summary:', {
    totalExpectedChunks,
    totalDbChunks,
    totalVersesLinked,
    distinctChunksReferenced: totalVersesDistinct,
    problemsCount: problems.length
  })
  if (problems.length) {
    console.log('Problems:')
    for (const p of problems) console.log(' -', p)
  } else {
    console.log('No mismatches detected.')
  }
}

const workName = process.argv[2] || 'Holy Bible King James Version'
verify(workName).catch(e => { console.error(e); process.exit(1) })
