import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { embedText } from '@/lib/openai'

/**
 * Explain endpoint aligned with chunk-based schema.
 * - Semantic: use `semantic_search_verses`, then collapse to chapters.
 * - Lexical: use `lexical_search_verses`, then collapse to chapters.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const { query, topKChapters = 5, topKVerses = 10, hybrid = true } = body
  if (!query) return NextResponse.json({ error: 'Query required' }, { status: 400 })

  const sb = supabaseAdmin()
  const emb = await embedText(query)
  if (!emb) return NextResponse.json({ error: 'Embedding failed' }, { status: 500 })

  // Semantic verses (with optional lexical boost for context), fetch more and then slice
  const { data: semRows } = await sb.rpc('semantic_search_verses', {
    query_embedding: emb,
    match_count: Math.max(50, topKVerses * 2),
    include_lexical: hybrid,
    lexical_text: hybrid ? query : null
  })
  type SemRow = { verse_id: string; book_id: string; chapter_seq: number; verse_seq: number; text: string; chunk_score: number; lexical_score: number; combined_score: number }
  const sem = (semRows || []) as SemRow[]
  const topVerses = sem
    .sort((a,b)=> (b.combined_score ?? 0) - (a.combined_score ?? 0))
    .slice(0, topKVerses)
    .map(v => ({ id: v.verse_id, text: v.text, semantic: v.chunk_score ?? 0, lexical: v.lexical_score ?? 0 }))

  // Collapse semantic to chapters by average of top verse scores per chapter
  const chapAgg: Record<string, { semantic: number[]; lexical: number[] }> = {}
  for (const r of sem) {
    const key = `${r.book_id}:${r.chapter_seq}`
    if (!chapAgg[key]) chapAgg[key] = { semantic: [], lexical: [] }
    chapAgg[key].semantic.push(r.chunk_score ?? 0)
    chapAgg[key].lexical.push(r.lexical_score ?? 0)
  }
  const chapterKeys = Object.keys(chapAgg)
  // Lookup chapters to get titles/ids
  const bookIds = Array.from(new Set(chapterKeys.map(k => k.split(':')[0])))
  const { data: chAll } = await sb.from('chapters').select('id, book_id, seq, title').in('book_id', bookIds)
  const chMap = new Map<string, any>((chAll || []).map((c:any)=> [`${c.book_id}:${c.seq}`, c]))
  const chapters = chapterKeys.map(k => {
    const c = chMap.get(k)
    const s = chapAgg[k].semantic
    const l = chapAgg[k].lexical
    const semantic = s.length ? s.reduce((a,b)=>a+b,0)/s.length : 0
    const lexical = l.length ? l.reduce((a,b)=>a+b,0)/l.length : 0
    return { id: c?.id || null, title: c?.title || `Chapter ${c?.seq ?? ''}`, semantic, lexical }
  }).sort((a,b)=> (b.semantic + b.lexical*0.15) - (a.semantic + a.lexical*0.15)).slice(0, topKChapters)

  // Lexical-only verses for comparison
  const { data: lexRows } = await sb.rpc('lexical_search_verses', { q: query, match_count: topKVerses })
  const lexVerses = (lexRows || []).map((v:any)=> ({ id: v.verse_id || v.id, text: v.text, semantic: 0, lexical: v.similarity ?? 0 }))

  return NextResponse.json({
    chapters,
    verses: topVerses,
    lexicalVerses: lexVerses
  })
}
