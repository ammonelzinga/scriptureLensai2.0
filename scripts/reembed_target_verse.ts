// Run with: node scripts/reembed_target_verse.ts
import fetch from 'node-fetch'

const BASE = process.env.BASE_URL || 'http://localhost:3000'
const PASSWORD = process.env.DEV_PASSWORD || 'searchponderpray'
const VERSE_ID = process.env.VERSE_ID || '44a1f647-8794-42cc-936a-bf49b9cbda17'

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
  console.log('Re-embedding verse and its chapter...')
  const resp = await post('/api/dev/embed', {
    password: PASSWORD,
    type: 'verse',
    verseId: VERSE_ID,
  })
  console.log('status:', resp.status)
  console.log('response:', JSON.stringify(resp.json, null, 2))
}

run().catch(err => { console.error(err); process.exit(1) })
