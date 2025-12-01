import OpenAI from 'openai'

// Central OpenAI client
export const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

// Models & dimensions (new architecture: 512-dim chunk embeddings)
export const EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small'
export const EMBEDDING_DIMENSIONS = Number(process.env.OPENAI_EMBEDDING_DIMENSIONS || 512)
export const CHAT_MODEL = process.env.OPENAI_CHAT_MODEL || 'gpt-4.1'

/** Embed single text (512 dims enforced). */
export async function embedText(input: string) {
  const res = await openai.embeddings.create({ model: EMBEDDING_MODEL, input, dimensions: EMBEDDING_DIMENSIONS })
  return res.data[0].embedding
}

/** Embed multiple texts; returns vectors in same order. */
export async function embedMany(inputs: string[]) {
  if (!inputs.length) return [] as number[][]
  const res = await openai.embeddings.create({ model: EMBEDDING_MODEL, input: inputs, dimensions: EMBEDDING_DIMENSIONS })
  return res.data.map(d => d.embedding)
}

/** Generic small summarization/chat utility. */
export async function chatSummary(system: string, user: string) {
  const res = await openai.chat.completions.create({
    model: CHAT_MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.2,
  })
  return res.choices[0]?.message?.content ?? ''
}

/** Chunking prompt constant (exported for reuse in ingestion pipeline). */
export const CHUNKING_PROMPT = `You are an expert in structuring Biblical text into coherent semantic units for embedding.
Rules:
1. Each chunk groups consecutive verses forming a single cohesive thought, narrative beat, or logical unit.
2. Minimum 3 verses, maximum 10 verses per chunk.
3. NEVER cross book boundaries.
4. Preserve original verse ordering.
5. Do not merge verses that clearly start a new paragraph/thought.
6. Prefer natural paragraph boundaries when available.
7. Return JSON ONLY with no commentary.
8. If a chapter ends with <3 remaining verses, merge them with the previous chunk (still <=10 total).
9. Avoid extremely long chunks—split if > ~450 characters.

Input format you receive:
{
  "book": "Book Name",
  "chapter": <number>,
  "verses": [ {"verse": <number>, "text": "..."}, ... ]
}

Output JSON schema:
{
  "chunks": [
    {
      "chapter_numbers": [<chapterNumber(s)>],            // parallel to verse_numbers
      "verse_numbers": [<verseNumbers>],                  // ordered
      "combined_text": "Concatenated verse texts with single space separation",
      "verses": [ {"chapter": <num>, "verse": <num>} ] // explicit mapping for traceability
    }
  ]
}
DO NOT include embeddings. Do not add prose outside JSON.`
