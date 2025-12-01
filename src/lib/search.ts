import { supabaseAdmin } from './supabase'
import { embedText } from './openai'

export interface SemanticVerseResult {
  verse_id: string
  book_id: string
  chapter_seq: number
  verse_seq: number
  text: string
  chunk_id: string
  chunk_score: number
  lexical_score: number
  combined_score: number
}

/** Semantic search by free-text query (hybrid with optional lexical). */
export async function semanticSearch(query: string, topK = 25, includeLexical = true): Promise<SemanticVerseResult[]> {
  const sb = supabaseAdmin()
  const embedding = await embedText(query)
  const { data, error } = await sb.rpc('semantic_search_verses', { query_embedding: embedding, match_count: topK, include_lexical: includeLexical, lexical_text: includeLexical ? query : null })
  if (error) throw error
  return data as SemanticVerseResult[]
}

/** Semantic search by verse id (find similar verses). */
export async function semanticSearchByVerseId(verseId: string, topK = 20, excludeSelf = true): Promise<any[]> {
  const sb = supabaseAdmin()
  const { data, error } = await sb.rpc('semantic_search_by_verse', { verse_uuid: verseId, match_count: topK, exclude_self: excludeSelf })
  if (error) throw error
  return data as any[]
}
