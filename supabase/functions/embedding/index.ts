// Supabase Edge Function: Batch embeddings for verses/chapters
// @ts-nocheck  -- Deno-specific module imports (npm:openai) not resolved by Next.js type checker
// Deploy with: supabase functions deploy embedding --no-verify-jwt
// Invoke example: POST /functions/v1/embedding { verses: [{id,text}], chapters:[{id,text}] }

// deno-lint-ignore no-explicit-any
type VerseInput = { id: string; text: string }
// deno-lint-ignore no-explicit-any
type ChapterInput = { id: string; text: string }

import OpenAI from "npm:openai"

const EMBEDDING_MODEL = Deno.env.get('OPENAI_EMBEDDING_MODEL') || 'text-embedding-3-small'
const openai = new OpenAI({ apiKey: Deno.env.get('OPENAI_API_KEY') })

async function embedMany(inputs: string[]) {
  if (!inputs.length) return [] as number[][]
  const res = await openai.embeddings.create({ model: EMBEDDING_MODEL, input: inputs })
  return res.data.map(d => d.embedding)
}

export const handler = async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })
  try {
    const body = await req.json() as { verses?: VerseInput[]; chapters?: ChapterInput[] }
    const verseEmbeddings = await embedMany((body.verses||[]).map(v=>v.text))
    const chapterEmbeddings = await embedMany((body.chapters||[]).map(c=>c.text))
    return new Response(JSON.stringify({ verses: verseEmbeddings, chapters: chapterEmbeddings }), { headers: { 'Content-Type': 'application/json' } })
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }
}

// For local testing
if (import.meta.main) {
  Deno.serve(handler)
}
