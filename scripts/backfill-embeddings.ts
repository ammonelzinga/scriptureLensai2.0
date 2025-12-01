// Backfill script (New Architecture)
// Regenerates missing chunk embeddings (vector(512)) based on combined_text.
// Chapters & verses no longer store embeddings; do NOT attempt to backfill them.
import 'dotenv/config'
import { supabaseAdmin } from '../src/lib/supabase.js'
import { embedMany } from '../src/lib/openai.js'

async function run() {
  const sb = supabaseAdmin()
  const { data: chunks } = await sb.from('embedding_chunks').select('id, combined_text, embedding').limit(5000)
  if (!chunks) { console.log('No chunks found'); return }
  const missing = chunks.filter(c => !c.embedding)
  console.log('Chunks total:', chunks.length, 'missing embeddings:', missing.length)
  const batchSize = 100
  for (let i=0;i<missing.length;i+=batchSize) {
    const slice = missing.slice(i, i+batchSize)
    const embeddings = await embedMany(slice.map(c=>c.combined_text))
    for (let j=0;j<slice.length;j++) {
      await sb.from('embedding_chunks').update({ embedding: embeddings[j] as any }).eq('id', slice[j].id)
    }
    console.log(`Updated ${i+slice.length}/${missing.length}`)
  }
  console.log('Chunk embedding backfill complete.')
}

run().catch(err => { console.error(err); process.exit(1) })
