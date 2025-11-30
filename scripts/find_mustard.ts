import fetch from 'node-fetch'

const BASE = process.env.BASE_URL || 'http://localhost:3000'
const PASSWORD = process.env.DEV_PASSWORD || 'searchponderpray'

async function run() {
  const url = `${BASE}/api/dev/find_verses?password=${encodeURIComponent(PASSWORD)}&q=mustard`
  const res = await fetch(url)
  const json = await res.json().catch(()=>({}))
  console.log('status:', res.status)
  console.log(JSON.stringify(json,null,2))
}

run().catch(e=>{console.error(e);process.exit(1)})
