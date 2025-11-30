import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { embedText } from '@/lib/openai'

const PASSWORD = 'searchponderpray'

type Body = {
  password?: string
  verseId?: string
  chapterId?: string
  workId?: string
  force?: boolean
}

export async function POST(req: NextRequest) {
  const body: Body = await req.json().catch(()=>({}))
  if (body.password !== PASSWORD) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const { verseId, chapterId, workId, force = false } = body
  const sb = supabaseAdmin()

  const touched = { verses: 0, chapters: 0 }

  // Helper: embed and store chapter
  async function processChapter(chId: string) {
    const { data: ch } = await sb.from('chapters').select('id,book_id,seq,title,embedding').eq('id', chId).maybeSingle()
    if (!ch) return
    // Build chapter text from verses
    const { data: verses } = await sb.from('verses').select('id,seq,text,embedding').eq('chapter_id', chId).order('seq')
    if (force || !ch.embedding) {
      const chapterText = (verses || []).map(v => v.text).join(' ')
      const chEmbedding = await embedText(chapterText)
      await sb.from('chapters').update({ embedding: chEmbedding }).eq('id', chId)
      touched.chapters++
    }
    // Also embed any verses missing
    for (const v of verses || []) {
      if (force || !v.embedding) {
        const vEmb = await embedText(v.text)
        await sb.from('verses').update({ embedding: vEmb }).eq('id', v.id)
        touched.verses++
      }
    }
  }

  // Single verse
  if (verseId) {
    const { data: verse } = await sb.from('verses').select('id,text,embedding').eq('id', verseId).maybeSingle()
    if (verse && (force || !verse.embedding)) {
      const vEmb = await embedText(verse.text)
      await sb.from('verses').update({ embedding: vEmb }).eq('id', verse.id)
      touched.verses++
    }
  }

  // Single chapter
  if (chapterId) {
    const { data: ch } = await sb.from('chapters').select('id,embedding').eq('id', chapterId).maybeSingle()
    if (ch) {
      if (force || !ch.embedding) {
        await processChapter(chapterId)
      } else {
        // Still embed any missing verses inside existing chapter
        const { data: verses } = await sb.from('verses').select('id,text,embedding').eq('chapter_id', chapterId)
        for (const v of verses || []) {
          if (!v.embedding) {
            const vEmb = await embedText(v.text)
            await sb.from('verses').update({ embedding: vEmb }).eq('id', v.id)
            touched.verses++
          }
        }
      }
    }
  }

  // Whole work (missing only)
  if (workId) {
    // chapters missing
    const { data: chMissing } = await sb
      .from('chapters')
      .select('id')
      .eq('work_id', workId)
    const allChapters = await sb.from('chapters').select('id,embedding').eq('work_id', workId)
    for (const c of allChapters.data || []) {
      if (force || !c.embedding) {
        await processChapter(c.id)
      } else {
        const { data: verses } = await sb.from('verses').select('id,text,embedding').eq('chapter_id', c.id)
        for (const v of verses || []) {
          if (!v.embedding) {
            const vEmb = await embedText(v.text)
            await sb.from('verses').update({ embedding: vEmb }).eq('id', v.id)
            touched.verses++
          }
        }
      }
    }
  }

  return NextResponse.json({ ok: true, processed: touched })
}
