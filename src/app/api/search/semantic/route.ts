import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { embedText } from '@/lib/openai'

// New semantic verse search using chunk-level embeddings (512 dims)
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const { query, topK = 25, includeLexical = true, bookId, workId, bookSeqMin, bookSeqMax } = body
  if (!query) return NextResponse.json({ error: 'Query required' }, { status: 400 })
  try {
    const embedding = await embedText(query)
    const sb = supabaseAdmin()
    const { data, error } = await sb.rpc('semantic_search_verses', {
      query_embedding: embedding,
      match_count: topK,
      include_lexical: includeLexical,
      lexical_text: includeLexical ? query : null,
      p_book_id: bookId ?? null,
      p_work_id: workId ?? null,
      p_book_seq_min: bookSeqMin ?? null,
      p_book_seq_max: bookSeqMax ?? null,
    })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ verses: data })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
