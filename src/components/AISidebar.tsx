"use client"
import { useEffect, useState } from 'react'
import { useAppendToReaderFlexible } from '@/lib/readerNav'

export function AISidebar({ open, onClose }:{ open:boolean; onClose:()=>void }){
  // Persist open state optionally (default closed)
  useEffect(()=>{
    try { localStorage.setItem('sl_aiSidebarOpen', open ? '1' : '0') } catch {}
  },[open])

  return (
    <>
      {/* Backdrop */}
      <div
        className={`fixed inset-0 z-40 bg-black/30 transition-opacity ${open ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}`}
        onClick={onClose}
      />
      {/* Panel */}
      <div className={`fixed top-0 right-0 h-full w-full sm:w-[520px] z-50 bg-white dark:bg-zinc-950 border-l border-zinc-200 dark:border-zinc-800 transition-transform ${open ? 'translate-x-0' : 'translate-x-full'}`}>
        <div className="h-full flex flex-col">
          <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-800 flex items-center justify-between">
            <div className="font-medium">Search Tools</div>
            <button className="text-sm underline" onClick={onClose}>Close</button>
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            <LexicalSearchCard />
            <ConceptHybridSearchCard />
          </div>
        </div>
      </div>
    </>
  )
}

function LexicalSearchCard() {
  const appendToReader = useAppendToReaderFlexible()
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<'verses' | 'chapters'>('verses')
  const [topK, setTopK] = useState(20)
  const [minSimilarity, setMinSimilarity] = useState(0.2)
  const [exactWord, setExactWord] = useState<boolean>(false)
  const [workId, setWorkId] = useState('')
  const [bookId, setBookId] = useState('')
  const [rangeStart, setRangeStart] = useState('')
  const [rangeEnd, setRangeEnd] = useState('')
  const [rangeError, setRangeError] = useState('')
  const [works, setWorks] = useState<any[]>([])
  const [books, setBooks] = useState<any[]>([])
  const [results, setResults] = useState<any[]>([])
  const [busy, setBusy] = useState(false)

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
      const payload:any = { query, topK, mode, minSimilarity, exactWord }
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
      <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3 items-start">
        <div className="col-span-1 sm:col-span-2">
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
          <input type="range" min={0} max={1} step={0.05} value={minSimilarity} onChange={e=>setMinSimilarity(Number(e.target.value))} />
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-zinc-600 dark:text-zinc-400">Exact word match</label>
          <input type="checkbox" checked={exactWord} onChange={e=>setExactWord(e.target.checked)} />
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
                      <button type="button" className="underline" onClick={() => appendToReader({ chapterId: String(r.chapter_id) }, [String(r.id)])}>Open</button>
                    )}
                    {mode === 'chapters' && (
                      <button type="button" className="underline" onClick={() => appendToReader({ chapterId: String(r.id) })}>Open</button>
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

function ConceptHybridSearchCard() {
  return <AskQuestionCard />
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
  const [hybrid, setHybrid] = useState<boolean>(false)
  const [pinVerseId, setPinVerseId] = useState<string>('')
  const [lexicalWeight, setLexicalWeight] = useState<number>(0.15)

  useEffect(() => { fetch('/api/catalog/works').then(r=>r.json()).then(j=>setWorks(j.works||[])) }, [])
  useEffect(() => {
    if (typeof window === 'undefined') return
    const savedHybrid = localStorage.getItem('sl_hybrid')
    if (savedHybrid) setHybrid(savedHybrid === '1')
  }, [])
  useEffect(() => { if(typeof window!=='undefined') localStorage.setItem('sl_hybrid', hybrid?'1':'0') }, [hybrid])
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
      <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3 items-start">
        <div className="col-span-1 sm:col-span-2">
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
        {showMore && (
          <div className="col-span-1 sm:col-span-2 grid grid-cols-1 sm:grid-cols-2 gap-3 order-last">
            <div className="flex items-center gap-2">
              <label className="text-xs text-zinc-600 dark:text-zinc-400">Devtools</label>
              <input type="checkbox" checked={devtools} onChange={e=>setDevtools(e.target.checked)} />
            </div>
          </div>
        )}
        <div className="col-span-1 sm:col-span-2 flex justify-end">
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
      {data?.overview && (
        <p className="mt-3 text-sm italic">{data.overview}</p>
      )}
      {data?.chunks && (
        <ChunkCards books={books} chunks={data.chunks} devtools={devtools} pinVerseId={pinVerseId} />)
      }
    </div>
  )
}

function ChunkCards({ books, chunks, devtools, pinVerseId }:{ books:any[]; chunks:any[]; devtools:boolean; pinVerseId:string }){
  const appendToReader = useAppendToReaderFlexible()
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
        const highlightIds = c.verses.map((v:any)=>String(v.id)).filter(Boolean)
        const chapterSeq = c.verses[0]?.chapter_seq || c.chunk.start_chapter || 1
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
                <button type="button" className="underline" onClick={() => appendToReader({ bookId: String(c.chunk.book_id), chapterSeq: Number(chapterSeq) }, highlightIds)}>Open</button>
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
