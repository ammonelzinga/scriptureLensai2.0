import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { parsePlainTextToChaptersAndVerses } from '@/lib/parseText'

type JsonVerse = { number: number; text: string }
type JsonChapter = { number: number; verses: JsonVerse[] }
type JsonBook = { title: string; chapters: JsonChapter[] }

type Body = {
  tradition: string
  source: string
  work: string
  bookTitle?: string | null
  text?: string
  book?: JsonBook
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as Body
  const password = process.env.UPLOAD_PASSWORD || 'searchponderpray'
  const provided = req.headers.get('x-upload-password') || ''
  if (provided !== password) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const isJsonUpload = !!body.book && !body.text
  if (!body?.tradition || !body?.source || !body?.work || (!isJsonUpload && !body?.text)) {
    return NextResponse.json({ error: 'Missing fields' }, { status: 400 })
  }

  const sb = supabaseAdmin()
  // Robust fetch-or-insert helpers (avoid null .data from upsert)
  async function ensureTradition(name: string) {
    const { data, error } = await sb.from('traditions').select('*').eq('name', name).single()
    if (data) return data
    if (error && error.code && error.code !== 'PGRST116') {
      throw new Error(`Tradition select failed: ${error.message}`)
    }
    const { data: inserted, error: insErr } = await sb.from('traditions').insert({ name }).select('*').single()
    if (insErr || !inserted) throw new Error(`Tradition insert failed: ${insErr?.message}`)
    return inserted
  }
  async function ensureSource(tradition_id: string, name: string) {
    const { data, error } = await sb.from('sources').select('*').eq('tradition_id', tradition_id).eq('name', name).single()
    if (data) return data
    if (error && error.code && error.code !== 'PGRST116') {
      throw new Error(`Source select failed: ${error.message}`)
    }
    const { data: inserted, error: insErr } = await sb.from('sources').insert({ tradition_id, name }).select('*').single()
    if (insErr || !inserted) throw new Error(`Source insert failed: ${insErr?.message}`)
    return inserted
  }
  async function ensureWork(source_id: string, name: string) {
    const { data, error } = await sb.from('works').select('*').eq('source_id', source_id).eq('name', name).single()
    if (data) return data
    if (error && error.code && error.code !== 'PGRST116') {
      throw new Error(`Work select failed: ${error.message}`)
    }
    const { data: inserted, error: insErr } = await sb.from('works').insert({ source_id, name }).select('*').single()
    if (insErr || !inserted) throw new Error(`Work insert failed: ${insErr?.message}`)
    return inserted
  }

  let t, s, w
  try {
    t = await ensureTradition(body.tradition)
    s = await ensureSource(t.id, body.source)
    w = await ensureWork(s.id, body.work)
  } catch (e: any) {
    return NextResponse.json({ error: e.message || 'Hierarchy creation failed' }, { status: 500 })
  }

  // Handle JSON book upload path OR plain text
  interface PendingChapter { chapterId: string; verseIds: string[]; verseTexts: string[] }
  const pending: PendingChapter[] = []
  let processedChaptersCount = 0

  if (isJsonUpload && body.book) {
    // Determine next book sequence
    const { data: existingBooks } = await sb.from('books').select('id').eq('work_id', w.id)
    const nextSeq = (existingBooks?.length || 0) + 1
    const { data: insertedBook, error: bookErr } = await sb
      .from('books')
      .insert({ work_id: w.id, seq: nextSeq, title: body.book.title })
      .select('*')
      .single()
    if (bookErr) return NextResponse.json({ error: bookErr.message }, { status: 500 })
    const bookId = insertedBook.id
    for (const ch of body.book.chapters) {
      const { data: chapterRow, error: chErr } = await sb
        .from('chapters')
        .insert({ work_id: w.id, book_id: bookId, seq: ch.number, title: `Chapter ${ch.number}` })
        .select('*')
        .single()
      if (chErr) return NextResponse.json({ error: chErr.message }, { status: 500 })
      const verseRows = ch.verses.map(v => ({ chapter_id: chapterRow.id, seq: v.number, text: v.text }))
      const { data: insertedVerses, error: vErr } = await sb.from('verses').insert(verseRows).select('id, text')
      if (vErr) return NextResponse.json({ error: vErr.message }, { status: 500 })
      pending.push({ chapterId: chapterRow.id, verseIds: insertedVerses.map(v=>v.id), verseTexts: insertedVerses.map(v=>v.text) })
      processedChaptersCount++
    }
  } else {
    let bookId: string | null = null
    if (body.bookTitle && body.bookTitle.trim().length) {
      const { data: b } = await sb
        .from('books')
        .insert({ work_id: w.id, seq: 1, title: body.bookTitle.trim() })
        .select('*')
        .single()
      bookId = b.id
    }
    const chapters = parsePlainTextToChaptersAndVerses(body.text!)
    for (const ch of chapters) {
      const { data: chapterRow, error: chErr } = await sb
        .from('chapters')
        .insert({ work_id: w.id, book_id: bookId, seq: ch.seq, title: ch.title })
        .select('*')
        .single()
      if (chErr) return NextResponse.json({ error: chErr.message }, { status: 500 })
      const verseRows = ch.verses.map((text, i) => ({ chapter_id: chapterRow.id, seq: i + 1, text }))
      const { data: insertedVerses, error: vErr } = await sb.from('verses').insert(verseRows).select('id, text')
      if (vErr) return NextResponse.json({ error: vErr.message }, { status: 500 })
      pending.push({ chapterId: chapterRow.id, verseIds: insertedVerses.map(v=>v.id), verseTexts: insertedVerses.map(v=>v.text) })
      processedChaptersCount++
    }
  }

  // Call edge function for each chapter to batch embeddings (verses + chapter aggregate)
  const functionUrl = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/embedding`
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
  for (const ch of pending) {
    const chapterAggregate = ch.verseTexts.join(' ')
    const res = await fetch(functionUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${serviceKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ verses: ch.verseTexts.map((text,i)=>({id: ch.verseIds[i], text})), chapters: [{ id: ch.chapterId, text: chapterAggregate }] })
    })
    if (!res.ok) {
      const err = await res.text()
      return NextResponse.json({ error: `Embedding function failed: ${err}` }, { status: 500 })
    }
    const json = await res.json() as { verses: number[][]; chapters: number[][] }
    // Update verses embeddings
    for (let i=0;i<ch.verseIds.length;i++) {
      await sb.from('verses').update({ embedding: json.verses[i] as any }).eq('id', ch.verseIds[i])
    }
    // Update chapter embedding
    await sb.from('chapters').update({ embedding: json.chapters[0] as any }).eq('id', ch.chapterId)
  }

  return NextResponse.json({ ok: true, workId: w.id, chapters: pending.length, json: isJsonUpload })
}
