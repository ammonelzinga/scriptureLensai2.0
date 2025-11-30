import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

/**
 * Lexical search using pg_trgm with robust fallbacks.
 * Supports `mode`: 'verses' | 'chapters', optional `bookId`, and `minSimilarity`.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as {
    query?: string
    topK?: number
    mode?: 'verses' | 'chapters'
    bookId?: number
    minSimilarity?: number
  }

  const query = (body.query ?? '').trim()
  const topK = body.topK ?? 20
  const mode = body.mode ?? 'verses'
  const bookId = body.bookId
  const minSimilarity = body.minSimilarity ?? 0.2

  if (!query || query.length < 2) {
    return NextResponse.json({ error: 'Query string required' }, { status: 400 })
  }

  const sb = supabaseAdmin()

  if (mode === 'verses') {
    const { data, error } = await sb.rpc('lexical_search_verses', { q: query, match_count: topK })
    let results = data || []

    if (error || results.length === 0) {
      // Fallback 1: phrase ILIKE
      const like = `%${query}%`
      const { data: byPhrase } = await sb
        .from('verses')
        .select('id, seq, text, chapter_id')
        .ilike('text', like)
        .limit(topK)
      let verses = byPhrase || []

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
            .select('id, seq, text, chapter_id')
            .or(orExpr)
            .limit(topK)
          verses = byWords || []
        }
      }
      // Enrich verses with chapter + book info for reference formatting
      if (verses.length) {
        const chapterIds = Array.from(new Set(verses.map(v => v.chapter_id)))
        const { data: chaptersInfo } = await sb
          .from('chapters')
          .select('id, seq, book_id')
          .in('id', chapterIds)
        const bookIds = Array.from(new Set((chaptersInfo || []).map((c: any) => c.book_id)))
        let booksInfo: any[] = []
        if (bookIds.length) {
          const { data: booksData } = await sb
            .from('books')
            .select('id, title')
            .in('id', bookIds)
          booksInfo = booksData || []
        }
        const chaptersMap = new Map((chaptersInfo || []).map((c: any) => [c.id, c]))
        const booksMap = new Map(booksInfo.map((b: any) => [b.id, b]))
        verses = verses.map(v => {
          const ch = chaptersMap.get(v.chapter_id)
          const bk = ch ? booksMap.get(ch.book_id) : null
          return {
            ...v,
            chapter_seq: ch?.seq,
            book_id: ch?.book_id,
            book_title: bk?.title
          }
        })
      }
      return NextResponse.json({ results: verses, mode })
    }


    if (bookId) results = results.filter((r: any) => r.book_id === bookId)
    results = results.filter((r: any) => (r.similarity ?? 0) >= minSimilarity)
    return NextResponse.json({ results, mode })
  }

  // Chapters mode
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
      const bookIds = (booksMatch || []).map((b: any) => b.id)
      if (bookIds.length) {
        const { data: chByBooks } = await sb
          .from('chapters')
          .select('id, seq, title, book_id')
          .in('book_id', bookIds)
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
  chaptersRes = chaptersRes.filter((r: any) => (r.similarity ?? 0) >= minSimilarity)
  return NextResponse.json({ results: chaptersRes, mode })
}
