import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { embedText } from '@/lib/openai'

/*
POST /api/search/combined
Body: {
  verseId?: string; // use existing verse embedding
  text?: string;    // raw text to embed if verseId not provided
  chapterCount?: number; // default 5
  verseCount?: number;   // default 10
}

Returns unified similarity results (chapters + verses) based on single query embedding.
*/

export async function POST(req: NextRequest) {
  const { verseId, text, chapterCount = 5, verseCount = 10 } = await req.json()
  if (!verseId && !text) {
    return NextResponse.json({ error: 'Provide verseId or text' }, { status: 400 })
  }
  const sb = supabaseAdmin()
  let embedding: number[] | null = null

  if (verseId) {
    const { data: verse, error } = await sb.from('verses').select('id, embedding, text').eq('id', verseId).single()
    if (error || !verse) return NextResponse.json({ error: 'Verse not found' }, { status: 404 })
    if (!verse.embedding) return NextResponse.json({ error: 'Verse embedding missing' }, { status: 400 })
    embedding = verse.embedding
  } else if (text) {
    embedding = await embedText(text)
  }
  if (!embedding) return NextResponse.json({ error: 'Failed to obtain embedding' }, { status: 500 })

  // Call combined RPC match_chapter_and_verses
  // Supabase JS does not support vector param directly in RPC body; we pass as object.
  const { data, error: rpcError } = await sb.rpc('match_chapter_and_verses', {
    query_embedding: embedding,
    chapter_count: chapterCount,
    verse_count: verseCount,
  })
  if (rpcError) return NextResponse.json({ error: rpcError.message }, { status: 500 })

  // Group chapters and verses for convenience
  const chapters: any[] = []
  const verses: any[] = []
  for (const row of data || []) {
    if (row.entity_type === 'chapter') chapters.push(row)
    else verses.push(row)
  }

  return NextResponse.json({ chapters, verses })
}
