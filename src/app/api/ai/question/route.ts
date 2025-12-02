import { NextRequest, NextResponse } from 'next/server'
import { embedText, chatSummary } from '@/lib/openai'
import { supabaseAdmin } from '@/lib/supabase'

// Concept/hybrid search returning top chunk cards (each card is a chunk)
export async function POST(req: NextRequest) {
  const body = await req.json()
  const {
    question,
    topK = 10,                 // number of chunk cards to return
    versesPerChapter = 3,      // legacy param: now used as top verses per chunk
    hybrid = true,
    lexicalWeight = 0.15,
    bookId,
    testament,                 // 'old' | 'new'
    bookSeqMin,
    bookSeqMax,
    verseId
  } = body || {}
  if (!question) return NextResponse.json({ error: 'Missing question' }, { status: 400 })

  const sb = supabaseAdmin()
  // Embed query
  const qVec = await embedText(question)
  // Fetch plenty of verses to allow grouping by chunk then trimming
  const approxNeeded = typeof topK === 'number' && topK > 0 ? Math.max(50, topK * Math.max(versesPerChapter, 1) * 2) : 100
  type Row = { verse_id: string; book_id: string; chapter_seq: number; verse_seq: number; text: string; combined_score: number; chunk_id: string; chunk_score: number; lexical_score: number }
  let rows: Row[] = []

  // Verse-seeded mode: if verseId provided, seed chunks using semantic neighbors to that verse’s chunk
  if (verseId) {
    const { data: seeded, error: seedErr } = await sb.rpc('semantic_search_by_verse', {
      verse_uuid: verseId,
      match_count: Math.max(approxNeeded, 50),
      exclude_self: false,
    })
    if (seedErr) return NextResponse.json({ error: seedErr.message }, { status: 500 })
    const seededRows = (seeded || []) as Array<{ verse_id: string; book_id: string; chapter_seq: number; verse_seq: number; text: string; match_chunk: string; chunk_score: number }>
    rows = seededRows.map(s => ({
      verse_id: s.verse_id,
      book_id: s.book_id,
      chapter_seq: s.chapter_seq,
      verse_seq: s.verse_seq,
      text: s.text,
      combined_score: s.chunk_score,
      chunk_id: s.match_chunk,
      chunk_score: s.chunk_score,
      lexical_score: 0,
    }))
  }

  // Blend with query-driven semantic search if needed (ensures topical alignment to the question)
  if (rows.length < approxNeeded) {
    const { data, error } = await sb.rpc('semantic_search_verses', {
      query_embedding: qVec,
      match_count: approxNeeded,
      include_lexical: hybrid,
      lexical_text: hybrid ? question : null,
      p_book_id: bookId ?? null,
      p_work_id: null,
      p_book_seq_min: (testament === 'new' ? 40 : (testament === 'old' ? 1 : (typeof bookSeqMin === 'number' ? bookSeqMin : null))),
      p_book_seq_max: (testament === 'old' ? 39 : (testament === 'new' ? 66 : (typeof bookSeqMax === 'number' ? bookSeqMax : null))),
    })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    const more = (data || []) as Row[]
    // Merge rows by verse_id (prefer higher chunk_score)
    const merged = new Map<string, Row>()
    for (const r of [...rows, ...more]) {
      const prev = merged.get(r.verse_id)
      if (!prev || (r.chunk_score ?? 0) > (prev.chunk_score ?? 0)) merged.set(r.verse_id, r)
    }
    rows = Array.from(merged.values())
  }

  // Fallback: if semantic returns nothing, try lexical trigram to seed chunks
  if (!rows.length) {
    const { data: lex } = await sb.rpc('lexical_search_verses', { q: question, match_count: approxNeeded })
    const lexRows = (lex || []) as Array<{ verse_id: string; book_id: string; chapter_seq: number; verse_seq: number; text: string; similarity: number }>
    if (lexRows.length) {
      // Map into Row shape with lexical-only scores
      rows = lexRows.map(r => ({
        verse_id: r.verse_id,
        book_id: r.book_id,
        chapter_seq: r.chapter_seq,
        verse_seq: r.verse_seq,
        text: r.text,
        combined_score: r.similarity,
        chunk_id: '' as any, // fill later via verse -> chunk lookup
        chunk_score: r.similarity,
        lexical_score: r.similarity,
      }))
      // Resolve chunk_id for these verses
      const verseIds = rows.map(r => r.verse_id)
      const { data: versesInfo } = await sb
        .from('verses')
        .select('id, chunk_id')
        .in('id', verseIds)
      const vmap = new Map((versesInfo || []).map((v: any) => [v.id, v.chunk_id]))
      rows = rows.map(r => ({ ...r, chunk_id: vmap.get(r.verse_id) }))
      rows = rows.filter(r => !!r.chunk_id)
    }
  }

  // Group by chunk
  const byChunk = new Map<string, Row[]>()
  for (const r of rows) {
    if (!byChunk.has(r.chunk_id)) byChunk.set(r.chunk_id, [])
    byChunk.get(r.chunk_id)!.push(r)
  }

  // Prepare chunk metadata lookup
  const chunkIds = Array.from(byChunk.keys())
  // Early exit if nothing
  if (chunkIds.length === 0) {
    return NextResponse.json({ chunks: [], overview: null, hybrid })
  }
  const { data: chunksData, error: chunksErr } = await sb
    .from('embedding_chunks')
    .select('id, book_id, start_chapter, end_chapter, chapter_numbers, verse_numbers, combined_text')
    .in('id', chunkIds)
  if (chunksErr) return NextResponse.json({ error: chunksErr.message }, { status: 500 })
  const chunksMap = new Map<string, any>((chunksData || []).map((c:any)=>[c.id, c]))

  // Fetch book info for labels and seq filtering
  const bookIds = Array.from(new Set((chunksData || []).map((c:any)=> c.book_id)))
  const { data: booksData } = await sb.from('books').select('id, title, seq').in('id', bookIds)
  const booksMap = new Map<string, any>((booksData || []).map((b:any)=>[b.id, b]))

  // Build chunk cards and apply filters
  let cards = chunkIds.map((cid) => {
    const list = byChunk.get(cid) || []
    const meta = chunksMap.get(cid)
    const b = booksMap.get(meta?.book_id)
    const verses = list
      .map(v => ({
        id: v.verse_id,
        text: v.text,
        seq: v.verse_seq,
        chapter_seq: v.chapter_seq,
        similarity: (v.chunk_score ?? 0) + (hybrid ? (v.lexical_score ?? 0) * (Number(lexicalWeight) || 0) : 0)
      }))
      .sort((a,b)=> (b.similarity ?? 0) - (a.similarity ?? 0))
      .slice(0, Math.max(1, versesPerChapter))
    const score = Math.max(...list.map(x=> x.chunk_score ?? 0))
    return {
      chunk: {
        id: cid,
        book_id: meta?.book_id || null,
        book_title: b?.title || null,
        book_seq: b?.seq || null,
        start_chapter: meta?.start_chapter || null,
        end_chapter: meta?.end_chapter || null,
        chapter_numbers: meta?.chapter_numbers || [],
        verse_numbers: meta?.verse_numbers || [],
      },
      combined_text: meta?.combined_text || '',
      verses,
      score
    }
  })

  // Optional: Pin a verse's chunk by ensuring its card is present and computing its chunk similarity to the query
  if (verseId) {
    // Find the chunk for the verse
    const { data: vInfo } = await sb.from('verses').select('id, chunk_id, book_id, chapter_seq, verse_seq, text').eq('id', verseId).limit(1)
    const vRow = (vInfo || [])[0] as any
    const pinnedChunkId: string | undefined = vRow?.chunk_id
    if (pinnedChunkId) {
      // Compute similarity score for pinned chunk via neighbors list
      const { data: neighborChunks } = await sb.rpc('match_embedding_chunks', { query_embedding: qVec, match_count: Math.max(100, topK * 5) })
      const neighborMap = new Map<string, number>((neighborChunks || []).map((n: any) => [n.chunk_id, n.score]))
      const pinnedScore = neighborMap.get(pinnedChunkId) ?? 0
      // If the card isn't present, add it with minimal verses (including the pinned verse if available)
      const existsIdx = cards.findIndex(c => c.chunk.id === pinnedChunkId)
      if (existsIdx === -1) {
        // Fetch chunk meta if missing
        let meta = chunksMap.get(pinnedChunkId)
        if (!meta) {
          const { data: pinnedChunkData } = await sb
            .from('embedding_chunks')
            .select('id, book_id, start_chapter, end_chapter, chapter_numbers, verse_numbers, combined_text')
            .eq('id', pinnedChunkId)
            .limit(1)
          meta = (pinnedChunkData || [])[0]
        }
        const b = booksMap.get(meta?.book_id)
        // Fetch a few verses from the chunk to populate
        const { data: pinnedVerses } = await sb
          .from('verses')
          .select('id, text, chapter_seq, verse_seq')
          .eq('chunk_id', pinnedChunkId)
          .order('chapter_seq', { ascending: true })
          .order('verse_seq', { ascending: true })
          .limit(Math.max(1, versesPerChapter))
        const verses = (pinnedVerses || []).map((v: any) => ({ id: v.id, text: v.text, seq: v.verse_seq, chapter_seq: v.chapter_seq, similarity: pinnedScore }))
        cards.unshift({
          chunk: {
            id: pinnedChunkId,
            book_id: meta?.book_id || null,
            book_title: b?.title || null,
            book_seq: b?.seq || null,
            start_chapter: meta?.start_chapter || null,
            end_chapter: meta?.end_chapter || null,
            chapter_numbers: meta?.chapter_numbers || [],
            verse_numbers: meta?.verse_numbers || [],
          },
          combined_text: meta?.combined_text || '',
          verses,
          score: pinnedScore,
        })
      } else {
        // If present, bump its score and ensure pinned verse is highlighted
        const existing = cards[existsIdx]
        existing.score = Math.max(Number(existing.score || 0), pinnedScore)
        if (vRow?.id) {
          const hasPinned = existing.verses.some((vv: any) => String(vv.id) === String(vRow.id))
          if (!hasPinned) {
            existing.verses.unshift({ id: vRow.id, text: vRow.text, seq: vRow.verse_seq, chapter_seq: vRow.chapter_seq, similarity: pinnedScore })
            existing.verses = existing.verses.slice(0, Math.max(1, versesPerChapter))
          }
        }
        // Move pinned to front
        cards.splice(existsIdx, 1)
        cards.unshift(existing)
      }
    }
  }

  // Apply optional filters
  if (bookId) cards = cards.filter(c => c.chunk.book_id === bookId)
  if (typeof bookSeqMin === 'number') cards = cards.filter(c => (c.chunk.book_seq ?? 0) >= bookSeqMin)
  if (typeof bookSeqMax === 'number') cards = cards.filter(c => (c.chunk.book_seq ?? 9999) <= bookSeqMax)
  if (testament === 'old') cards = cards.filter(c => (c.chunk.book_seq ?? 0) <= 39)
  if (testament === 'new') cards = cards.filter(c => (c.chunk.book_seq ?? 0) >= 40)

  cards.sort((a,b)=> (b.score ?? 0) - (a.score ?? 0))
  // Backfill: if fewer unique chunks than requested, pull more nearest chunks directly
  if (typeof topK === 'number' && topK > 0 && cards.length < topK) {
    const deficit = topK - cards.length
    const { data: neighborChunks } = await sb.rpc('match_embedding_chunks', {
      query_embedding: qVec,
      match_count: Math.max(topK * 2, deficit * 5),
      p_book_id: bookId ?? null,
      p_work_id: null,
      p_book_seq_min: (testament === 'new' ? 40 : (testament === 'old' ? 1 : (typeof bookSeqMin === 'number' ? bookSeqMin : null))),
      p_book_seq_max: (testament === 'old' ? 39 : (testament === 'new' ? 66 : (typeof bookSeqMax === 'number' ? bookSeqMax : null))),
    })
    const existingIds = new Set(cards.map(c => c.chunk.id))
    const toAdd = (neighborChunks || [])
      .map((n: any) => ({ id: n.chunk_id as string, score: n.score as number }))
      .filter((n: { id: string; score: number }) => !existingIds.has(n.id))
      .slice(0, deficit)
    if (toAdd.length) {
      const addIds = toAdd.map((n: { id: string; score: number }) => n.id)
      const { data: addMeta } = await sb
        .from('embedding_chunks')
        .select('id, book_id, start_chapter, end_chapter, chapter_numbers, verse_numbers, combined_text')
        .in('id', addIds)
      // prefetch small set of verses per added chunk
      const { data: addVerses } = await sb
        .from('verses')
        .select('id, text, chapter_seq, verse_seq, chunk_id')
        .in('chunk_id', addIds)
        .order('chapter_seq', { ascending: true })
        .order('verse_seq', { ascending: true })
      const addMetaMap = new Map<string, any>((addMeta || []).map((m: any) => [m.id, m]))
      const addVersesMap = new Map<string, any[]>(addIds.map((id: string) => [id, [] as any[]]))
      for (const v of (addVerses || [])) {
        const arr = addVersesMap.get(v.chunk_id)
        if (arr) arr.push(v)
      }
      for (const n of toAdd) {
        const meta = addMetaMap.get(n.id)
        const b = booksMap.get(meta?.book_id)
        const verses = (addVersesMap.get(n.id) || [])
          .map((v: any) => ({ id: v.id, text: v.text, seq: v.verse_seq, chapter_seq: v.chapter_seq, similarity: n.score }))
          .slice(0, Math.max(1, versesPerChapter))
        cards.push({
          chunk: {
            id: n.id,
            book_id: meta?.book_id || null,
            book_title: b?.title || null,
            book_seq: b?.seq || null,
            start_chapter: meta?.start_chapter || null,
            end_chapter: meta?.end_chapter || null,
            chapter_numbers: meta?.chapter_numbers || [],
            verse_numbers: meta?.verse_numbers || [],
          },
          combined_text: meta?.combined_text || '',
          verses,
          score: n.score,
        })
      }
    }
  }

  cards.sort((a,b)=> (b.score ?? 0) - (a.score ?? 0))
  const limited = typeof topK === 'number' && topK > 0 ? cards.slice(0, topK) : cards

  // Summarize briefly from the combined texts of top cards
  let overview: string | null = null
  try {
    const snippet = limited.map(r => `[${r.chunk.book_title || 'Book'} ${r.chunk.start_chapter}${r.chunk.end_chapter && r.chunk.end_chapter!==r.chunk.start_chapter ? '–'+r.chunk.end_chapter : ''}] ${r.combined_text.slice(0, 400)}`).join(' \n ')
    overview = await chatSummary('Briefly summarize common themes (2-4 sentences).', snippet)
  } catch {}

  return NextResponse.json({ chunks: limited, overview, hybrid })
}
