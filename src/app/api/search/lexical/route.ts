import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

/**
 * Lexical search using pg_trgm with robust fallbacks.
 * Supports `mode`: 'verses' | 'chapters', optional `bookId`, and `minSimilarity`.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    query?: string
    topK?: number
    mode?: 'verses' | 'chapters'
    bookId?: string
    workId?: string
    bookSeqMin?: number
    bookSeqMax?: number
    minSimilarity?: number
    exactWord?: boolean
  }

  const queryRaw = body.query ?? ''
  const query = queryRaw.replace(/\s+/g, ' ').trim()
  const topK = body.topK ?? 20
  const mode = body.mode ?? 'verses'
  const bookId = body.bookId
  const workId = body.workId
  const bookSeqMin = body.bookSeqMin
  const bookSeqMax = body.bookSeqMax
  const minSimilarity = Math.max(0, Math.min(1, body.minSimilarity ?? 0.1))
  const exactWord = !!body.exactWord

  if (!query || query.length < 2) {
    return NextResponse.json({ error: 'Query string required' }, { status: 400 })
  }

  const sb = supabaseAdmin()

  if (mode === 'verses') {
    // Exact single-word mode: use regex word boundaries via RPC and return immediately (no substring fallbacks)
    const isSingleWord = !query.includes(' ')
    if (exactWord && isSingleWord) {
      const { data: exact } = await sb.rpc('lexical_search_word_exact', {
        q: query,
        match_count: topK,
        p_book_id: bookId ?? null,
        p_work_id: workId ?? null,
        p_book_seq_min: bookSeqMin ?? null,
        p_book_seq_max: bookSeqMax ?? null,
      })
      const rows = (exact || []) as Array<{ verse_id: string; book_id: string; chapter_seq: number; verse_seq: number; text: string }>
      // Enrich and return (even if empty, honor exact-only semantics)
      if (!rows.length) return NextResponse.json({ results: [], mode })
      const bookIds = Array.from(new Set(rows.map((r) => r.book_id)))
      const { data: chAll } = await sb.from('chapters').select('id, book_id, seq').in('book_id', bookIds)
      const { data: booksInfo } = await sb.from('books').select('id, title').in('id', bookIds)
      const chapterMap = new Map<string, any>((chAll || []).map((c: any) => [`${c.book_id}:${c.seq}`, c]))
      const booksMap = new Map<string, any>((booksInfo || []).map((b: any) => [b.id, b]))
      const mapped = rows.map((r) => {
        const ch = chapterMap.get(`${r.book_id}:${r.chapter_seq}`)
        const bk = booksMap.get(r.book_id)
        return {
          id: r.verse_id,
          text: r.text,
          similarity: 1, // exact match
          book_id: r.book_id,
          book_title: bk?.title || null,
          chapter_id: ch?.id || null,
          chapter_seq: r.chapter_seq,
          seq: r.verse_seq,
        }
      })
      return NextResponse.json({ results: mapped.slice(0, topK), mode })
    }

    // Default trigram-based search
    const { data, error } = await sb.rpc('lexical_search_verses', {
      q: query,
      match_count: topK,
      p_book_id: bookId ?? null,
      p_work_id: workId ?? null,
      p_book_seq_min: bookSeqMin ?? null,
      p_book_seq_max: bookSeqMax ?? null,
    })
    let results = data || []

    if (error || results.length === 0) {
      // Fallback 1: phrase ILIKE
      const like = `%${query}%`
      const { data: byPhrase } = await sb
        .from('verses')
        .select('id, book_id, chapter_seq, verse_seq, text')
        .ilike('text', like)
        .limit(topK)
      let verses: any[] = byPhrase || []

      // Fallback 2: word-level OR ILIKE
      if (!verses.length) {
        const words = query
          .split(/\s+/)
          .filter((w) => w.length > 1)
          .map((w) => `%${w}%`)
        if (words.length) {
          const orExpr = words.map((w) => `text.ilike.${w}`).join(',')
          const { data: byWords } = await sb
            .from('verses')
            .select('id, book_id, chapter_seq, verse_seq, text')
            .or(orExpr)
            .limit(topK)
          verses = (byWords as any[]) || []
        }
      }

      // Fallback 3: chunk text ILIKE -> verses in matched chunks
      if (!verses.length) {
        const { data: chunks } = await sb
          .from('embedding_chunks')
          .select('id')
          .ilike('combined_text', `%${query}%`)
          .limit(topK * 2)
        const chunkIds = (chunks || []).map((c: any) => c.id)
        if (chunkIds.length) {
          const { data: versesFromChunks } = await sb
            .from('verses')
            .select('id, book_id, chapter_seq, verse_seq, text')
            .in('chunk_id', chunkIds)
            .ilike('text', `%${query}%`)
            .limit(topK)
          verses = (versesFromChunks as any[]) || []
        }
      }

      // Optional book filter early
      if (bookId && verses.length) {
        verses = verses.filter((v: any) => v.book_id === bookId)
      }

      // Enrich verses with chapter + book info for reference formatting
      if (verses.length) {
        const bookIdsSet = new Set<string>(verses.map((v: any) => v.book_id))
        const bookIdsArr = Array.from(bookIdsSet)
        const { data: chaptersInfo } = await sb
          .from('chapters')
          .select('id, seq, book_id')
          .in('book_id', bookIdsArr)
        const { data: booksData } = await sb
          .from('books')
          .select('id, title')
          .in('id', bookIdsArr)
        const chaptersMap = new Map<string, any>((chaptersInfo || []).map((c: any) => [`${c.book_id}:${c.seq}`, c]))
        const booksMap = new Map<string, any>((booksData || []).map((b: any) => [b.id, b]))
        verses = verses.map((v: any) => {
          const ch = chaptersMap.get(`${v.book_id}:${v.chapter_seq}`)
          const bk = booksMap.get(v.book_id)
          return {
            id: v.id,
            text: v.text,
            similarity: null as any,
            book_id: v.book_id,
            book_title: bk?.title || null,
            chapter_id: ch?.id || null,
            chapter_seq: v.chapter_seq,
            seq: v.verse_seq,
          }
        })
      }

      // Last resort: if still empty, try RPC with first word only
      if (!verses.length) {
        const first = query.split(/\s+/)[0]
        if (first) {
          const { data: byFirst } = await sb.rpc('lexical_search_verses', { q: first, match_count: topK })
          const rows = (byFirst as Array<{ verse_id: string; book_id: string; chapter_seq: number; verse_seq: number; text: string; similarity: number }>) || []
          if (rows.length) {
            const mapped = rows.map((r) => ({
              id: r.verse_id,
              text: r.text,
              similarity: r.similarity,
              book_id: r.book_id,
              book_title: null,
              chapter_id: null,
              chapter_seq: r.chapter_seq,
              seq: r.verse_seq,
            }))
            return NextResponse.json({ results: mapped.slice(0, topK), mode })
          }
        }
      }

      return NextResponse.json({ results: verses, mode })
    }

    // Enrich RPC rows (verse_id, book_id, chapter_seq, verse_seq, text, similarity)
    const rows = results as Array<{
      verse_id: string
      book_id: string
      chapter_seq: number
      verse_seq: number
      text: string
      similarity: number
    }>
    const bookIds = Array.from(new Set(rows.map((r) => r.book_id)))
    // Resolve chapter IDs by (book_id, chapter_seq)
    const { data: chAll } = await sb
      .from('chapters')
      .select('id, book_id, seq')
      .in('book_id', bookIds)
    const chapters = chAll || []
    const chapterKey = (b: string, s: number) => `${b}:${s}`
    const chapterMap = new Map<string, any>(chapters.map((c: any) => [chapterKey(c.book_id, c.seq), c]))
    // Fetch books for titles
    const { data: booksInfo } = await sb
      .from('books')
      .select('id, title')
      .in('id', bookIds)
    const booksMap = new Map<string, any>((booksInfo || []).map((b: any) => [b.id, b]))

    let enriched = rows.map((r) => {
      const ch = chapterMap.get(chapterKey(r.book_id, r.chapter_seq))
      const bk = booksMap.get(r.book_id)
      return {
        id: r.verse_id,
        text: r.text,
        similarity: r.similarity,
        book_id: r.book_id,
        book_title: bk?.title || null,
        chapter_id: ch?.id || null,
        chapter_seq: r.chapter_seq,
        seq: r.verse_seq,
      }
    })
    // Note: filtering now happens inside RPC; the below filter is redundant but harmless
    if (bookId) enriched = enriched.filter((r) => r.book_id === bookId)
    // If nothing passes the threshold, return the topK without filtering to avoid empty results
    const filtered = enriched.filter((r) => (r.similarity ?? 0) >= minSimilarity)
    enriched = filtered.length ? filtered : enriched.slice(0, topK)
    return NextResponse.json({ results: enriched, mode })
  }

  // Chapters mode
  // Note: lexical_search_chapters RPC may not exist; fall back if RPC errors
  const { data: dataCh, error: errCh } = await sb.rpc('lexical_search_chapters', { q: query, match_count: topK })
  let chaptersRes = dataCh || []

  if (errCh || chaptersRes.length === 0) {
    const like = `%${query}%`
    const { data: byTitle } = await sb
      .from('chapters')
      .select('id, seq, title, book_id')
      .ilike('title', like)
      .limit(topK)
    let chapters = byTitle || []

    const words = query
      .split(/\s+/)
      .filter((w) => w.length > 1)
      .map((w) => `%${w}%`)

    // Fallback: chapter title words
    if (!chapters.length && words.length) {
      const orTitle = words.map((w) => `title.ilike.${w}`).join(',')
      const { data: byTitleWords } = await sb
        .from('chapters')
        .select('id, seq, title, book_id')
        .or(orTitle)
        .limit(topK)
      chapters = byTitleWords || []
    }

    // Fallback: books matched by title words -> chapters
    if (!chapters.length && words.length) {
      const orBooks = words.map((w) => `title.ilike.${w}`).join(',')
      const { data: booksMatch } = await sb.from('books').select('id').or(orBooks).limit(5)
      const byBookIds = (booksMatch || []).map((b: any) => b.id)
      if (byBookIds.length) {
        const { data: chByBooks } = await sb
          .from('chapters')
          .select('id, seq, title, book_id')
          .in('book_id', byBookIds)
          .limit(topK)
        chapters = chByBooks || []
      }
    }

    // Fallback: collapse verse word matches to chapters
    if (!chapters.length && words.length) {
      const orText = words.map((w) => `text.ilike.${w}`).join(',')
      const { data: versesMatch } = await sb
        .from('verses')
        .select('chapter_id')
        .or(orText)
        .limit(topK * 5)
      const chapterIds = Array.from(new Set((versesMatch || []).map((v: any) => v.chapter_id)))
      if (chapterIds.length) {
        const { data: chFromIds } = await sb
          .from('chapters')
          .select('id, seq, title, book_id')
          .in('id', chapterIds)
          .limit(topK)
        chapters = chFromIds || []
      }
    }

    return NextResponse.json({ results: chapters, mode })
  }

  if (bookId) chaptersRes = chaptersRes.filter((r: any) => r.book_id === bookId)
  // Apply threshold with fallback to topK
  const chFiltered = chaptersRes.filter((r: any) => (r.similarity ?? 0) >= minSimilarity)
  chaptersRes = chFiltered.length ? chFiltered : (chaptersRes as any[]).slice(0, topK)
  return NextResponse.json({ results: chaptersRes, mode })
}
