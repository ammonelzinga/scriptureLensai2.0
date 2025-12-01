// Edge Function: semantic & lexical scripture search via chunk embeddings
// Deploy: supabase functions deploy embedding --no-verify-jwt
// POST /functions/v1/embedding { query?: string, verseId?: string, topK?: number, mode?: 'semantic'|'lexical'|'hybrid' }
// Returns ranked verses using new embedding_chunks architecture.

// @ts-nocheck
import OpenAI from 'npm:openai'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY')
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
const EMBEDDING_MODEL = Deno.env.get('OPENAI_EMBEDDING_MODEL') || 'text-embedding-3-small'
const EMBEDDING_DIMENSIONS = Number(Deno.env.get('OPENAI_EMBEDDING_DIMENSIONS') || '512')

if (!OPENAI_API_KEY) console.error('OPENAI_API_KEY missing')
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) console.error('Supabase service role env vars missing')

const openai = new OpenAI({ apiKey: OPENAI_API_KEY })
const sb = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

async function embed(text: string): Promise<number[]> {
  const res = await openai.embeddings.create({ model: EMBEDDING_MODEL, input: text, dimensions: EMBEDDING_DIMENSIONS })
  return res.data[0].embedding
}

type SearchBody = {
  query?: string
  verseId?: string
  topK?: number
  mode?: 'semantic' | 'lexical' | 'hybrid'
  excludeSelf?: boolean
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

export const handler = async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405)
  let body: SearchBody
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400) }

  const { query, verseId, topK = 25, mode = 'semantic', excludeSelf = true } = body

  try {
    if (verseId && mode === 'semantic') {
      // Similar verses to given verse
      const { data, error } = await sb.rpc('semantic_search_by_verse', { verse_uuid: verseId, match_count: topK, exclude_self: excludeSelf })
      if (error) return json({ error: error.message }, 500)
      return json({ verses: data })
    }

    if (!query) return json({ error: 'query required for this mode' }, 400)

    if (mode === 'lexical') {
      const { data, error } = await sb.rpc('lexical_search_verses', { q: query, match_count: topK })
      if (error) return json({ error: error.message }, 500)
      return json({ verses: data })
    }

    // semantic or hybrid
    const queryEmbedding = await embed(query)
    const { data, error } = await sb.rpc('semantic_search_verses', {
      query_embedding: queryEmbedding,
      match_count: topK,
      include_lexical: mode === 'hybrid',
      lexical_text: mode === 'hybrid' ? query : null
    })
    if (error) return json({ error: error.message }, 500)
    return json({ verses: data })
  } catch (e) {
    return json({ error: (e as Error).message }, 500)
  }
}

if (import.meta.main) Deno.serve(handler)
