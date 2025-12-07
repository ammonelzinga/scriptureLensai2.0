import { supabaseAdmin } from '../src/lib/supabase'

async function run() {
  const sb = supabaseAdmin()
  const query = 'hen'
  const topK = 20

  console.log('Testing lexical_search_word_exact for "hen"...')
  const { data: exact, error: exactErr } = await sb.rpc('lexical_search_word_exact', {
    q: query,
    match_count: topK,
    p_book_ids: null,
    p_work_ids: null,
    p_source_ids: null,
    p_tradition_ids: null,
    p_book_seq_min: null,
    p_book_seq_max: null,
  })
  if (exactErr) {
    console.error('Exact RPC error:', exactErr.message)
  } else {
    console.log(`Exact matches: ${exact?.length || 0}`)
    for (const r of (exact || []).slice(0, 5)) {
      console.log(`Verse ${r.book_id} ${r.chapter_seq}:${r.verse_seq} -> ${r.text}`)
    }
  }

  console.log('Testing lexical_search_verses (trigram) for "hen"...')
  const { data: trigram, error: triErr } = await sb.rpc('lexical_search_verses', {
    q: query,
    match_count: topK,
    p_book_ids: null,
    p_work_ids: null,
    p_source_ids: null,
    p_tradition_ids: null,
    p_book_seq_min: null,
    p_book_seq_max: null,
  })
  if (triErr) {
    console.error('Trigram RPC error:', triErr.message)
  } else {
    console.log(`Trigram matches: ${trigram?.length || 0}`)
    for (const r of (trigram || []).slice(0, 5)) {
      console.log(`Verse ${r.book_id} ${r.chapter_seq}:${r.verse_seq} (sim=${r.similarity}) -> ${r.text}`)
    }
  }
}

run().catch((e)=>{ console.error(e); process.exit(1) })
