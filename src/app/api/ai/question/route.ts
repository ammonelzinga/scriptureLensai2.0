import { NextRequest, NextResponse } from 'next/server'
import { embedText, chatSummary } from '@/lib/openai'
import { supabaseAdmin } from '@/lib/supabase'

export async function POST(req: NextRequest) {
  const { question, topK = 10, versePerChapter = 3, hybrid = true, verseId, mode, debug = false } = await req.json()
  if (!question) return NextResponse.json({ error: 'Missing question' }, { status: 400 })

  // Expand question with GPT
  let expanded: string | null = null
  try {
    expanded = await chatSummary(
      'Rewrite the following as a rich, specific search statement for retrieving relevant scriptures. Stay concise. Do not answer the question.',
      question
    )
  } catch (err) {
    expanded = null
  }
  // Embed original (+ expanded if hybrid) then average
  const baseEmbedding = await embedText(question)
  let qVec = baseEmbedding
  if (hybrid) {
    try {
      const expandedEmbedding = expanded ? await embedText(expanded) : null
      qVec = expandedEmbedding ? averageVec(baseEmbedding, expandedEmbedding) : baseEmbedding
    } catch {
      qVec = baseEmbedding
    }
  }

  const sb = supabaseAdmin()
  let pinnedVerse: any = null
  let pinnedChapter: any = null
  // Prefer RPC similarity; fallback to local scoring
  let chapters: any[] = []
  const unlimited = topK === -1
  if (!unlimited) {
    try {
      const { data } = await sb.rpc('match_chapters', { query_embedding: qVec, match_count: topK })
      chapters = data || []
    } catch {
      const { data } = await sb
        .from('chapters')
        .select('id, title, seq, work_id, book_id, embedding')
        .not('embedding', 'is', null)
      const scored = (data || [])
        .map(ch => ({ ch, score: cosineSim(qVec, ch.embedding) }))
        .sort((a,b)=>b.score-a.score)
        .slice(0, topK)
      chapters = scored.map(s => ({ id: s.ch.id, title: s.ch.title, seq: s.ch.seq, work_id: s.ch.work_id, book_id: s.ch.book_id, similarity: s.score }))
    }
  } else {
    const { data } = await sb
      .from('chapters')
      .select('id, title, seq, work_id, book_id, embedding')
      .not('embedding', 'is', null)
    const scored = (data || [])
      .map(ch => ({ ch, score: cosineSim(qVec, ch.embedding) }))
      .sort((a,b)=>b.score-a.score)
    chapters = scored.map(s => ({ id: s.ch.id, title: s.ch.title, seq: s.ch.seq, work_id: s.ch.work_id, book_id: s.ch.book_id, similarity: s.score }))
  }

  // Collect verses via RPC, then group by chapter
  let verseMatches: any[] = []
  if (!unlimited) {
    try {
      const { data } = await sb.rpc('match_verses', { query_embedding: qVec, match_count: topK * versePerChapter * 3 })
      verseMatches = data || []
    } catch { verseMatches = [] }
  } else {
    // For all chapters, we won't pull all verses globally (could be huge); we'll score per chapter on demand.
    verseMatches = []
  }

  // If a specific verse is requested, fetch and compute its similarity and ensure its chapter is present
  if (verseId) {
    const { data: pv } = await sb
      .from('verses')
      .select('id, seq, text, embedding, chapter_id')
      .eq('id', verseId)
      .maybeSingle()
    if (pv) {
      const simV = pv.embedding ? cosineSim(qVec, pv.embedding) : 0
      pinnedVerse = { ...pv, similarity: simV }
      const { data: ch } = await sb
        .from('chapters')
        .select('id, title, seq, work_id, book_id, embedding')
        .eq('id', pv.chapter_id)
        .maybeSingle()
      if (ch) {
        const simC = ch.embedding ? cosineSim(qVec, ch.embedding) : 0
        pinnedChapter = { id: ch.id, title: ch.title, seq: ch.seq, work_id: ch.work_id, book_id: ch.book_id, similarity: simC }
        if (!chapters.some(c => c.id === ch.id)) {
          chapters.unshift(pinnedChapter)
          if (!unlimited && chapters.length > topK) chapters = chapters.slice(0, topK)
        }
      }
    }
  }

  const results: any[] = []
  for (const ch of chapters) {
    // If we have global verse matches, pick those belonging to this chapter
    let versesForChapter = verseMatches.filter(v => v.chapter_id === ch.id)
    if (!versesForChapter.length) {
      const { data: verses } = await sb
        .from('verses')
        .select('id, seq, text, embedding')
        .eq('chapter_id', ch.id)
      versesForChapter = (verses || [])
        .map(v => {
          const emb = normalizeEmbedding(v.embedding)
          const sim = emb ? cosineSim(qVec, emb) : 0
          return { ...v, embedding: emb, similarity: sim }
        })
        .sort((a,b)=>b.similarity-a.similarity)
    }
    // If pinned verse belongs to this chapter, put it at the front (dedup first)
    if (pinnedVerse && pinnedVerse.chapter_id === ch.id) {
      versesForChapter = versesForChapter.filter(v => v.id !== pinnedVerse.id)
      const pinnedEmb = normalizeEmbedding(pinnedVerse.embedding)
      const pinnedWithSim = pinnedVerse.similarity != null ? pinnedVerse : { ...pinnedVerse, similarity: pinnedEmb ? cosineSim(qVec, pinnedEmb) : 0 }
      versesForChapter.unshift(pinnedWithSim)
    }
    const topVerses = versesForChapter.slice(0, versePerChapter)
    results.push({ chapter: ch, verses: topVerses, score: ch.similarity })
  }

  // Ensure pinned chapter result is first
  if (pinnedChapter) {
    const idx = results.findIndex(r => r.chapter.id === pinnedChapter.id)
    if (idx > 0) {
      const [spliced] = results.splice(idx, 1)
      results.unshift(spliced)
    }
  }

  // Synthesize overview
  let overview: string | null = null
  try {
    overview = await chatSummary(
      'Synthesize a neutral overview (3-5 sentences) summarizing what the following scriptures collectively teach about the topic.',
      results.map(r => `[${r.chapter.title}] ${r.verses.map((v:any)=>v.text).join(' | ')}`).join(' ; ')
    )
  } catch {
    overview = null
  }

  // Optional debug diagnostics
  let diagnostics: any = undefined
  if (debug) {
    const norm = (vec: number[] | null | undefined) => {
      if (!vec || !Array.isArray(vec)) return { length: 0, norm: 0 }
      let n = 0
      for (let i=0;i<vec.length;i++) n += vec[i]*vec[i]
      return { length: vec.length, norm: Math.sqrt(n) }
    }
    diagnostics = {
      query: norm(baseEmbedding),
      queryHybrid: hybrid ? norm(qVec) : null,
      expandedPresent: !!expanded,
      pinnedVerse: pinnedVerse ? { id: pinnedVerse.id, similarity: pinnedVerse.similarity ?? null } : null,
      pinnedChapter: pinnedChapter ? { id: pinnedChapter.id, similarity: pinnedChapter.similarity ?? null } : null,
      firstResult: results[0] ? {
        chapterId: results[0].chapter?.id,
        score: results[0].score ?? null,
        firstVerseId: results[0].verses?.[0]?.id,
        firstVerseSim: results[0].verses?.[0]?.similarity ?? null,
      } : null,
    }
  }

  return NextResponse.json({ expanded: hybrid ? expanded : null, results, overview, hybrid, pinnedVerseId: pinnedVerse?.id || null, pinnedVerseSimilarity: pinnedVerse?.similarity ?? null, mode: mode || null, diagnostics })
  // Future: include pinned similarity diagnostics (added below for next response version)
}

function cosineSim(a: number[] = [], b: number[] = []) {
  let dot = 0, na = 0, nb = 0
  for (let i=0;i<a.length && i<b.length;i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i] }
  const denom = (Math.sqrt(na) * Math.sqrt(nb) + 1e-8)
  if (!isFinite(denom) || denom === 0) return 0
  const val = dot / denom
  return isFinite(val) ? val : 0
}

function averageVec(a: number[], b: number[]) {
  const n = Math.min(a.length, b.length)
  const out = new Array(n)
  for (let i=0;i<n;i++) out[i] = (a[i] + b[i]) / 2
  return out
}

function normalizeEmbedding(e: any): number[] | null {
  if (!e) return null
  if (Array.isArray(e)) return e as number[]
  if (typeof e === 'string') {
    try {
      const parsed = JSON.parse(e)
      return Array.isArray(parsed) ? parsed as number[] : null
    } catch { return null }
  }
  return null
}
