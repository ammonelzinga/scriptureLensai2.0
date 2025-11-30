// Run with: node scripts/check_embedding_stats.ts
import fetch from 'node-fetch'

const BASE = process.env.BASE_URL || 'http://localhost:3000'
const PASSWORD = process.env.DEV_PASSWORD || 'searchponderpray'
const VERSE_ID = process.env.VERSE_ID || '44a1f647-8794-42cc-936a-bf49b9cbda17'
const CHAPTER_ID = process.env.CHAPTER_ID || 'a0c63e38-e557-4a33-bfd0-abab348bec96'

async function get(path: string) {
  const res = await fetch(`${BASE}${path}`)
  let json: any = {}
  try { json = await res.json() } catch {}
  return { status: res.status, json }
}

async function run() {
  console.log(`BASE=${BASE}`)
  console.log('Checking verse stats...')
  const v = await get(`/api/dev/diag?password=${encodeURIComponent(PASSWORD)}&type=verse&id=${encodeURIComponent(VERSE_ID)}`)
  console.log('verse status:', v.status)
  console.log('verse stats:', JSON.stringify(v.json?.stats || v.json, null, 2))

  console.log('Checking chapter stats...')
  const c = await get(`/api/dev/diag?password=${encodeURIComponent(PASSWORD)}&type=chapter&id=${encodeURIComponent(CHAPTER_ID)}`)
  console.log('chapter status:', c.status)
  console.log('chapter stats:', JSON.stringify(c.json?.stats || c.json, null, 2))
}

run().catch(err => { console.error(err); process.exit(1) })
