import { NextRequest, NextResponse } from 'next/server'
import { embedText, chatSummary } from '@/lib/openai'
import { supabaseAdmin } from '@/lib/supabase'

// Concept/hybrid search returning grouped verses by chapter using chunk-level embeddings
export async function POST(req: NextRequest) {
  const { question, topK = 10, versePerChapter = 3, hybrid = true } = await req.json()
  if (!question) return NextResponse.json({ error: 'Missing question' }, { status: 400 })

  const sb = supabaseAdmin()
  // Embed query
  const qVec = await embedText(question)
  // Call semantic verse search RPC (optionally include lexical boost via the question text)
  const { data, error } = await sb.rpc('semantic_search_verses', {
    query_embedding: qVec,
    match_count: Math.max(25, topK * Math.max(versePerChapter, 1)),
    include_lexical: hybrid,
    lexical_text: hybrid ? question : null
  })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  const rows = (data || []) as Array<{ verse_id: string; book_id: string; chapter_seq: number; verse_seq: number; text: string; combined_score: number }>

  // Group by (book_id, chapter_seq)
  const groups = new Map<string, Array<typeof rows[number]>>()
  for (const r of rows) {
    const k = `${r.book_id}:${r.chapter_seq}`
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k)!.push(r)
  }
  // Limit verses per chapter and collect chapter lookup keys
  const chaptersNeeded: Array<{ book_id: string; chapter_seq: number }> = []
  const grouped = Array.from(groups.entries()).map(([k, list]) => {
    const [book_id, chapter_seq_str] = k.split(':')
    const chapter_seq = Number(chapter_seq_str)
    chaptersNeeded.push({ book_id, chapter_seq })
    const verses = list
      .sort((a,b)=> (b.combined_score ?? 0) - (a.combined_score ?? 0))
      .slice(0, versePerChapter)
      .map(v => ({ id: v.verse_id, text: v.text, similarity: v.combined_score ?? 0, seq: v.verse_seq }))
    const score = verses.reduce((s,v)=>s+(v.similarity||0),0) / Math.max(1, verses.length)
    return { key: k, book_id, chapter_seq, verses, score }
  })

  // Lookup chapter IDs so UI can link to /read
  let chaptersInfo: any[] = []
  if (chaptersNeeded.length) {
    // Build OR filter: (book_id=.. and seq=.. ) pairs
    // Supabase JS doesn’t support composite IN; fetch by all book_ids and filter client-side
    const bookIds = Array.from(new Set(chaptersNeeded.map(c => c.book_id)))
    const { data: chAll } = await sb.from('chapters').select('id, book_id, seq, title').in('book_id', bookIds)
    chaptersInfo = chAll || []
  }
  const chapterIdMap = new Map<string, any>()
  for (const ch of chaptersInfo) {
    chapterIdMap.set(`${ch.book_id}:${ch.seq}`, ch)
  }

  const results = grouped
    .sort((a,b)=> b.score - a.score)
    .slice(0, topK)
    .map(g => ({
      chapter: {
        id: chapterIdMap.get(`${g.book_id}:${g.chapter_seq}`)?.id || null,
        book_id: g.book_id,
        seq: g.chapter_seq,
        title: chapterIdMap.get(`${g.book_id}:${g.chapter_seq}`)?.title || null,
      },
      verses: g.verses,
      score: g.score
    }))

  // Summarize briefly
  let overview: string | null = null
  try {
    const snippet = results.map(r => `[${r.chapter.title || `Chapter ${r.chapter.seq}`}] ${r.verses.map(v=>v.text).join(' | ')}`).join(' ; ')
    overview = await chatSummary('Briefly summarize common themes (2-4 sentences).', snippet)
  } catch {}

  return NextResponse.json({ results, overview, hybrid, expanded: null })
}
