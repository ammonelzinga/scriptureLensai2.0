"use client"
import { useEffect, useState } from 'react'

export default function AIPage() {
  return (
    <div className="space-y-8">
      <div className="grid lg:grid-cols-2 gap-6">
        <LexicalSearchCard />
        <ConceptHybridSearchCard />
      </div>
      <div className="grid lg:grid-cols-2 gap-6">
        <SimilarTextsCard />
        <ExplainPanel />
      </div>
      <div className="grid lg:grid-cols-2 gap-6">
        <TopicFinderCard />
      </div>
    </div>
  )
}

function LexicalSearchCard() {
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<'verses' | 'chapters'>('verses')
  const [topK, setTopK] = useState(20)
  const [minSimilarity, setMinSimilarity] = useState(0.2)
  const [workId, setWorkId] = useState('')
  const [bookId, setBookId] = useState('')
  const [rangeStart, setRangeStart] = useState('')
  const [rangeEnd, setRangeEnd] = useState('')
  const [rangeError, setRangeError] = useState('')
  const [works, setWorks] = useState<any[]>([])
  const [books, setBooks] = useState<any[]>([])
  const [results, setResults] = useState<any[]>([])
  const [busy, setBusy] = useState(false)

  // auto-expand helper (match Ask input behavior)
  const autoExpand = (el: HTMLTextAreaElement | null) => {
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 400) + 'px'
  }
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault(); if (!busy && query.trim()) run()
    }
  }

  useEffect(()=>{ fetch('/api/catalog/works').then(r=>r.json()).then(j=>setWorks(j.works||[])) },[])
  useEffect(()=>{
    const url = workId ? `/api/catalog/books?workId=${workId}` : '/api/catalog/books'
    fetch(url).then(r=>r.json()).then(j=>setBooks(j.books||[]))
    setBookId(''); setRangeStart(''); setRangeEnd('')
  },[workId])
  useEffect(()=>{
    const s = books.find(b=>b.id===rangeStart); const e = books.find(b=>b.id===rangeEnd)
    if (s&&e&&s.seq>e.seq) setRangeError('Start must be before End'); else setRangeError('')
  },[rangeStart, rangeEnd, books])

  const run = async () => {
    if (!query.trim()) return
    setBusy(true)
    try {
      const payload:any = { query, topK, mode, minSimilarity }
      if (workId) payload.workId = workId
      if (bookId) payload.bookId = bookId
      if (rangeStart) { const s=books.find(b=>b.id===rangeStart); if (s) payload.bookSeqMin = s.seq }
      if (rangeEnd) { const e=books.find(b=>b.id===rangeEnd); if (e) payload.bookSeqMax = e.seq }
      const res = await fetch('/api/search/lexical',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})
      const json = await res.json(); setResults(json.results||[])
    } finally { setBusy(false) }
  }

  return (
    <div className="border border-zinc-200 dark:border-zinc-800 rounded-lg p-4">
      <h2 className="font-medium">Lexical Search</h2>
      <p className="text-sm text-zinc-500">Exact / fuzzy word & phrase matching across scriptures.</p>
      <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 items-start">
        <div className="col-span-1 sm:col-span-2 lg:col-span-4">
          <textarea
            value={query}
            onChange={e=>{ setQuery(e.target.value); autoExpand(e.target) }}
            onKeyDown={onKeyDown}
            ref={el=>autoExpand(el)}
            placeholder="Exact/fuzzy words or phrase (Ctrl+Enter to search)"
            className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 px-4 py-3 text-sm leading-relaxed resize-none overflow-hidden"
            style={{ minHeight: 90 }}
          />
          <div className="mt-1 flex justify-between text-[10px] text-zinc-500">
            <span>Ctrl+Enter to search</span>
            <span>{query.length} chars</span>
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-zinc-600 dark:text-zinc-400">Mode</span>
          <select value={mode} onChange={e=>setMode(e.target.value as any)} className="rounded-md border border-zinc-300 dark:border-zinc-700 px-2 py-2 text-sm">
            <option value="verses">Verses</option>
            <option value="chapters">Chapters</option>
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-zinc-600 dark:text-zinc-400">Work</span>
          <select value={workId} onChange={e=>setWorkId(e.target.value)} className="rounded-md border border-zinc-300 dark:border-zinc-700 px-2 py-2 text-sm">
            <option value="">Any</option>
            {works.map(w=> <option key={w.id} value={w.id}>{w.abbrev||w.name}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-zinc-600 dark:text-zinc-400">Book</span>
          <select value={bookId} onChange={e=>setBookId(e.target.value)} className="rounded-md border border-zinc-300 dark:border-zinc-700 px-2 py-2 text-sm">
            <option value="">Any</option>
            {books.map(b=> <option key={b.id} value={b.id}>{b.seq}. {b.title}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-zinc-600 dark:text-zinc-400">Range (Start / End)</span>
          <div className="flex gap-2">
            <select value={rangeStart} onChange={e=>{const v=e.target.value; setRangeStart(v); if(v&&!rangeEnd) setRangeEnd(v)}} className="w-1/2 rounded-md border border-zinc-300 dark:border-zinc-700 px-2 py-2 text-sm">
              <option value="">Start</option>
              {books.map(b=> <option key={b.id} value={b.id}>{b.seq}. {b.title}</option>)}
            </select>
            <select value={rangeEnd} onChange={e=>setRangeEnd(e.target.value)} className="w-1/2 rounded-md border border-zinc-300 dark:border-zinc-700 px-2 py-2 text-sm">
              <option value="">End</option>
              {books.map(b=> <option key={b.id} value={b.id}>{b.seq}. {b.title}</option>)}
            </select>
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-zinc-600 dark:text-zinc-400">Result Limit</span>
          <select value={topK} onChange={e=>setTopK(Number(e.target.value))} className="rounded-md border border-zinc-300 dark:border-zinc-700 px-2 py-2 text-sm">
            {[10,20,30,50,100].map(n=> <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-zinc-600 dark:text-zinc-400">Min Similarity ({minSimilarity.toFixed(2)})</span>
          <input type="range" min={0} max={0.9} step={0.05} value={minSimilarity} onChange={e=>setMinSimilarity(Number(e.target.value))} />
        </div>
        <div className="flex items-end">
          <button onClick={run} disabled={!query.trim()||busy||!!rangeError} className="w-full rounded-md bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50">{busy?'Searching…':'Search'}</button>
        </div>
        {rangeError && <div className="text-xs text-red-600">{rangeError}</div>}
      </div>
      {results.length>0 && (
        <ul className="mt-4 space-y-2 text-sm">
          {results.map((r:any,i:number)=> {
            const isVerseMode = mode === 'verses'
            const ref = isVerseMode && r.book_title && r.chapter_seq ? `${r.book_title} ${r.chapter_seq}:${r.seq}` : undefined;
            return (
              <li key={i} className="rounded-md border border-zinc-200 dark:border-zinc-800 p-2">
                <div className="flex items-center justify-between mb-1">
                  <div className="font-medium">
                    {ref ? ref : (r.book_title ? `${r.book_title} — ` : '') + (r.chapter_title || r.title || (r.seq?`Chapter ${r.seq}`:''))}
                  </div>
                  <div className="flex items-center gap-2 text-[10px]">
                    {mode === 'verses' && (
                      <a href={`/read?chapterId=${encodeURIComponent(r.chapter_id)}&highlight=${encodeURIComponent(r.id)}`} className="underline">Open</a>
                    )}
                    {mode === 'chapters' && (
                      <a href={`/read?chapterId=${encodeURIComponent(r.id)}`} className="underline">Open</a>
                    )}
                    <button type="button" onClick={()=>navigator.clipboard?.writeText(String(r.id))} className="underline">Copy ID</button>
                  </div>
                </div>
                {r.text && <div className="text-zinc-700 dark:text-zinc-300 leading-relaxed">{r.text}</div>}
                {typeof r.similarity==='number' && <div className="mt-1 text-[11px] text-zinc-500">similarity: {r.similarity.toFixed(4)}</div>}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

function TopicFinderCard() {
  const [q, setQ] = useState('What Old Testament prophecies did Jesus Christ fulfill?')
  const [busy, setBusy] = useState(false)
  const [data, setData] = useState<any>(null)
  const [topK, setTopK] = useState<number>(12)
  const [hybrid, setHybrid] = useState<boolean>(true)
  const [books, setBooks] = useState<any[]>([])
  const [pairGospels, setPairGospels] = useState<boolean>(true)
  useEffect(()=>{ fetch('/api/catalog/books').then(r=>r.json()).then(j=>setBooks(j.books||[])) },[])

  const run = async () => {
    setBusy(true)
    try {
      const res = await fetch('/api/search/topic',{method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ question: q, topK, hybrid, focus: 'prophecies-fulfilled', pairGospels }) })
      const json = await res.json(); setData(json)
    } finally { setBusy(false) }
  }
  return (
    <div className="border border-zinc-200 dark:border-zinc-800 rounded-lg p-4">
      <h2 className="font-medium">Topic Finder (Prophecies)</h2>
      <p className="text-sm text-zinc-500">Find chunked passages for thematic questions (prophecies, fulfillments).</p>
      <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 items-start">
        <div className="col-span-1 sm:col-span-2 lg:col-span-4">
          <input value={q} onChange={e=>setQ(e.target.value)} className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm" />
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-zinc-600 dark:text-zinc-400">Results</label>
          <select value={topK} onChange={e=>setTopK(Number(e.target.value))} className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 px-2 py-2 text-sm">
            {[8,12,16,20,30].map(n=> <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-zinc-600 dark:text-zinc-400">Hybrid</label>
          <input type="checkbox" checked={hybrid} onChange={e=>setHybrid(e.target.checked)} />
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-zinc-600 dark:text-zinc-400">Pair OT→Gospels</label>
          <input type="checkbox" checked={pairGospels} onChange={e=>setPairGospels(e.target.checked)} />
        </div>
        <div>
          <button disabled={!q||busy} onClick={run} className="w-full rounded-md bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50">{busy?'Searching…':'Search'}</button>
        </div>
      </div>
      {data?.pairs && data.pairs.length>0 && (
        <div className="mt-4 space-y-2">
          <h3 className="font-medium text-sm">Curated Pairings (OT → Gospel)</h3>
          <ul className="space-y-2">
            {data.pairs.map((p:any,i:number)=> (
              <li key={i} className="grid md:grid-cols-2 gap-2">
                <div className="rounded-md border border-zinc-200 dark:border-zinc-800 p-2">
                  <div className="text-xs font-medium mb-1">Source (OT)</div>
                  <ChunkCards books={books} chunks={[p.source]} devtools={false} pinVerseId={''} />
                </div>
                <div className="rounded-md border border-zinc-200 dark:border-zinc-800 p-2">
                  <div className="text-xs font-medium mb-1">Target (Gospel)</div>
                  <ChunkCards books={books} chunks={[p.target]} devtools={false} pinVerseId={''} />
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
      {data?.chunks && <ChunkCards books={books} chunks={data.chunks} devtools={false} pinVerseId={''} />}
    </div>
  )
}

function ConceptHybridSearchCard() {
  // reuse existing AskQuestionCard logic but simplified
  return <AskQuestionCard />
}

function SimilarTextsCard() {
  const [verseId, setVerseId] = useState('')
  const [excludeSameChapter, setExcludeSameChapter] = useState(true)
  const [bookId, setBookId] = useState('')
  const [workId, setWorkId] = useState('')
  const [works, setWorks] = useState<any[]>([])
  const [books, setBooks] = useState<any[]>([])
  const [diversity, setDiversity] = useState<number>(0)
  const [showMore, setShowMore] = useState<boolean>(false)
  const [busy, setBusy] = useState(false)
  const [data, setData] = useState<any>(null)
  const [rangeStart, setRangeStart] = useState<string>('')
  const [rangeEnd, setRangeEnd] = useState<string>('')
  const [rangeError, setRangeError] = useState<string>('')

  useEffect(() => {
    // Load works
    fetch('/api/catalog/works').then(r=>r.json()).then(j=>setWorks(j.works||[]))
  }, [])
  // Hydrate initial state from URL
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const w = params.get('workId') || ''
    const b = params.get('bookId') || ''
    const rs = params.get('rangeStart') || ''
    const re = params.get('rangeEnd') || ''
    const exc = params.get('excludeSameChapter')
    const div = params.get('diversity')
    if (w) setWorkId(w)
    if (b) setBookId(b)
    if (rs) setRangeStart(rs)
    if (re) setRangeEnd(re)
    if (exc) setExcludeSameChapter(exc === '1')
    if (div) setDiversity(Number(div))
  }, [])
  // Persist selections to URL for shareable links
  useEffect(() => {
    const params = new URLSearchParams()
    if (workId) params.set('workId', workId)
    if (bookId) params.set('bookId', bookId)
    if (rangeStart) params.set('rangeStart', rangeStart)
    if (rangeEnd) params.set('rangeEnd', rangeEnd)
    if (excludeSameChapter) params.set('excludeSameChapter', '1')
    if (diversity) params.set('diversity', String(diversity))
    const qs = params.toString()
    const url = qs ? `?${qs}` : ''
    window.history.replaceState(null, '', url)
  }, [workId, bookId, rangeStart, rangeEnd, excludeSameChapter, diversity])
  useEffect(() => {
    // Load books for selected work
    const url = workId ? `/api/catalog/books?workId=${encodeURIComponent(workId)}` : '/api/catalog/books'
    fetch(url).then(r=>r.json()).then(j=>setBooks(j.books||[]))
    // Auto-clear book selection when work changes
    setBookId('')
    // Also clear range when work changes to avoid mismatched seqs
    setRangeStart('')
    setRangeEnd('')
  }, [workId])
  useEffect(() => {
    // Validate range: Start ≤ End when both selected
    const bStart = books.find(b => b.id === rangeStart)
    const bEnd = books.find(b => b.id === rangeEnd)
    if (bStart && bEnd && bStart.seq > bEnd.seq) {
      setRangeError('Start must be before or equal to End')
    } else {
      setRangeError('')
    }
  }, [rangeStart, rangeEnd, books])
  const run = async () => {
    setBusy(true)
    try {
      const payload: any = { verseId, topK: 10, excludeSameChapter }
      if (bookId) payload.bookId = bookId
      if (workId) payload.workId = workId
      if (rangeStart) {
        const bStart = books.find(b => b.id === rangeStart)
        if (bStart) payload.bookSeqMin = bStart.seq
      }
      if (rangeEnd) {
        const bEnd = books.find(b => b.id === rangeEnd)
        if (bEnd) payload.bookSeqMax = bEnd.seq
      }
      if (diversity > 0) payload.diversity = diversity
      const res = await fetch('/api/search/similar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      const json = await res.json(); setData(json)
    } finally { setBusy(false) }
  }
  return (
    <div className="border border-zinc-200 dark:border-zinc-800 rounded-lg p-4">
      <h2 className="font-medium">Find Similar Texts</h2>
      <p className="text-sm text-zinc-500">Enter a verse ID to compare against all chapters.</p>
      <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 sm:gap-3 items-start">
        <input value={verseId} onChange={e=>setVerseId(e.target.value)} placeholder="Verse ID" className="flex-1 rounded-md border border-zinc-300 dark:border-zinc-700 px-3 py-2" />
        <div className="flex items-center gap-2">
          <label className="text-xs text-zinc-600 dark:text-zinc-400">Exclude same chapter</label>
          <input type="checkbox" checked={excludeSameChapter} onChange={e=>setExcludeSameChapter(e.target.checked)} />
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-zinc-600 dark:text-zinc-400">Work</label>
          <select value={workId} onChange={e=>setWorkId(e.target.value)} className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 px-2 py-2 text-sm">
            <option value="">Any</option>
            {works.map(w=> <option key={w.id} value={w.id}>{w.abbrev || w.name}</option>)}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-zinc-600 dark:text-zinc-400">Book</label>
          <select value={bookId} onChange={e=>setBookId(e.target.value)} className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 px-2 py-2 text-sm">
            <option value="">Any</option>
            {books.map(b=> <option key={b.id} value={b.id}>{b.seq}. {b.title}</option>)}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-zinc-600 dark:text-zinc-400">Range</label>
          <select value={rangeStart} onChange={e=>{ const v=e.target.value; setRangeStart(v); if (v && !rangeEnd) setRangeEnd(v) }} className="flex-1 rounded-md border border-zinc-300 dark:border-zinc-700 px-2 py-2 text-sm">
            <option value="">Start</option>
            {books.map(b=> <option key={b.id} value={b.id}>{b.seq}. {b.title}</option>)}
          </select>
          <span className="text-xs">→</span>
          <select value={rangeEnd} onChange={e=>setRangeEnd(e.target.value)} className="flex-1 rounded-md border border-zinc-300 dark:border-zinc-700 px-2 py-2 text-sm">
            <option value="">End</option>
            {books.map(b=> <option key={b.id} value={b.id}>{b.seq}. {b.title}</option>)}
          </select>
        </div>
        {showMore && (
          <div className="col-span-1 sm:col-span-2 lg:col-span-3 grid grid-cols-1 sm:grid-cols-2 gap-3 order-last">
            <div className="flex items-center gap-2">
              <label className="text-xs text-zinc-600 dark:text-zinc-400">Diversity</label>
              <select value={diversity} onChange={e=>setDiversity(Number(e.target.value))} className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 px-2 py-2 text-sm">
                {[0,0.15,0.3,0.5,0.7].map(n=> <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
          </div>
        )}
        <div className="col-span-1 sm:col-span-2 lg:col-span-3 flex justify-end">
          <button type="button" className="text-xs underline" onClick={()=>setShowMore(v=>!v)}>{showMore ? 'Hide filters' : 'More filters'}</button>
        </div>
        <div>
          <button disabled={!verseId||busy||!!rangeError} onClick={run} className="w-full rounded-md bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50">{busy?'Searching…':'Search'}</button>
        </div>
      </div>
      {rangeError && <div className="mt-2 text-xs text-red-600">{rangeError}</div>}
      {!rangeError && (rangeStart || rangeEnd) && (
        <div className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
          Range: {(() => {
            const s = books.find(b=>b.id===rangeStart); const e = books.find(b=>b.id===rangeEnd)
            const sLabel = s ? `${s.seq}. ${s.title}` : 'Start'
            const eLabel = e ? `${e.seq}. ${e.title}` : 'End'
            return `${sLabel} → ${eLabel}`
          })()}
        </div>
      )}
      {data?.summary && <p className="mt-3 text-sm italic">{data.summary}</p>}
      {data?.suggestions && (
        <ul className="mt-3 space-y-2 text-sm">
          {data.suggestions.map((s:any,i:number)=>(
            <li key={i} className="rounded-md border border-zinc-200 dark:border-zinc-800 p-2">
              <div className="font-medium">
                {(() => {
                  const b = books.find(bk => bk.id === s.chapter.book_id)
                  const bookLabel = b ? b.title : (s.chapter.book_title || 'Book')
                  const chapLabel = s.chapter.seq ? `Chapter ${s.chapter.seq}` : (s.chapter.title || 'Chapter')
                  return `${bookLabel} — ${chapLabel}`
                })()}
              </div>
              <div className="text-zinc-600 dark:text-zinc-400">{s.verses.map((v:any)=>v.text).join('  |  ')}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function ExplainPanel() {
  const [query, setQuery] = useState('')
  const [workId, setWorkId] = useState('')
  const [bookId, setBookId] = useState('')
  const [rangeStart, setRangeStart] = useState('')
  const [rangeEnd, setRangeEnd] = useState('')
  const [works, setWorks] = useState<any[]>([])
  const [books, setBooks] = useState<any[]>([])
  const [data, setData] = useState<any>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [rangeError, setRangeError] = useState('')

  useEffect(()=>{ fetch('/api/catalog/works').then(r=>r.json()).then(j=>setWorks(j.works||[]))},[])
  // Persist open state
  useEffect(()=>{ const saved = typeof window !== 'undefined' ? localStorage.getItem('sl_explainOpen') : null; if(saved){ setOpen(saved==='1') } },[])
  useEffect(()=>{ if(typeof window!=='undefined') localStorage.setItem('sl_explainOpen', open?'1':'0') },[open])
  useEffect(()=>{ const url = workId ? `/api/catalog/books?workId=${workId}`:'/api/catalog/books'; fetch(url).then(r=>r.json()).then(j=>setBooks(j.books||[])); setBookId(''); setRangeStart(''); setRangeEnd('') },[workId])
  useEffect(()=>{ const s=books.find(b=>b.id===rangeStart); const e=books.find(b=>b.id===rangeEnd); if(s&&e&&s.seq>e.seq) setRangeError('Start must be before End'); else setRangeError('') },[rangeStart, rangeEnd, books])

  const run = async () => {
    if (!query.trim()) return
    setBusy(true)
    try {
      const payload:any = { query, topKChapters: 10, topKVerses: 25 }
      if (workId) payload.workId = workId
      if (bookId) payload.bookId = bookId
      if (rangeStart) { const s=books.find(b=>b.id===rangeStart); if(s) payload.bookSeqMin = s.seq }
      if (rangeEnd) { const e=books.find(b=>b.id===rangeEnd); if(e) payload.bookSeqMax = e.seq }
      const res = await fetch('/api/search/explain',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})
      const json = await res.json(); setData(json)
    } finally { setBusy(false) }
  }

  return (
    <div className="border border-zinc-200 dark:border-zinc-800 rounded-lg p-4">
      <div className="flex items-center justify-between">
        <h2 className="font-medium">Explain / Diagnostics</h2>
        <button className="text-xs underline" onClick={()=>setOpen(o=>!o)}>{open?'Collapse':'Expand'}</button>
      </div>
      <p className="text-sm text-zinc-500">Compare lexical vs semantic contribution for a query.</p>
      {open && (
        <>
          <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <input value={query} onChange={e=>setQuery(e.target.value)} placeholder="diagnostic query" className="rounded-md border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm" />
            <div className="flex flex-col gap-1">
              <span className="text-xs text-zinc-600 dark:text-zinc-400">Work</span>
              <select value={workId} onChange={e=>setWorkId(e.target.value)} className="rounded-md border border-zinc-300 dark:border-zinc-700 px-2 py-2 text-sm">
                <option value="">Any</option>
                {works.map(w=> <option key={w.id} value={w.id}>{w.abbrev||w.name}</option>)}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs text-zinc-600 dark:text-zinc-400">Book</span>
              <select value={bookId} onChange={e=>setBookId(e.target.value)} className="rounded-md border border-zinc-300 dark:border-zinc-700 px-2 py-2 text-sm">
                <option value="">Any</option>
                {books.map(b=> <option key={b.id} value={b.id}>{b.seq}. {b.title}</option>)}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs text-zinc-600 dark:text-zinc-400">Range</span>
              <div className="flex gap-2">
                <select value={rangeStart} onChange={e=>{const v=e.target.value; setRangeStart(v); if(v&&!rangeEnd) setRangeEnd(v)}} className="w-1/2 rounded-md border border-zinc-300 dark:border-zinc-700 px-2 py-2 text-sm">
                  <option value="">Start</option>
                  {books.map(b=> <option key={b.id} value={b.id}>{b.seq}. {b.title}</option>)}
                </select>
                <select value={rangeEnd} onChange={e=>setRangeEnd(e.target.value)} className="w-1/2 rounded-md border border-zinc-300 dark:border-zinc-700 px-2 py-2 text-sm">
                  <option value="">End</option>
                  {books.map(b=> <option key={b.id} value={b.id}>{b.seq}. {b.title}</option>)}
                </select>
              </div>
            </div>
            <div className="flex items-end">
              <button onClick={run} disabled={!query.trim()||busy||!!rangeError} className="w-full rounded-md bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50">{busy?'Analyzing…':'Run'}</button>
            </div>
            {rangeError && <div className="text-xs text-red-600">{rangeError}</div>}
          </div>
          {data && (
            <div className="mt-4 space-y-4 text-xs">
              {data.chapters && data.chapters.length>0 && (
                <div>
                  <h3 className="font-medium mb-2 text-sm">Chapters</h3>
                  <table className="w-full text-left border-collapse">
                    <thead className="text-[11px] text-zinc-500">
                      <tr>
                        <th className="py-1 pr-2">Chapter</th>
                        <th className="py-1 pr-2">Semantic</th>
                        <th className="py-1 pr-2">Lexical</th>
                        <th className="py-1 pr-2">Diff Insight</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.chapters.map((c:any,i:number)=>{
                        const semanticVal = Number(c.semantic_similarity ?? c.similarity)
                        const lexicalVal = Number(c.lexical_similarity ?? c.lexical)
                        const semantic = Number.isFinite(semanticVal) ? semanticVal : 0
                        const lexical = Number.isFinite(lexicalVal) ? lexicalVal : 0
                        const insight = semantic > 0.6 && lexical < 0.15 ? 'Concept match' : lexical > 0.4 && semantic < 0.3 ? 'Word match' : ''
                        return (
                          <tr key={i} className="border-t border-zinc-200 dark:border-zinc-800">
                            <td className="py-1 pr-2">{c.title || `Chapter ${c.seq}`}</td>
                            <td className="py-1 pr-2">{Number.isFinite(semantic) ? semantic.toFixed(3) : '-'}</td>
                            <td className="py-1 pr-2">{Number.isFinite(lexical) ? lexical.toFixed(3) : '-'}</td>
                            <td className="py-1 pr-2 text-zinc-600 dark:text-zinc-400">{insight}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              {data.verses && data.verses.length>0 && (
                <div>
                  <h3 className="font-medium mb-2 text-sm">Verses</h3>
                  <table className="w-full text-left border-collapse">
                    <thead className="text-[11px] text-zinc-500">
                      <tr>
                        <th className="py-1 pr-2">Verse</th>
                        <th className="py-1 pr-2">Semantic</th>
                        <th className="py-1 pr-2">Lexical</th>
                        <th className="py-1 pr-2">Diff Insight</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.verses.map((v:any,i:number)=>{
                        const semanticVal = Number(v.semantic_similarity ?? v.similarity)
                        const lexicalVal = Number(v.lexical_similarity ?? v.lexical)
                        const semantic = Number.isFinite(semanticVal) ? semanticVal : 0
                        const lexical = Number.isFinite(lexicalVal) ? lexicalVal : 0
                        const insight = semantic > 0.6 && lexical < 0.15 ? 'Concept match' : lexical > 0.4 && semantic < 0.3 ? 'Word match' : ''
                        return (
                          <tr key={i} className="border-t border-zinc-200 dark:border-zinc-800">
                            <td className="py-1 pr-2 truncate max-w-[240px]" title={v.text}>{v.text.slice(0,80)}{v.text.length>80?'…':''}</td>
                            <td className="py-1 pr-2">{Number.isFinite(semantic) ? semantic.toFixed(3) : '-'}</td>
                            <td className="py-1 pr-2">{Number.isFinite(lexical) ? lexical.toFixed(3) : '-'}</td>
                            <td className="py-1 pr-2 text-zinc-600 dark:text-zinc-400">{insight}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
function AskQuestionCard() {
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const [data, setData] = useState<any>(null)
  const [topK, setTopK] = useState<string>('10')
  const [devtools, setDevtools] = useState<boolean>(false)
  const [versesPerChapter, setVersesPerChapter] = useState<number>(3)
  const [testament, setTestament] = useState<string>('')
  const [bookId, setBookId] = useState<string>('')
  const [workId, setWorkId] = useState<string>('')
  const [works, setWorks] = useState<any[]>([])
  const [books, setBooks] = useState<any[]>([])
  const [rangeStart, setRangeStart] = useState<string>('')
  const [rangeEnd, setRangeEnd] = useState<string>('')
  const [rangeError, setRangeError] = useState<string>('')
  const [showMore, setShowMore] = useState<boolean>(false)
  const [hybrid, setHybrid] = useState<boolean>(true)
  const [showExpanded, setShowExpanded] = useState<boolean>(false)
  const [pinVerseId, setPinVerseId] = useState<string>('')
  const [lexicalWeight, setLexicalWeight] = useState<number>(0.15)

  useEffect(() => { fetch('/api/catalog/works').then(r=>r.json()).then(j=>setWorks(j.works||[])) }, [])
  // Load persisted toggles
  useEffect(() => {
    if (typeof window === 'undefined') return
    const savedHybrid = localStorage.getItem('sl_hybrid')
    if (savedHybrid) setHybrid(savedHybrid === '1')
    const savedExpanded = localStorage.getItem('sl_showExpanded')
    if (savedExpanded) setShowExpanded(savedExpanded === '1')
  }, [])
  // Persist changes
  useEffect(() => { if(typeof window!=='undefined') localStorage.setItem('sl_hybrid', hybrid?'1':'0') }, [hybrid])
  useEffect(() => { if(typeof window!=='undefined') localStorage.setItem('sl_showExpanded', showExpanded?'1':'0') }, [showExpanded])
  // Hydrate initial state from URL
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const w = params.get('workId') || ''
    const b = params.get('bookId') || ''
    const rs = params.get('rangeStart') || ''
    const re = params.get('rangeEnd') || ''
    const t = params.get('testament') || ''
    const tk = params.get('topK')
    const vpc = params.get('versesPerChapter')
    if (w) setWorkId(w)
    if (b) setBookId(b)
    if (rs) setRangeStart(rs)
    if (re) setRangeEnd(re)
    if (t) setTestament(t)
    if (tk) setTopK(tk)
    if (vpc) setVersesPerChapter(Number(vpc))
  }, [])
  // Persist selections to URL for shareable links
  useEffect(() => {
    const params = new URLSearchParams()
    if (workId) params.set('workId', workId)
    if (bookId) params.set('bookId', bookId)
    if (rangeStart) params.set('rangeStart', rangeStart)
    if (rangeEnd) params.set('rangeEnd', rangeEnd)
    if (testament) params.set('testament', testament)
    params.set('topK', topK)
    params.set('versesPerChapter', String(versesPerChapter))
    const qs = params.toString()
    const url = qs ? `?${qs}` : ''
    window.history.replaceState(null, '', url)
  }, [workId, bookId, rangeStart, rangeEnd, testament, topK, versesPerChapter])
  useEffect(() => {
    const url = workId ? `/api/catalog/books?workId=${encodeURIComponent(workId)}` : '/api/catalog/books'
    fetch(url).then(r=>r.json()).then(j=>setBooks(j.books||[]))
    // Auto-clear book selection when work changes
    setBookId('')
    setRangeStart('')
    setRangeEnd('')
  }, [workId])
  useEffect(() => {
    const bStart = books.find(b => b.id === rangeStart)
    const bEnd = books.find(b => b.id === rangeEnd)
    if (bStart && bEnd && bStart.seq > bEnd.seq) {
      setRangeError('Start must be before or equal to End')
    } else {
      setRangeError('')
    }
  }, [rangeStart, rangeEnd, books])
  const run = async () => {
    setBusy(true)
    try {
      const unlimited = topK === 'all'
      const payload: any = { question: q, topK: unlimited ? -1 : Number(topK), versesPerChapter: versesPerChapter, hybrid }
      if (hybrid) payload.lexicalWeight = lexicalWeight
      const pinTrim = pinVerseId.trim()
      if (pinTrim) payload.verseId = pinTrim
      if (testament) payload.testament = testament
      if (bookId) payload.bookId = bookId
      if (workId) payload.workId = workId
      if (rangeStart) {
        const bStart = books.find(b => b.id === rangeStart)
        if (bStart) payload.bookSeqMin = bStart.seq
      }
      if (rangeEnd) {
        const bEnd = books.find(b => b.id === rangeEnd)
        if (bEnd) payload.bookSeqMax = bEnd.seq
      }
      const res = await fetch('/api/ai/question', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      const json = await res.json(); setData(json)
    } finally { setBusy(false) }
  }
  // auto-expand helper
  const autoExpand = (el: HTMLTextAreaElement | null) => {
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 400) + 'px'
  }
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault(); if (!busy && q.trim()) run()
    }
  }
  return (
    <div className="border border-zinc-200 dark:border-zinc-800 rounded-lg p-4">
      <h2 className="font-medium">Concept & Hybrid Search</h2>
      <p className="text-sm text-zinc-500">Semantic exploration (optionally hybrid with expansion & lexical boost).</p>
      <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 items-start">
        <div className="col-span-1 sm:col-span-2 lg:col-span-4">
          <textarea
            value={q}
            onChange={e=>{ setQ(e.target.value); autoExpand(e.target) }}
            onKeyDown={onKeyDown}
            ref={el=>autoExpand(el)}
            placeholder="What do scriptures say about… (enter a theme, question, or concept)"
            className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 px-4 py-3 text-sm leading-relaxed resize-none overflow-hidden"
            style={{ minHeight: 110 }}
          />
          <div className="mt-1 flex justify-between text-[10px] text-zinc-500">
            <span>Ctrl+Enter to submit</span>
            <span>{q.length} chars</span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={hybrid} onChange={e=>setHybrid(e.target.checked)} /> Hybrid scoring
            </label>
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={showExpanded} onChange={e=>setShowExpanded(e.target.checked)} /> Show expanded query
            </label>
            <div className="flex items-center gap-2">
              <span>Lexical weight</span>
              <input type="range" min={0} max={0.5} step={0.01} value={lexicalWeight} onChange={e=>setLexicalWeight(Number(e.target.value))} disabled={!hybrid} />
              <span className="tabular-nums">{lexicalWeight.toFixed(2)}</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-zinc-600 dark:text-zinc-400">Testament</label>
          <select value={testament} onChange={e=>setTestament(e.target.value)} className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 px-2 py-2 text-sm">
            <option value="">Any</option>
            <option value="old">Old</option>
            <option value="new">New</option>
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-zinc-600 dark:text-zinc-400">Work</label>
          <select value={workId} onChange={e=>setWorkId(e.target.value)} className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 px-2 py-2 text-sm">
            <option value="">Any</option>
            {works.map(w=> <option key={w.id} value={w.id}>{w.abbrev || w.name}</option>)}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-zinc-600 dark:text-zinc-400">Book</label>
          <select value={bookId} onChange={e=>setBookId(e.target.value)} className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 px-2 py-2 text-sm">
            <option value="">Any</option>
            {books.map(b=> <option key={b.id} value={b.id}>{b.seq}. {b.title}</option>)}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-zinc-600 dark:text-zinc-400">Pin verse ID</label>
          <input value={pinVerseId} onChange={e=>setPinVerseId(e.target.value.trim())} placeholder="optional verse id" className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 px-2 py-2 text-sm" />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-zinc-600 dark:text-zinc-400">Range</span>
          <div className="flex gap-2">
            <select value={rangeStart} onChange={e=>{ const v=e.target.value; setRangeStart(v); if (v && !rangeEnd) setRangeEnd(v) }} className="w-1/2 rounded-md border border-zinc-300 dark:border-zinc-700 px-2 py-2 text-sm">
              <option value="">Start</option>
              {books.map(b=> <option key={b.id} value={b.id}>{b.seq}. {b.title}</option>)}
            </select>
            <select value={rangeEnd} onChange={e=>setRangeEnd(e.target.value)} className="w-1/2 rounded-md border border-zinc-300 dark:border-zinc-700 px-2 py-2 text-sm">
              <option value="">End</option>
              {books.map(b=> <option key={b.id} value={b.id}>{b.seq}. {b.title}</option>)}
            </select>
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-zinc-600 dark:text-zinc-400">Results</span>
          <select value={topK} onChange={e=>setTopK(e.target.value)} className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 px-2 py-2 text-sm">
            {['10','15','20','30','50','100','all'].map(n=> <option key={n} value={n}>{n === 'all' ? 'All' : n}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-zinc-600 dark:text-zinc-400">Verses/Chapter</span>
          <select value={versesPerChapter} onChange={e=>setVersesPerChapter(Number(e.target.value))} className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 px-2 py-2 text-sm">
            {[1,2,3,4,5].map(n=> <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
        {showMore && (
          <div className="col-span-1 sm:col-span-2 lg:col-span-3 grid grid-cols-1 sm:grid-cols-2 gap-3 order-last">
            <div className="flex items-center gap-2">
              <label className="text-xs text-zinc-600 dark:text-zinc-400">Devtools</label>
              <input type="checkbox" checked={devtools} onChange={e=>setDevtools(e.target.checked)} />
            </div>
          </div>
        )}
        <div className="col-span-1 sm:col-span-2 lg:col-span-3 flex justify-end">
          <button type="button" className="text-xs underline" onClick={()=>setShowMore(v=>!v)}>{showMore ? 'Hide filters' : 'More filters'}</button>
        </div>
        <div>
          <button disabled={!q||busy||!!rangeError} onClick={run} className="w-full rounded-md bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50">{busy?'Exploring…':'Explore'}</button>
        </div>
      </div>
      {rangeError && <div className="mt-2 text-xs text-red-600">{rangeError}</div>}
      {!rangeError && (rangeStart || rangeEnd) && (
        <div className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
          Range: {(() => {
            const s = books.find(b=>b.id===rangeStart); const e = books.find(b=>b.id===rangeEnd)
            const sLabel = s ? `${s.seq}. ${s.title}` : 'Start'
            const eLabel = e ? `${e.seq}. ${e.title}` : 'End'
            return `${sLabel} → ${eLabel}`
          })()}
        </div>
      )}
      {showExpanded && data?.expanded && (
        <div className="mt-3 text-xs text-zinc-500">Expanded: {data.expanded}</div>
      )}
      {data?.overview && (
        <p className="mt-3 text-sm italic">{data.overview}</p>
      )}
      {data?.chunks && (
        <ChunkCards books={books} chunks={data.chunks} devtools={devtools} pinVerseId={pinVerseId} />
      )}
    </div>
  )
}

function ChunkCards({ books, chunks, devtools, pinVerseId }:{ books:any[]; chunks:any[]; devtools:boolean; pinVerseId:string }){
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const toggle = (id:string) => setOpen(s => ({...s, [id]: !s[id]}))
  return (
    <ul className="mt-3 space-y-2 text-sm">
      {chunks.map((c:any,i:number)=>{
        const id = c.chunk.id
        const b = books.find(bk => bk.id === c.chunk.book_id)
        const bookLabel = b ? b.title : (c.chunk.book_title || 'Book')
        const chRange = c.chunk.start_chapter === c.chunk.end_chapter || !c.chunk.end_chapter
          ? `Chapter ${c.chunk.start_chapter}`
          : `Chapters ${c.chunk.start_chapter}–${c.chunk.end_chapter}`
        const highlight = c.verses.map((v:any)=>v.id).join(',')
        const openLink = `/read?bookId=${encodeURIComponent(c.chunk.book_id)}&chapter=${encodeURIComponent(c.verses[0]?.chapter_seq||c.chunk.start_chapter||1)}&highlight=${encodeURIComponent(highlight)}`
        return (
          <li key={id || i} className="rounded-md border border-zinc-200 dark:border-zinc-800">
            <div className="p-2 flex items-center justify-between">
              <div className="font-medium flex items-center gap-2">
                <span>{bookLabel} — {chRange}</span>
                {devtools && typeof c.score === 'number' && (
                  <span className="text-[11px] text-zinc-500">similarity: {c.score.toFixed(4)}</span>
                )}
              </div>
              <div className="flex items-center gap-2 text-[10px]">
                <a href={openLink} className="underline">Open</a>
                <button type="button" onClick={()=>navigator.clipboard?.writeText(String(c.combined_text || ''))} className="underline">Copy text</button>
                <button type="button" onClick={()=>navigator.clipboard?.writeText(String(id))} className="underline">Copy ID</button>
                <button type="button" onClick={()=>toggle(id)} className="underline">{open[id]?'Hide':'Show'} text</button>
              </div>
            </div>
            <div className="px-2 pb-2 text-zinc-600 dark:text-zinc-400">
              <div>
                {c.verses.map((v:any, idx:number)=>{
                  const ref = bookLabel && v.chapter_seq && v.seq ? `${bookLabel} ${v.chapter_seq}:${v.seq}` : ''
                  return (
                    <span key={v.id || idx} className="inline-block mr-2">
                      <span className="font-medium text-[11px] mr-1 text-zinc-500">{ref}</span>
                      {v.text}
                      {pinVerseId && String(v.id) === pinVerseId.trim() && (
                        <span className="ml-1 text-[11px] text-zinc-500">(pinned {(Number.isFinite(Number(v.similarity)) ? Number(v.similarity).toFixed(4) : '0.0000')})</span>
                      )}
                      <button type="button" onClick={()=>navigator.clipboard?.writeText(String(v.id))} className="ml-1 underline text-[10px]">Copy</button>
                      {devtools && typeof v.similarity === 'number' && (
                        <span className="ml-1 text-[11px] text-zinc-500">({v.similarity.toFixed(4)})</span>
                      )}
                    </span>
                  )
                })}
              </div>
              {open[id] && (
                <div className="mt-2 whitespace-pre-wrap leading-relaxed">{c.combined_text}</div>
              )}
            </div>
          </li>
        )
      })}
    </ul>
  )
}
