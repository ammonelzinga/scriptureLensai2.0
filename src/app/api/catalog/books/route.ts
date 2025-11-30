import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const workId = url.searchParams.get('workId')
  const sb = supabaseAdmin()
  let q = sb.from('books').select('id, title, seq, work_id').order('seq', { ascending: true })
  if (workId) q = q.eq('work_id', workId)
  const { data, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ books: data || [] })
}
