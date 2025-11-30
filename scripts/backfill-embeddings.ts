import 'dotenv/config'
import { supabaseAdmin } from '../src/lib/supabase.js'
import { embedMany } from '../src/lib/openai.js'

async function run() {
  const sb = supabaseAdmin()
  // Verses without embeddings
  const { data: verses } = await sb.from('verses').select('id, text').is('embedding', null).limit(2000)
  if (verses && verses.length) {
    const batchSize = 100
    for (let i=0;i<verses.length;i+=batchSize) {
      const slice = verses.slice(i, i+batchSize)
      const embeddings = await embedMany(slice.map(v=>v.text))
      for (let j=0;j<slice.length;j++) {
        await sb.from('verses').update({ embedding: embeddings[j] as any }).eq('id', slice[j].id)
      }
    }
  }
  // Chapters without embeddings
  const { data: chapters } = await sb.from('chapters').select('id').is('embedding', null).limit(5000)
  if (chapters) {
    for (const c of chapters) {
      const { data: verses } = await sb.from('verses').select('text').eq('chapter_id', c.id).order('seq')
      const text = (verses || []).map(v => v.text).join(' ')
      if (!text) continue
      const [vec] = await embedMany([text])
      await sb.from('chapters').update({ embedding: vec as any }).eq('id', c.id)
    }
  }
  console.log('Backfill complete')
}

run().catch(err => { console.error(err); process.exit(1) })
