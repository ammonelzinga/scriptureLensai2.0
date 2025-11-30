import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { embedText } from '@/lib/openai'

/**
 * Explain endpoint: returns scoring breakdown for top verses and chapters
 * including semantic similarity and lexical similarity scores.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const { query, topKChapters = 5, topKVerses = 10 } = body
  if (!query) return NextResponse.json({ error: 'Query required' }, { status: 400 })

  const sb = supabaseAdmin()
  const emb = await embedText(query)
  if (!emb) return NextResponse.json({ error: 'Embedding failed' }, { status: 500 })

  // Chapters via RPC
  const { data: chapters } = await sb.rpc('match_chapters', { query_embedding: emb, match_count: topKChapters })

  // Verses via RPC
  const { data: verses } = await sb.rpc('match_verses', { query_embedding: emb, match_count: topKVerses })

  // Lexical similarity via pg_trgm RPCs
  const { data: lexCh } = await sb.rpc('lexical_search_chapters', { q: query, match_count: topKChapters })
  const { data: lexVs } = await sb.rpc('lexical_search_verses', { q: query, match_count: topKVerses })

  const chapterMap: any = {}
  for (const c of chapters || []) {
    chapterMap[c.id] = { semantic: c.similarity, lexical: 0 }
  }
  for (const lc of lexCh || []) {
    if (!chapterMap[lc.id]) chapterMap[lc.id] = { semantic: 0, lexical: lc.similarity }
    else chapterMap[lc.id].lexical = lc.similarity
  }

  const verseMap: any = {}
  for (const v of verses || []) {
    verseMap[v.id] = { semantic: v.similarity, lexical: 0 }
  }
  for (const lv of lexVs || []) {
    if (!verseMap[lv.id]) verseMap[lv.id] = { semantic: 0, lexical: lv.similarity }
    else verseMap[lv.id].lexical = lv.similarity
  }

  return NextResponse.json({
    chapters: (chapters || []).map((c: any) => ({ id: c.id, title: c.title, similarity: chapterMap[c.id] })),
    verses: (verses || []).map((v: any) => ({ id: v.id, text: v.text, similarity: verseMap[v.id] })),
  })
}
