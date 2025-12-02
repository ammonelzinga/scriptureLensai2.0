import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { chatSummary, embedText } from '@/lib/openai'

// Similar verses given a verseId using chunk-level embeddings
export async function POST(req: NextRequest) {
  const { verseId, topK = 10, excludeSelf = false, excludeSameChapter = false, excludeSameBook = false, excludeSameWork = false, bookId, workId, bookSeqMin, bookSeqMax } = await req.json()
  if (!verseId) return NextResponse.json({ error: 'Missing verseId' }, { status: 400 })
  const sb = supabaseAdmin()

  // Fetch target verse for summary context
  const { data: target } = await sb.from('verses').select('id, text, book_id, chapter_seq, verse_seq, chunk_id').eq('id', verseId).maybeSingle()
  // Resolve target work_id via book
  let targetWorkId: string | null = null
  if (target?.book_id) {
    const { data: book } = await sb.from('books').select('id, work_id').eq('id', target.book_id).maybeSingle()
    targetWorkId = (book as any)?.work_id ?? null
  }

  // Use RPC to find similar verses via the verse's chunk embedding
  const { data, error } = await sb.rpc('semantic_search_by_verse', {
    verse_uuid: verseId,
    match_count: topK,
    exclude_self: !!excludeSelf ? true : false,
    p_book_id: bookId ?? null,
    p_work_id: workId ?? null,
    p_book_seq_min: bookSeqMin ?? null,
    p_book_seq_max: bookSeqMax ?? null,
  })
  let rows = (data || []) as Array<{ verse_id: string; book_id: string; chapter_seq: number; verse_seq: number; text: string; chunk_score: number }>
  // Fallback: if RPC failed or returned no rows, use the verse text embedding directly
  if (error || rows.length === 0) {
    try {
      if (!target?.text) throw new Error('Missing target verse text')
      const embedding = await embedText(target.text)
      const { data: alt, error: altErr } = await sb.rpc('semantic_search_verses', {
        query_embedding: embedding,
        match_count: topK,
        include_lexical: false,
        lexical_text: null,
        p_book_id: bookId ?? null,
        p_work_id: workId ?? null,
        p_book_seq_min: bookSeqMin ?? null,
        p_book_seq_max: bookSeqMax ?? null,
      })
      if (!altErr && Array.isArray(alt)) {
        rows = (alt as any[]).map(r => ({
          verse_id: r.verse_id || r.id,
          book_id: r.book_id,
          chapter_seq: r.chapter_seq,
          verse_seq: r.verse_seq,
          text: r.text,
          chunk_score: r.chunk_score ?? r.score ?? 0
        }))
      }
    } catch {}
  }

  // Exclude results based on user filters
  if (target?.book_id) {
    if (excludeSameChapter && typeof target.chapter_seq === 'number') {
      rows = rows.filter(r => !(r.book_id === target.book_id && r.chapter_seq === target.chapter_seq))
    }
    if (excludeSameBook) {
      rows = rows.filter(r => r.book_id !== target.book_id)
    }
  }
  if (excludeSameWork && targetWorkId) {
    // Map row book_ids to work_ids and filter
    const bookIds = Array.from(new Set(rows.map(r => r.book_id)))
    const { data: rowBooks } = await sb.from('books').select('id, work_id').in('id', bookIds)
    const workByBook = new Map<string, string>((rowBooks || []).map((b: any) => [b.id, b.work_id]))
    rows = rows.filter(r => workByBook.get(r.book_id) !== targetWorkId)
  }

  // Group by chapter (book_id + chapter_seq)
  const groups = new Map<string, Array<typeof rows[number]>>()
  for (const r of rows) {
    const k = `${r.book_id}:${r.chapter_seq}`
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k)!.push(r)
  }
  // Lookup chapter ids for linking
  const bookIds = Array.from(new Set(rows.map(r => r.book_id)))
  const { data: chapters } = await sb.from('chapters').select('id, book_id, seq, title').in('book_id', bookIds)
  const chapterMap = new Map<string, any>((chapters || []).map((c: any) => [`${c.book_id}:${c.seq}`, c]))

  // Build suggestions: top up to 3 verses per chapter group
  const suggestions = Array.from(groups.entries()).map(([k, list]) => {
    const ch = chapterMap.get(k)
    const topVerses = list
      .sort((a,b)=> (b.chunk_score ?? 0) - (a.chunk_score ?? 0))
      .slice(0, 3)
      .map(v => ({ id: v.verse_id, seq: v.verse_seq, text: v.text }))
    return {
      chapter: ch ? { id: ch.id, title: ch.title, seq: ch.seq, book_id: ch.book_id } : { id: null, title: null, seq: Number(k.split(':')[1]), book_id: k.split(':')[0] },
      verses: topVerses
    }
  })
  // Flatten ids for highlighting
  const relevantVerseIds = suggestions.flatMap(s => s.verses.map(v => v.id))

  // Optional short summary
  let summary: string | null = null
  try {
    const context = suggestions.map(s => `[${s.chapter.title || `Chapter ${s.chapter.seq}`}] ${s.verses.map(v=>v.text).join(' | ')}`).join(' ; ')
    summary = await chatSummary('Briefly (1-2 sentences) describe how these passages relate to the target.', `Target: ${target?.text || ''}\n${context}`)
  } catch {}

  return NextResponse.json({ suggestions, summary, relevantVerseIds })
}
