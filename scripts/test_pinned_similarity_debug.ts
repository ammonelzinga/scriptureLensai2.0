// Run with: node scripts/test_pinned_similarity_debug.ts
import fetch from 'node-fetch'

const BASE = process.env.BASE_URL || 'http://localhost:3000'
const PASSWORD = process.env.DEV_PASSWORD || 'searchponderpray'
const VERSE_ID = process.env.VERSE_ID || '44a1f647-8794-42cc-936a-bf49b9cbda17' // Matthew 17:20
const QUERY = process.env.QUERY || 'mustard seed faith'

function num(n: any, def = 0) {
  const v = typeof n === 'number' ? n : Number(n)
  return Number.isFinite(v) ? v : def
}

async function post(path: string, body: any) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  let json: any = {}
  try { json = await res.json() } catch {}
  return { status: res.status, json }
}
async function get(path: string) {
  const res = await fetch(`${BASE}${path}`)
  let json: any = {}
  try { json = await res.json() } catch {}
  return { status: res.status, json }
}

async function checkMissingEmbeddingsForVerse(verseId: string) {
  const resp = await get(`/api/dev/missing?password=${encodeURIComponent(PASSWORD)}`)
  if (resp.status !== 200) {
    return { ok: false, reason: `dev/missing unreachable: ${resp.status}` }
  }
  const tree = resp.json?.tree || []
  // Walk the tree to find the verse ID in any chapter children
  let foundMissing = false
  for (const trad of tree) {
    for (const source of trad.children || []) {
      for (const work of source.children || []) {
        for (const book of work.children || []) {
          for (const chapter of book.children || []) {
            for (const verse of (chapter.missingVerses || [])) {
              if (String(verse.id) === String(verseId)) { foundMissing = true; break }
            }
            if (foundMissing) break
          }
          if (foundMissing) break
        }
        if (foundMissing) break
      }
      if (foundMissing) break
    }
    if (foundMissing) break
  }
  return { ok: true, foundMissing }
}

async function run() {
  console.log(`BASE=${BASE}`)
  console.log(`VERSE_ID=${VERSE_ID}`)
  console.log(`QUERY=${QUERY}`)

  // Ask with hybrid true
  const askHybrid = await post('/api/ai/question', {
    question: QUERY,
    topK: 5,
    versePerChapter: 3,
    hybrid: true,
    verseId: VERSE_ID,
    debug: true,
  })
  console.log('ask(hybrid=true) status:', askHybrid.status)
  const resultsH = askHybrid.json?.results || []
  const firstH = resultsH[0]
  const pinnedH = firstH?.verses?.[0]
  const simH = num(pinnedH?.similarity, NaN)
  console.log('pinned similarity (hybrid=true):', simH)

  // Ask with hybrid false
  const askBase = await post('/api/ai/question', {
    question: QUERY,
    topK: 5,
    versePerChapter: 3,
    hybrid: false,
    verseId: VERSE_ID,
    debug: true,
  })
  console.log('ask(hybrid=false) status:', askBase.status)
  const resultsB = askBase.json?.results || []
  const firstB = resultsB[0]
  const pinnedB = firstB?.verses?.[0]
  const simB = num(pinnedB?.similarity, NaN)
  console.log('pinned similarity (hybrid=false):', simB)

  if (simH === 0 || simB === 0) {
    console.log('Similarity is zero — checking for missing embeddings...')
    const missing = await checkMissingEmbeddingsForVerse(VERSE_ID)
    if (!missing.ok) {
      console.log('Missing-check failed:', missing.reason)
    } else {
      console.log('Verse embedding missing?:', missing.foundMissing)
      if (missing.foundMissing) {
        console.log('Likely cause: verse has no embedding stored.')
      } else {
        console.log('Embedding exists; zero similarity may be due to vector issues or query vector.')
      }
    }
  }

  // Also surface response-level pinned similarity (server diag)
  console.log('API pinnedVerseSimilarity (hybrid=true):', num(askHybrid.json?.pinnedVerseSimilarity, NaN))
  console.log('API pinnedVerseSimilarity (hybrid=false):', num(askBase.json?.pinnedVerseSimilarity, NaN))
  console.log('Diagnostics (hybrid=true):', JSON.stringify(askHybrid.json?.diagnostics || {}, null, 2))
  console.log('Diagnostics (hybrid=false):', JSON.stringify(askBase.json?.diagnostics || {}, null, 2))

  console.log('Done.')
}

run().catch(err => { console.error(err); process.exit(1) })
