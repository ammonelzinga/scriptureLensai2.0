// Run with: node scripts/force_reembed_target_verse.ts
import fetch from 'node-fetch'

const BASE = process.env.BASE_URL || 'http://localhost:3000'
const PASSWORD = process.env.DEV_PASSWORD || 'searchponderpray'
const VERSE_ID = process.env.VERSE_ID || '44a1f647-8794-42cc-936a-bf49b9cbda17'
const CHAPTER_ID = process.env.CHAPTER_ID || 'a0c63e38-e557-4a33-bfd0-abab348bec96'

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

async function run() {
  console.log(`BASE=${BASE}`)
  console.log('Force re-embedding verse...')
  const v = await post('/api/dev/embed', { password: PASSWORD, type: 'verse', verseId: VERSE_ID, force: true })
  console.log('verse status:', v.status)
  console.log('verse response:', JSON.stringify(v.json, null, 2))

  console.log('Force re-embedding chapter...')
  const c = await post('/api/dev/embed', { password: PASSWORD, type: 'chapter', chapterId: CHAPTER_ID, force: true })
  console.log('chapter status:', c.status)
  console.log('chapter response:', JSON.stringify(c.json, null, 2))
}

run().catch(err => { console.error(err); process.exit(1) })
