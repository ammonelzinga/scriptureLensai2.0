import fetch from 'node-fetch'

const BASE = process.env.BASE_URL || 'http://localhost:3000'

async function run(){
  const res = await fetch(`${BASE}/api/search/lexical`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query:'mustard seed faith',mode:'verses',topK:100})})
  const json = await res.json().catch(()=>({}))
  console.log('status:', res.status)
  const results = json.results || []
  for(const r of results){
    if(r.reference?.toLowerCase().includes('matthew 17:20') || /matthew\s+17:20/i.test(r.reference||'')){
      console.log('FOUND Matthew 17:20 id:', r.id, 'similarity:', r.similarity)
    }
    if(/mustard/i.test(r.text||'')){
      console.log('MUSTARD verse candidate:', r.reference, 'id:', r.id)
    }
  }
  console.log('Total verses returned:', results.length)
}

run().catch(e=>{console.error(e);process.exit(1)})
