import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const traditionId = url.searchParams.get('traditionId')
  const sb = supabaseAdmin()
  let q = sb.from('sources').select('id, name, tradition_id').order('name')
  if (traditionId) q = q.eq('tradition_id', traditionId)
  const { data, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ sources: data || [] })
}
