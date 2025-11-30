import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

const PASSWORD = 'searchponderpray'

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const password = url.searchParams.get('password') || ''
  if (password !== PASSWORD) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const type = url.searchParams.get('type') || '' // 'verse' | 'chapter'
  const id = url.searchParams.get('id') || ''
  if (!type || !id) {
    return NextResponse.json({ error: 'Missing type or id' }, { status: 400 })
  }
  const sb = supabaseAdmin()
  try {
    if (type === 'verse') {
      const { data } = await sb
        .from('verses')
        .select('id, chapter_id, seq, text, embedding')
        .eq('id', id)
        .maybeSingle()
      if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })
      const stats = vecStats(data.embedding)
      return NextResponse.json({ type, id: data.id, chapter_id: data.chapter_id, seq: data.seq, stats })
    }
    if (type === 'chapter') {
      const { data } = await sb
        .from('chapters')
        .select('id, book_id, seq, title, embedding')
        .eq('id', id)
        .maybeSingle()
      if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })
      const stats = vecStats(data.embedding)
      return NextResponse.json({ type, id: data.id, book_id: data.book_id, seq: data.seq, title: data.title, stats })
    }
    return NextResponse.json({ error: 'Invalid type' }, { status: 400 })
  } catch (err: any) {
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

function vecStats(vec: any): { length: number, norm: number, min: number, max: number, zeroCount: number } | null {
  if (!Array.isArray(vec)) {
    // Try parsing if stored as JSON string
    if (typeof vec === 'string') {
      try {
        const parsed = JSON.parse(vec)
        if (Array.isArray(parsed)) vec = parsed
        else return null
      } catch { return null }
    } else {
      return null
    }
  }
  const n = vec.length
  let normSq = 0
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  let zeroCount = 0
  for (let i=0;i<n;i++) {
    const v = Number(vec[i])
    if (!Number.isFinite(v)) continue
    if (v === 0) zeroCount++
    if (v < min) min = v
    if (v > max) max = v
    normSq += v*v
  }
  return { length: n, norm: Math.sqrt(normSq), min, max, zeroCount }
}
