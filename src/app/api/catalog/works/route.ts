import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export async function GET() {
  const sb = supabaseAdmin()
  const { data, error } = await sb.from('works').select('id, name, abbrev')
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ works: data || [] })
}
