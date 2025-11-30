import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { chatSummary } from '@/lib/openai'

export async function POST(req: NextRequest) {
  const { verseId, topK = 10, excludeSameChapter = true, bookId, testament, diversity = 0, workId, bookSeqMin, bookSeqMax } = await req.json()
  if (!verseId) return NextResponse.json({ error: 'Missing verseId' }, { status: 400 })
  const sb = supabaseAdmin()

  const { data: verse } = await sb.from('verses').select('*').eq('id', verseId).single()
  if (!verse?.embedding) return NextResponse.json({ error: 'Verse has no embedding' }, { status: 400 })

  // find nearest chapters by cosine distance with fallback
  let chapters: any[] = []
  try {
    const { data } = await sb.rpc('match_chapters', { query_embedding: verse.embedding, match_count: topK })
    chapters = data || []
  } catch (e) {
    const { data } = await sb
      .from('chapters')
      .select('id, title, seq, work_id, book_id, embedding')
      .not('embedding', 'is', null)
      .limit(topK)
    chapters = data || []
  }

  // Optional filters
  if (excludeSameChapter) {
    chapters = chapters.filter((c: any) => c.id !== verse.chapter_id)
  }
  if (bookId) {
    chapters = chapters.filter((c: any) => c.book_id === bookId)
  }
  // Dynamic filtering via books.seq and work_id
  if (testament || workId || (typeof bookSeqMin === 'number') || (typeof bookSeqMax === 'number')) {
    const sb2 = supabaseAdmin()
    const bookIds = Array.from(new Set(chapters.map((c: any) => c.book_id).filter(Boolean))) as string[]
    const { data: books } = await sb2.from('books').select('id, seq, work_id').in('id', bookIds)
    const seqMap = new Map<string, number>((books || []).map(b => [b.id as unknown as string, b.seq as unknown as number]))
    const workMap = new Map<string, string>((books || []).map(b => [b.id as unknown as string, b.work_id as unknown as string]))
    chapters = chapters.filter((c: any) => {
      const seq = seqMap.get(c.book_id)
      const chWorkId = workMap.get(c.book_id)
      if (workId && chWorkId !== workId) return false
      if (typeof bookSeqMin === 'number' && typeof seq === 'number' && seq < bookSeqMin) return false
      if (typeof bookSeqMax === 'number' && typeof seq === 'number' && seq > bookSeqMax) return false
      if (testament === 'old') return typeof seq === 'number' && seq >= 1 && seq <= 39
      if (testament === 'new') return typeof seq === 'number' && seq >= 40 && seq <= 66
      return true
    })
  }

  // Diversity via simple MMR (Maximal Marginal Relevance) on chapter embeddings
  if (diversity > 0) {
    chapters = mmrSelect(chapters, verse.embedding, topK, diversity)
  }

  // For each chapter, suggest relevant verses by comparing to the verse embedding
  const suggestions: any[] = []
  for (const ch of chapters) {
    const { data: verses } = await sb
      .from('verses')
      .select('id, seq, text, embedding')
      .eq('chapter_id', ch.id)

    const withScore = (verses || [])
      .filter(v => v.embedding)
      .map(v => ({ ...v, score: cosineSim(verse.embedding, v.embedding) }))
      .sort((a,b)=>b.score-a.score)
      .slice(0, 3)
    suggestions.push({ chapter: ch, verses: withScore })
  }

  // Summary via GPT
  const summary = await chatSummary(
    'You summarize relationships between two scripture passages briefly in 2-3 sentences.',
    `Target verse: ${verse.text}\n\nTop related chapters and sample verses: ${suggestions.map(s=>`[${s.chapter.title}] ${s.verses.map((v:any)=>v.text).join(' | ')}`).join(' ; ')}`
  )

  const relevantVerseIds = suggestions.flatMap(s => s.verses.map((v:any)=>v.id))
  return NextResponse.json({ suggestions, summary, relevantVerseIds })
}

function cosineSim(a: number[], b: number[]) {
  let dot = 0, na = 0, nb = 0
  for (let i=0;i<a.length && i<b.length;i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i] }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-8)
}

function mmrSelect(items: any[], queryEmb: number[], k: number, lambda: number) {
  const selected: any[] = []
  const remaining = [...items]
  while (selected.length < Math.min(k, items.length) && remaining.length > 0) {
    let bestIdx = 0
    let bestScore = -Infinity
    for (let i = 0; i < remaining.length; i++) {
      const item = remaining[i]
      const rel = cosineSim(queryEmb, item.embedding || [])
      let div = 0
      if (selected.length > 0) {
        div = Math.max(...selected.map(s => cosineSim(s.embedding || [], item.embedding || [])))
      }
      const score = lambda * rel - (1 - lambda) * div
      if (score > bestScore) { bestScore = score; bestIdx = i }
    }
    selected.push(remaining.splice(bestIdx, 1)[0])
  }
  return selected
}
