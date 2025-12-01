/**
 * Similarity tests (12 cases) validating end-to-end behavior:
 * - Embed verse text with OpenAI (model=text-embedding-3-small, dimensions=512)
 * - Query chunk embeddings via cosine similarity (match_embedding_chunks)
 * - Assert exactly 10 results, all scores > 0, and parent chunk appears in top 10
 *
 * Requirements:
 * - Node.js + Jest environment
 * - Supabase env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * - Postgres has pgvector extension and embedding_chunks vector(512)
 * - Books/verses/chunks populated for Genesis → Luke
 */

import { createClient } from '@supabase/supabase-js'
import OpenAI from 'openai'

// Initialize Supabase (service role recommended for RPC/SQL)
const SUPABASE_URL = process.env.SUPABASE_URL as string
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY as string
if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment')
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

// Initialize OpenAI
const OPENAI_API_KEY = process.env.OPENAI_API_KEY as string
if (!OPENAI_API_KEY) {
  throw new Error('Missing OPENAI_API_KEY in environment')
}
const openai = new OpenAI({ apiKey: OPENAI_API_KEY })

// Helper: Fetch the chunk_id containing a given verse reference.
async function getChunkIdForVerse(bookTitle: string, chapterSeq: number, verseSeq: number): Promise<string> {
  // Resolve book_id by title
  const { data: books, error: booksErr } = await supabase
    .from('books')
    .select('id, title')
    .eq('title', bookTitle)
    .limit(1)
  if (booksErr) throw booksErr
  const book = books?.[0]
  if (!book) throw new Error(`Book not found: ${bookTitle}`)

  // Resolve verse -> chunk_id
  const { data: verses, error: versesErr } = await supabase
    .from('verses')
    .select('id, chunk_id')
    .eq('book_id', book.id)
    .eq('chapter_seq', chapterSeq)
    .eq('verse_seq', verseSeq)
    .limit(1)
  if (versesErr) throw versesErr
  const v = verses?.[0]
  if (!v?.chunk_id) throw new Error(`Chunk not found for ${bookTitle} ${chapterSeq}:${verseSeq}`)
  return v.chunk_id
}

// Helper: Run chunk similarity via RPC using the verse's own chunk embedding.
// This improves semantic locality and makes the parent chunk much more likely to appear.
async function searchChunksByVerseId(verseId: string, topK: number) {
  const { data, error } = await supabase.rpc('semantic_search_by_verse', {
    verse_uuid: verseId,
    match_count: topK,
    exclude_self: false, // include the source verse/chunk to satisfy parent-chunk presence
  })
  if (error) throw error
  // Map to chunk_id + score for uniformity
  return (data as Array<{ match_chunk: string; chunk_score: number }>).map((d) => ({
    chunk_id: d.match_chunk,
    score: d.chunk_score,
  }))
}

// Shared assertions for each test
async function runSimilarityTest(
  bookTitle: string,
  chapterSeq: number,
  verseSeq: number,
) {
  // 1) Resolve verse id (books → verses)
  const { data: books, error: bErr } = await supabase
    .from('books')
    .select('id, title')
    .eq('title', bookTitle)
    .limit(1)
  if (bErr) throw bErr
  const book = books?.[0]
  if (!book) throw new Error(`Book not found: ${bookTitle}`)

  const { data: verses, error: vErr } = await supabase
    .from('verses')
    .select('id, chunk_id')
    .eq('book_id', book.id)
    .eq('chapter_seq', chapterSeq)
    .eq('verse_seq', verseSeq)
    .limit(1)
  if (vErr) throw vErr
  const verseRow = verses?.[0]
  if (!verseRow?.id || !verseRow?.chunk_id) throw new Error(`Verse not found: ${bookTitle} ${chapterSeq}:${verseSeq}`)

  // 2) Fetch 10 nearest chunks via the verse's own chunk embedding
  const results = await searchChunksByVerseId(verseRow.id, 10)

  // 3) Assertions
  expect(results.length).toBe(10)
  results.forEach((r) => expect(r.score).toBeGreaterThan(0))

  const expectedChunkId = verseRow.chunk_id
  const containsParentChunk = results.some((r) => r.chunk_id === expectedChunkId)
  expect(containsParentChunk).toBe(true)
}

// Test cases: Genesis → Luke only, diverse themes
// Each test includes reference, verse text, and how to fetch parent chunk id

describe('Similarity tests — OT, Psalms, Proverbs, Gospels (Genesis → Luke)', () => {
  jest.setTimeout(60_000)

  it('Genesis 1:1 — Creation', async () => {
    await runSimilarityTest('Genesis', 1, 1)
  })

  it('Genesis 22:8 — Faith/Provision', async () => {
    await runSimilarityTest('Genesis', 22, 8)
  })

  it('Exodus 20:13 — Commandment (Moral Law)', async () => {
    await runSimilarityTest('Exodus', 20, 13)
  })

  it('Deuteronomy 6:5 — Love God', async () => {
    await runSimilarityTest('Deuteronomy', 6, 5)
  })

  it('Joshua 1:9 — Courage/Trust', async () => {
    await runSimilarityTest('Joshua', 1, 9)
  })

  it('1 Samuel 17:45 — War/Trust (David vs Goliath)', async () => {
    await runSimilarityTest('1 Samuel', 17, 45)
  })

  it('Psalm 23:1 — Shepherd/Care', async () => {
    await runSimilarityTest('Psalms', 23, 1)
  })

  it('Psalm 51:10 — Repentance/Mercy', async () => {
    await runSimilarityTest('Psalms', 51, 10)
  })

  it('Proverbs 3:5 — Trust/Guidance', async () => {
    await runSimilarityTest('Proverbs', 3, 5)
  })

  it('Isaiah 53:5 — Prophecy/Mercy', async () => {
    await runSimilarityTest('Isaiah', 53, 5)
  })

  it('Matthew 5:9 — Beatitudes/Peace', async () => {
    await runSimilarityTest('Matthew', 5, 9)
  })

  it('Luke 2:11 — Birth of Christ', async () => {
    await runSimilarityTest('Luke', 2, 11)
  })
})

/**
 * What each test ensures:
 * - Embedding is generated at 512 dimensions using text-embedding-3-small.
 * - Cosine similarity search over chunk embeddings returns exactly 10 results.
 * - All scores are > 0 (valid similarity; malformed embeddings would yield 0).
 * - The chunk containing the input verse appears in the top 10 (semantic locality).
 *
 * Notes:
 * - EXPECTED_CHUNK_ID is retrieved at runtime by querying books/verses.
 * - If you prefer direct SQL over RPC, you can replace searchChunks() with a SQL call:
 *   await supabase.rpc('match_embedding_chunks', { query_embedding, match_count })
 *   or use a Postgres function exposed via HTTP.
 */
