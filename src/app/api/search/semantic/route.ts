import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { embedText } from '@/lib/openai'

/**
 * Semantic search: embed query, retrieve similar chapters and verses,
 * then combine scores with optional lexical boost.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const {
    query,
    topKChapters = 10,
    topKVersesPerChapter = 3,
    lexicalBoost = 0.15, // 0..1 weight added if lexical match
    bookId,
    testament, // 'old' | 'new' (legacy)
    workId, // optional: filter to a specific work (e.g., Bible, Book of Mormon, Quran)
    bookSeqMin, // optional: minimum book sequence within the work
    bookSeqMax, // optional: maximum book sequence within the work
  } = body

  if (!query) return NextResponse.json({ error: 'Query required' }, { status: 400 })

  const sb = supabaseAdmin()

  // Embed query
  const queryEmbedding = await embedText(query)
  if (!queryEmbedding) return NextResponse.json({ error: 'Embedding failed' }, { status: 500 })

  // Get similar chapters via RPC
  const { data: chapters } = await sb.rpc('match_chapters', { query_embedding: queryEmbedding, match_count: topKChapters })

  let filteredChapters = (chapters || [])
  // Dynamic filtering: by workId and/or book sequence ranges
  if (testament || bookId || workId || (typeof bookSeqMin === 'number') || (typeof bookSeqMax === 'number')) {
    const sb2 = supabaseAdmin()
    const bookIds = Array.from(new Set(filteredChapters.map((c: any) => c.book_id).filter(Boolean))) as string[]
    const { data: books } = await sb2.from('books').select('id, seq, work_id').in('id', bookIds)
    const seqMap = new Map<string, number>((books || []).map(b => [b.id as unknown as string, b.seq as unknown as number]))
    const workMap = new Map<string, string>((books || []).map(b => [b.id as unknown as string, b.work_id as unknown as string]))
    filteredChapters = filteredChapters.filter((c: any) => {
      const seq = seqMap.get(c.book_id)
      const chWorkId = workMap.get(c.book_id)
      if (workId && chWorkId !== workId) return false
      if (bookId && c.book_id !== bookId) return false
      if (typeof bookSeqMin === 'number' && typeof seq === 'number' && seq < bookSeqMin) return false
      if (typeof bookSeqMax === 'number' && typeof seq === 'number' && seq > bookSeqMax) return false
      // Legacy testament shorthand for common Bible works
      if (testament === 'old' && typeof seq === 'number') return seq >= 1 && seq <= 39
      if (testament === 'new' && typeof seq === 'number') return seq >= 40 && seq <= 66
      return true
    })
  }

  const results: any[] = []

  for (const ch of filteredChapters) {
    // Verses in chapter
    const { data: verses } = await sb
      .from('verses')
      .select('id, seq, text, embedding, chapter_id')
      .eq('chapter_id', ch.id)

    const scored = (verses || [])
      .filter(v => v.embedding)
      .map(v => {
        const sem = cosineSim(queryEmbedding, v.embedding)
        const lex = lexicalBoost > 0 && roughlyContains(v.text, query) ? lexicalBoost : 0
        return { ...v, score: sem + lex }
      })
      .sort((a,b)=>b.score-a.score)
      .slice(0, topKVersesPerChapter)

    results.push({ chapter: ch, verses: scored })
  }

  return NextResponse.json({ results })
}

function cosineSim(a: number[], b: number[]) {
  let dot = 0, na = 0, nb = 0
  for (let i=0;i<a.length && i<b.length;i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i] }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-8)
}

function roughlyContains(text: string, query: string) {
  const t = text.toLowerCase()
  const q = query.toLowerCase()
  return t.includes(q) || q.split(/\s+/).every(word => t.includes(word))
}
