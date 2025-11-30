import OpenAI from 'openai'

export const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

export const EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small'
export const CHAT_MODEL = process.env.OPENAI_CHAT_MODEL || 'gpt-4.1'

export async function embedText(input: string) {
  const res = await openai.embeddings.create({ model: EMBEDDING_MODEL, input })
  return res.data[0].embedding
}

export async function embedMany(inputs: string[]) {
  if (!inputs.length) return [] as number[][]
  const res = await openai.embeddings.create({ model: EMBEDDING_MODEL, input: inputs })
  return res.data.map(d => d.embedding)
}

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
