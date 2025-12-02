import dotenv from 'dotenv'
import crypto from 'crypto'
import { createClient } from '@supabase/supabase-js'

dotenv.config({ path: '.env' })
dotenv.config({ path: '.env.local' })

const url = process.env.SUPABASE_URL!
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!
if (!url || !key) throw new Error('Missing Supabase env vars')
const sb = createClient(url, key, { auth: { persistSession: false } })

function buildHash(book_id: string, chapter_numbers: number[], verse_numbers: number[]) {
  return crypto.createHash('sha256').update(`${book_id}|${chapter_numbers.join(',')}|${verse_numbers.join(',')}`).digest('hex')
}

async function main() {
  console.log('Backfilling combined_hash for embedding_chunks...')
  let from = 0
  const pageSize = 1000
  let updated = 0
  const corrupted: string[] = []
  for (;;) {
    const { data, error } = await sb.from('embedding_chunks').select('id,book_id,chapter_numbers,verse_numbers,combined_hash').range(from, from + pageSize - 1)
    if (error) throw error
    if (!data || !data.length) break
    const toUpdate: any[] = []
    for (const row of data) {
      // Detect malformed stub rows missing required fields
      if (!row.book_id || !Array.isArray(row.chapter_numbers) || row.chapter_numbers.length === 0 || !Array.isArray(row.verse_numbers) || row.verse_numbers.length === 0) {
        corrupted.push(row.id)
        continue
      }
      if (row.combined_hash) continue
      const hash = buildHash(row.book_id, row.chapter_numbers, row.verse_numbers)
      toUpdate.push({ id: row.id, combined_hash: hash })
    }
    if (toUpdate.length) {
      // Use per-row UPDATE to avoid NOT NULL constraint issues with UPSERT insert path
      for (const row of toUpdate) {
        const { error: updErr } = await sb.from('embedding_chunks').update({ combined_hash: row.combined_hash }).eq('id', row.id)
        if (updErr) throw updErr
        updated++
      }
      console.log(`Updated batch: ${toUpdate.length}, total updated: ${updated}`)
    }
    if (data.length < pageSize) break
    from += pageSize
  }
  console.log('Backfill complete. Rows updated:', updated)
  if (corrupted.length) {
    console.warn(`Detected ${corrupted.length} corrupted embedding_chunks rows (missing critical columns). They should be deleted and re-ingested.`)
    console.warn('Corrupted IDs:', corrupted.join(','))
    console.log('\nSuggested cleanup SQL (run in Supabase SQL editor):')
    console.log(`DELETE FROM embedding_chunks WHERE id IN (${corrupted.map(id=>`'${id}'`).join(',')});`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
