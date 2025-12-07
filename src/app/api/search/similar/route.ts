import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { embedText } from '@/lib/openai'

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
  let rows = (data || []) as Array<{ verse_id: string; book_id: string; chapter_seq: number; verse_seq: number; text: string; chunk_id: string; chunk_score: number }>
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
          chunk_id: r.match_chunk || r.chunk_id || null,
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

  // Group by chunk_id to return whole chunks (3-10 verses)
  const groups = new Map<string, { book_id: string; chapter_seq: number; chunk_score: number }>()
  for (const r of rows) {
    if (!r.chunk_id) continue
    const k = r.chunk_id
    const existing = groups.get(k)
    if (!existing || (r.chunk_score ?? 0) > (existing.chunk_score ?? 0)) {
      groups.set(k, { book_id: r.book_id, chapter_seq: r.chapter_seq, chunk_score: r.chunk_score ?? 0 })
    }
  }
  const chunkIds = Array.from(groups.keys())
  // Fetch all verses for matched chunks
  const { data: chunkVerses } = await sb.from('verses')
    .select('id, book_id, chapter_seq, verse_seq, text, chunk_id')
    .in('chunk_id', chunkIds)
    .order('chapter_seq', { ascending: true })
    .order('verse_seq', { ascending: true })
  const versesByChunk = new Map<string, Array<any>>()
  for (const v of (chunkVerses || [])) {
    const k = (v as any).chunk_id
    if (!versesByChunk.has(k)) versesByChunk.set(k, [])
    versesByChunk.get(k)!.push(v)
  }
  // Lookup chapter ids for linking (from the first verse's chapter)
  const chKeys = Array.from(new Set(Array.from(versesByChunk.values()).map(list => {
    const first = list[0]
    return first ? `${first.book_id}:${first.chapter_seq}` : null
  }).filter(Boolean) as string[]))
  const bookIds = Array.from(new Set(chKeys.map(k => k.split(':')[0])))
  const { data: chapters } = await sb.from('chapters').select('id, book_id, seq, title').in('book_id', bookIds)
  const chapterMap = new Map<string, any>((chapters || []).map((c: any) => [`${c.book_id}:${c.seq}`, c]))
  // Build suggestions: one entry per chunk with full verses
  const suggestions = Array.from(groups.entries())
    .sort((a,b)=> (b[1].chunk_score ?? 0) - (a[1].chunk_score ?? 0))
    .map(([chunkId, meta]) => {
      const list = versesByChunk.get(chunkId) || []
      const chKey = list.length ? `${list[0].book_id}:${list[0].chapter_seq}` : `${meta.book_id}:${meta.chapter_seq}`
      const ch = chapterMap.get(chKey)
      return {
        chapter: ch ? { id: ch.id, title: ch.title, seq: ch.seq, book_id: ch.book_id } : { id: null, title: null, seq: Number(chKey.split(':')[1]), book_id: chKey.split(':')[0] },
        chunk_id: chunkId,
        verses: list.map(v => ({ id: v.id, seq: v.verse_seq, text: v.text }))
      }
    })
  // Flatten ids for highlighting
  const relevantVerseIds = suggestions.flatMap(s => s.verses.map(v => v.id))

  // Optional short summary
  return NextResponse.json({ suggestions, relevantVerseIds })
}
