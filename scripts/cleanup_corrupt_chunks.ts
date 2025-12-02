import dotenv from 'dotenv'
import { createClient } from '@supabase/supabase-js'

dotenv.config({ path: '.env' })
dotenv.config({ path: '.env.local' })

const url = process.env.SUPABASE_URL!
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!
if (!url || !key) throw new Error('Missing Supabase env vars')
const sb = createClient(url, key, { auth: { persistSession: false } })

async function main() {
  const dry = process.argv.includes('--dryRun')
  console.log(`Scanning embedding_chunks for corrupt rows (dryRun=${dry})...`)
  const { data, error } = await sb
    .from('embedding_chunks')
    .select('id,book_id,start_chapter,end_chapter,chapter_numbers,verse_numbers,combined_text,embedding')
  if (error) throw error
  const corrupt = (data||[]).filter(r => !r.book_id || !r.chapter_numbers || !r.verse_numbers || !r.combined_text || !r.embedding)
  if (!corrupt.length) {
    console.log('No corrupt rows found.')
    return
  }
  console.log(`Found ${corrupt.length} corrupt rows:`)
  for (const r of corrupt) console.log(' -', r.id)
  if (dry) {
    console.log('Dry run: no deletions performed.')
    console.log('To delete run without --dryRun.')
    return
  }
  const ids = corrupt.map(r=>r.id)
  const { error: delErr } = await sb.from('embedding_chunks').delete().in('id', ids)
  if (delErr) throw delErr
  console.log(`Deleted ${ids.length} corrupt rows.`)
  console.log('Re-run ingestion for affected books/chapters to restore chunks.')
}

main().catch(e => { console.error(e); process.exit(1) })
