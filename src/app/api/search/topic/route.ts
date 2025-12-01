import { NextRequest, NextResponse } from 'next/server'
import { embedText } from '@/lib/openai'
import { supabaseAdmin } from '@/lib/supabase'

function expandLexical(q: string, focus?: string) {
  const base = q
  const lower = q.toLowerCase()
  const isProphecy = focus === 'prophecies-fulfilled' || /(prophec|fulfilled|messiah|christ|written|that it might be fulfilled)/i.test(lower)
  if (isProphecy) {
    const extras = [
      'prophecy', 'prophecies', 'prophet', 'prophesy', 'Messiah', 'Christ',
      'fulfill', 'fulfilled', 'that it might be fulfilled', 'as it is written',
      'scripture might be fulfilled', 'spoken by the prophet'
    ]
    const uniq = Array.from(new Set((base + ' ' + extras.join(' ')).trim().split(/\s+/))).join(' ')
    return uniq
  }
  return base
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(()=> ({}))
  const {
    question,
    topK = 12,
    hybrid = true,
    focus,                 // e.g., 'prophecies-fulfilled'
    testament,             // 'old' | 'new'
    bookId,
    bookSeqMin,
    bookSeqMax,
    pairGospels = false
  } = body || {}
  if (!question) return NextResponse.json({ error: 'Missing question' }, { status: 400 })

  const sb = supabaseAdmin()
  const embedding = await embedText(question)
  const lexical = expandLexical(question, focus)
  const { data, error } = await sb.rpc('semantic_search_verses', {
    query_embedding: embedding,
    match_count: Math.max(120, topK * 10),
    include_lexical: hybrid,
    lexical_text: hybrid ? lexical : null
  })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  type Row = { verse_id: string; book_id: string; chapter_seq: number; verse_seq: number; text: string; combined_score: number; chunk_id: string; chunk_score: number }
  const rows = (data || []) as Row[]
  const byChunk = new Map<string, Row[]>()
  for (const r of rows) {
    if (!byChunk.has(r.chunk_id)) byChunk.set(r.chunk_id, [])
    byChunk.get(r.chunk_id)!.push(r)
  }
  const chunkIds = Array.from(byChunk.keys())
  if (!chunkIds.length) return NextResponse.json({ chunks: [] })

  const { data: chunksData } = await sb
    .from('embedding_chunks')
    .select('id, book_id, start_chapter, end_chapter, chapter_numbers, verse_numbers, combined_text')
    .in('id', chunkIds)
  const chunksMap = new Map<string, any>((chunksData || []).map((c:any)=>[c.id, c]))
  const bookIds = Array.from(new Set((chunksData || []).map((c:any)=> c.book_id)))
  const { data: booksData } = await sb.from('books').select('id, title, seq').in('id', bookIds)
  const booksMap = new Map<string, any>((booksData || []).map((b:any)=>[b.id, b]))

  let cards = chunkIds.map((cid) => {
    const list = byChunk.get(cid) || []
    const meta = chunksMap.get(cid)
    const b = booksMap.get(meta?.book_id)
    const verses = list
      .sort((a,b)=> (b.combined_score ?? 0) - (a.combined_score ?? 0))
      .slice(0, 5)
      .map(v => ({ id: v.verse_id, text: v.text, similarity: v.combined_score ?? 0, seq: v.verse_seq, chapter_seq: v.chapter_seq }))
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

  if (bookId) cards = cards.filter(c => c.chunk.book_id === bookId)
  if (typeof bookSeqMin === 'number') cards = cards.filter(c => (c.chunk.book_seq ?? 0) >= bookSeqMin)
  if (typeof bookSeqMax === 'number') cards = cards.filter(c => (c.chunk.book_seq ?? 0) <= bookSeqMax)
  if (testament === 'old') cards = cards.filter(c => (c.chunk.book_seq ?? 0) <= 39)
  if (testament === 'new') cards = cards.filter(c => (c.chunk.book_seq ?? 0) >= 40)

  cards.sort((a,b)=> (b.score ?? 0) - (a.score ?? 0))
  const limited = typeof topK === 'number' && topK > 0 ? cards.slice(0, topK) : cards

  if (!pairGospels || focus !== 'prophecies-fulfilled') {
    return NextResponse.json({ chunks: limited, hybrid, focus: focus || null })
  }

  // Curated pairing: For each top OT chunk, find nearest Gospel chunk using chunk-to-chunk similarity
  const ot = limited.filter(c => (c.chunk.book_seq ?? 0) <= 39)
  if (ot.length === 0) return NextResponse.json({ chunks: limited, pairs: [], hybrid, focus })

  const pairs: any[] = []
  for (const card of ot.slice(0, Math.min(8, ot.length))) {
    try {
      const qEmb = await embedText(card.combined_text.slice(0, 4000))
      const { data: neigh } = await sb.rpc('match_embedding_chunks', { query_embedding: qEmb, match_count: 60 })
      const ids = (neigh || []).map((n:any)=> n.chunk_id)
      if (!ids?.length) continue
      const { data: metas } = await sb
        .from('embedding_chunks')
        .select('id, book_id, start_chapter, end_chapter, chapter_numbers, verse_numbers, combined_text')
        .in('id', ids)
      const bookIds2 = Array.from(new Set((metas || []).map((m:any)=> m.book_id)))
      const { data: books2 } = await sb.from('books').select('id, title, seq').in('id', bookIds2)
      const bmap2 = new Map<string, any>((books2 || []).map((b:any)=>[b.id,b]))
      // Pick best Gospel neighbor (seq 40..43)
      type Ranked = { n: any; meta: any; bk: any; seq: number; isGospel: boolean }
      const ranked: Ranked[] = (neigh || [])
        .map((n:any): Ranked => {
          const meta = (metas || []).find((m:any)=> m.id === n.chunk_id)
          const bk = meta ? bmap2.get(meta.book_id) : null
          const seq = (bk?.seq as number) || 0
          const isGospel = seq >= 40 && seq <= 43
          return { n, meta, bk, seq, isGospel }
        })
        .filter((x: Ranked) => x.isGospel)
        .sort((a: Ranked, b: Ranked)=> (b.n.score ?? 0) - (a.n.score ?? 0))
      const best = ranked[0]
      if (!best) continue
      pairs.push({ source: card, target: {
        chunk: {
          id: best.meta.id,
          book_id: best.meta.book_id,
          book_title: best.bk?.title || null,
          book_seq: best.bk?.seq || null,
          start_chapter: best.meta.start_chapter,
          end_chapter: best.meta.end_chapter,
          chapter_numbers: best.meta.chapter_numbers,
          verse_numbers: best.meta.verse_numbers
        },
        combined_text: best.meta.combined_text,
        verses: [],
        score: best.n.score
      }, pairScore: best.n.score })
    } catch {}
  }

  return NextResponse.json({ chunks: limited, pairs, hybrid, focus })
}
