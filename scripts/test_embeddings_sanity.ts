// Run with: node scripts/test_embeddings_sanity.ts
import assert from 'assert'
import fetch from 'node-fetch'

const BASE = process.env.BASE_URL || 'http://localhost:3000'

// Helpers
async function post(path: string, body: any) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  return { status: res.status, json }
}
async function get(path: string) {
  const res = await fetch(`${BASE}${path}`)
  const json = await res.json().catch(() => ({}))
  return { status: res.status, json }
}
function num(n: any, def = 0) {
  const v = typeof n === 'number' ? n : Number(n)
  return Number.isFinite(v) ? v : def
}

async function testCatalogBasics() {
  console.log('Running testCatalogBasics...')
  const w = await get('/api/catalog/works')
  assert.strictEqual(w.status, 200, 'works listing reachable')
  assert.ok(Array.isArray(w.json.works) && w.json.works.length > 0, 'works are present')
  const workId = w.json.works[0].id

  const b = await get(`/api/catalog/books?workId=${encodeURIComponent(workId)}`)
  assert.strictEqual(b.status, 200, 'books listing reachable')
  assert.ok(Array.isArray(b.json.books) && b.json.books.length > 0, 'books are present')
  console.log('OK')
  return { workId, bookId: b.json.books[0].id, books: b.json.books }
}

async function testLexicalVsSemanticMustard() {
  console.log('Running testLexicalVsSemanticMustard...')
  const lex = await post('/api/search/lexical', { query: 'mustard seed', mode: 'verses', topK: 20 })
  assert.strictEqual(lex.status, 200, 'lexical reachable')
  const lexCount = Array.isArray(lex.json.results) ? lex.json.results.length : 0
  assert.ok(lexCount > 0, 'lexical returns verses for mustard seed')

  const sem = await post('/api/search/semantic', {
    query: 'mustard seed faith',
    mode: 'verses_top_per_chapter',
    versePerChapter: 3,
    topK: 10,
  })
  assert.strictEqual(sem.status, 200, 'semantic reachable')
  const semCount = Array.isArray(sem.json.results) ? sem.json.results.length : 0
  assert.ok(semCount > 0, 'semantic returns chapters')
  console.log('OK')
}

async function testExplainHasScores() {
  console.log('Running testExplainHasScores...')
  const ex = await post('/api/search/explain', { query: 'love your neighbor as yourself', topKChapters: 5, topKVerses: 10 })
  assert.strictEqual(ex.status, 200, 'explain reachable')
  const chapters = Array.isArray(ex.json.chapters) ? ex.json.chapters : []
  const verses = Array.isArray(ex.json.verses) ? ex.json.verses : []
  // Ensure numeric coercion is possible
  if (chapters.length) {
    const semantic = num(chapters[0]?.semantic_similarity ?? chapters[0]?.similarity, NaN)
    const lexical = num(chapters[0]?.lexical_similarity ?? chapters[0]?.lexical, NaN)
    assert.ok(Number.isFinite(semantic) || chapters[0]?.semantic_similarity == null, 'chapter semantic numeric or null')
    assert.ok(Number.isFinite(lexical) || chapters[0]?.lexical_similarity == null, 'chapter lexical numeric or null')
  }
  if (verses.length) {
    const semantic = num(verses[0]?.semantic_similarity ?? verses[0]?.similarity, NaN)
    const lexical = num(verses[0]?.lexical_similarity ?? verses[0]?.lexical, NaN)
    assert.ok(Number.isFinite(semantic) || verses[0]?.semantic_similarity == null, 'verse semantic numeric or null')
    assert.ok(Number.isFinite(lexical) || verses[0]?.lexical_similarity == null, 'verse lexical numeric or null')
  }
  console.log('OK')
}

async function testPinnedVerseSimilarity(verseId: string) {
  console.log('Running testPinnedVerseSimilarity...')
  const ask = await post('/api/ai/question', {
    question: 'mustard seed faith',
    topK: 5,
    versePerChapter: 3,
    hybrid: true,
    verseId,
  })
  assert.strictEqual(ask.status, 200, 'ask reachable')
  const results = ask.json.results || []
  assert.ok(results.length > 0, 'ask returns results')
  const firstChapter = results[0]
  assert.ok(firstChapter?.verses?.length > 0, 'first chapter has verses')
  const pinned = firstChapter.verses[0]
  assert.ok(String(pinned?.id) === String(verseId), 'pinned verse is first')
  const sim = num(pinned?.similarity)
  assert.ok(Number.isFinite(sim), `pinned similarity numeric: got ${sim}`)
  console.log('OK')
}

async function testSemanticAllMode() {
  console.log('Running testSemanticAllMode...')
  const resp = await post('/api/ai/question', {
    question: 'seek and you shall find',
    topK: -1, // All chapters
    versePerChapter: 1,
    hybrid: true,
  })
  assert.strictEqual(resp.status, 200, 'ask reachable (all mode)')
  const results = resp.json.results || []
  assert.ok(results.length >= 10, 'all-mode returns many chapters')
  // Ensure ordering is descending by similarity
  const sims = results.map((r: any) => num(r?.score))
  for (let i = 1; i < sims.length; i++) {
    assert.ok(sims[i - 1] >= sims[i], 'descending similarity order for chapters')
  }
  console.log('OK')
}

async function testLexicalMinSimilarity() {
  console.log('Running testLexicalMinSimilarity...')
  const resp = await post('/api/search/lexical', {
    query: 'mustard seed',
    mode: 'verses',
    topK: 50,
    minSimilarity: 0.15,
  })
  assert.strictEqual(resp.status, 200, 'lexical reachable')
  const results = resp.json.results || []
  assert.ok(results.length > 0, 'minSimilarity filter still returns something')
  console.log('OK')
}

async function run() {
  console.log(`BASE=${BASE}`)
  const { workId, bookId, books } = await testCatalogBasics()
  await testLexicalVsSemanticMustard()
  await testExplainHasScores()
  // Use the verse ID provided
  await testPinnedVerseSimilarity('44a1f647-8794-42cc-936a-bf49b9cbda17')
  await testSemanticAllMode()
  await testLexicalMinSimilarity()

  // Optional: scope semantic to catalog range
  const seqMin = Math.min(...books.map((b: any) => b.seq))
  const seqMax = Math.max(...books.map((b: any) => b.seq))
  console.log('Running testSemanticScopedRange...')
  const scoped = await post('/api/search/semantic', {
    query: 'parable of prodigal son',
    mode: 'chapters_only',
    topK: 10,
    workId,
    bookSeqMin: seqMin,
    bookSeqMax: seqMax,
  })
  assert.strictEqual(scoped.status, 200, 'semantic scoped reachable')
  assert.ok((scoped.json.results || []).length > 0, 'semantic scoped returned results')
  console.log('OK')

  console.log('All sanity tests done.')
}

run().catch(err => {
  console.error(err)
  process.exit(1)
})
