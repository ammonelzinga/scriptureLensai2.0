import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

const PASSWORD = 'searchponderpray'

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const password = url.searchParams.get('password') || ''
  if (password !== PASSWORD) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const q = url.searchParams.get('q') || ''
  const bookTitle = url.searchParams.get('book') || ''
  const chapterSeqStr = url.searchParams.get('chapterSeq') || ''
  const chapterSeq = chapterSeqStr ? parseInt(chapterSeqStr, 10) : undefined
  if (!q) return NextResponse.json({ error: 'Missing q' }, { status: 400 })
  const sb = supabaseAdmin()
  // Fetch verses matching substring (case-insensitive)
  const { data: versesRaw, error } = await sb
    .from('verses')
    .select('id, seq, text, chapter_id')
    .ilike('text', `%${q}%`)
  if (error) return NextResponse.json({ error: 'Query error', detail: error.message }, { status: 500 })
  // Fetch chapters and books for mapping
  const { data: allChapters, error: chErr } = await sb.from('chapters').select('id, seq, book_id')
  if (chErr) return NextResponse.json({ error: 'Chapters query error', detail: chErr.message }, { status: 500 })
  const { data: allBooks, error: bErr } = await sb.from('books').select('id, title')
  if (bErr) return NextResponse.json({ error: 'Books query error', detail: bErr.message }, { status: 500 })
  const chapterMap = new Map((allChapters||[]).map(c => [c.id, c]))
  const bookMap = new Map((allBooks||[]).map(b => [b.id, b]))
  const filtered = (versesRaw||[]).map(v => {
    const ch = chapterMap.get(v.chapter_id)
    const bk = ch ? bookMap.get(ch.book_id) : null
    return { id: v.id, seq: v.seq, text: v.text, chapter_id: v.chapter_id, chapter_seq: ch?.seq, book_title: bk?.title }
  }).filter(v => (!bookTitle || v.book_title === bookTitle) && (chapterSeq === undefined || v.chapter_seq === chapterSeq))
  return NextResponse.json({ q, count: filtered.length, verses: filtered.slice(0, 200) })
}
