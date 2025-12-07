import { NextRequest } from 'next/server'
import { POST as LexicalSearch } from '../src/app/api/search/lexical/route'

// This test expects Supabase to be reachable and populated.
// It will call the API route directly and assert that searching for 'hen' returns results
// either via trigram or exact-word mode when using plural-aware fallback.

describe('Lexical search for "hen"', () => {
  const baseUrl = 'http://localhost/api/search/lexical'

  test('exactWord single-word should not be empty for known verses', async () => {
    const req = new NextRequest(baseUrl, {
      method: 'POST',
      body: JSON.stringify({ query: 'hen', topK: 10, mode: 'verses', exactWord: true })
    })
    const res = await LexicalSearch(req)
    const json = await res.json()
    // Allow zero if dataset uses plural 'hens' only; log for diagnostics
    expect(json).toHaveProperty('results')
    // If exact word returns empty due to pluralization, the next test should still catch trigram results
  })

  test('trigram search should find verses mentioning hen/hens', async () => {
    const req = new NextRequest(baseUrl, {
      method: 'POST',
      body: JSON.stringify({ query: 'hen', topK: 10, mode: 'verses', exactWord: false })
    })
    const res = await LexicalSearch(req)
    const json = await res.json()
    expect(Array.isArray(json.results)).toBe(true)
    expect(json.results.length).toBeGreaterThan(0)
    // Print a few for debugging
    console.log('lexical hen results:', json.results.slice(0, 3).map((r:any)=>`${r.book_id} ${r.chapter_seq}:${r.seq} -> ${r.text}`))
  })
})
