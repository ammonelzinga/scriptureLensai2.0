import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

const PASSWORD = 'searchponderpray'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const password = searchParams.get('password')
  if (password !== PASSWORD) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const sb = supabaseAdmin()

  // Fetch all works, books
  const { data: works } = await sb.from('works').select('id,name,abbrev')
  const { data: books } = await sb.from('books').select('id,title,work_id,seq')

  // Missing chapters (embedding is null)
  const { data: missingChapters } = await sb
    .from('chapters')
    .select('id,book_id,seq,title')
    .is('embedding', null)

  // Missing verses (embedding is null)
  const { data: missingVerses } = await sb
    .from('verses')
    .select('id,chapter_id,seq,text')
    .is('embedding', null)

  const chaptersByBook = new Map<string, any[]>()
  for (const ch of missingChapters || []) {
    const arr = chaptersByBook.get(ch.book_id) || []
    arr.push(ch)
    chaptersByBook.set(ch.book_id, arr)
  }

  const versesByChapter = new Map<string, any[]>()
  for (const v of missingVerses || []) {
    const arr = versesByChapter.get(v.chapter_id) || []
    arr.push(v)
    versesByChapter.set(v.chapter_id, arr)
  }

  const booksByWork = new Map<string, any[]>()
  for (const b of books || []) {
    const arr = booksByWork.get(b.work_id) || []
    arr.push(b)
    booksByWork.set(b.work_id, arr)
  }

  const responseWorks = (works || []).map(w => {
    const wBooks = (booksByWork.get(w.id) || []).sort((a,b)=>a.seq - b.seq)
    const booksOut = wBooks.map(b => {
      const chMissing = (chaptersByBook.get(b.id) || []).sort((a,b)=>a.seq - b.seq)
      const chOut = chMissing.map(ch => ({
        id: ch.id,
        seq: ch.seq,
        title: ch.title,
        missingVerses: (versesByChapter.get(ch.id) || []).sort((a,b)=>a.seq - b.seq)
      }))
      const missingChapterCount = chOut.length
      const missingVerseCount = chOut.reduce((acc, c) => acc + c.missingVerses.length, 0)
      return {
        id: b.id,
        title: b.title,
        seq: b.seq,
        missingChapterCount,
        missingVerseCount,
        chapters: chOut
      }
    })
    const totalMissingChapters = booksOut.reduce((acc, b) => acc + b.missingChapterCount, 0)
    const totalMissingVerses = booksOut.reduce((acc, b) => acc + b.missingVerseCount, 0)
    return {
      id: w.id,
      name: w.name,
      abbrev: w.abbrev,
      missingChapterCount: totalMissingChapters,
      missingVerseCount: totalMissingVerses,
      books: booksOut
    }
  }).sort((a,b)=> (a.abbrev || a.name).localeCompare(b.abbrev || b.name))

  return NextResponse.json({ works: responseWorks })
}
