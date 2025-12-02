"use client"
import { useEffect, useMemo, useState } from 'react'
import { supabaseBrowser } from '@/lib/supabase'
import { useReaderStore } from '@/store/reader'
import type { ReaderCard, ReaderState } from '@/store/reader'

type VerseRow = { id: string; book_id: string; chapter_seq: number; verse_seq: number; text: string; chunk_id: string }
type ChapterRow = { id: string; title: string | null; seq: number; book_id: string }

type StackProps = { paneIndex: number }

export function ReaderStack({ paneIndex }: StackProps){
  const cards = useReaderStore((s: ReaderState) => s.panes[paneIndex])
  const clearPane = useReaderStore((s: ReaderState) => s.clearPane)
  const removePane = useReaderStore((s: ReaderState) => s.removePane)
  const moveCard = useReaderStore((s: ReaderState) => s.moveCard)
  const reorderCard = useReaderStore((s: ReaderState) => s.reorderCard)
  const [hover, setHover] = useState(false)
  const paneCount = useReaderStore((s: ReaderState) => s.panes.length)

  const onDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('application/x-reader-card')) e.preventDefault()
  }
  const onDrop = (e: React.DragEvent) => {
    const raw = e.dataTransfer.getData('application/x-reader-card')
    if (!raw) return
    try {
      const payload = JSON.parse(raw) as { key: string; paneIndex: number }
      if (payload.paneIndex !== paneIndex) moveCard(payload.paneIndex, paneIndex, payload.key)
      else reorderCard(paneIndex, payload.key)
    } catch {}
    setHover(false)
  }
  const onDragEnter = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('application/x-reader-card')) setHover(true)
  }
  const onDragLeave = () => setHover(false)

  return (
    <div className={`border rounded-lg p-4 ${hover ? 'border-primary ring-2 ring-primary/20 dark:ring-primary/30' : 'border-zinc-200 dark:border-zinc-800'}`} onDragOver={onDragOver} onDrop={onDrop} onDragEnter={onDragEnter} onDragLeave={onDragLeave}>
      <div className="flex items-center justify-between mb-2">
        <h2 className="font-medium">Pane {paneIndex + 1}</h2>
        <div className="flex items-center gap-2">
          <button className="text-xs px-2 py-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-900" onClick={()=>clearPane(paneIndex)}>Clear</button>
          {paneCount > 1 && (
            <button
              className="text-xs px-2 py-1 rounded hover:bg-red-50 dark:hover:bg-red-950 text-red-600"
              title="Remove this pane"
              aria-label="Remove pane"
              onClick={()=>removePane(paneIndex)}
            >✕</button>
          )}
        </div>
      </div>
      <div className="space-y-3">
        {cards.length === 0 ? (
          <div className="text-sm text-zinc-500">Select chapters from the left to add cards…</div>
        ) : (
          cards.map(c => (
            c.type === 'chapter' ? <ChapterCard key={c.key} paneIndex={paneIndex} card={c} /> : <SuggestionsCard key={c.key} paneIndex={paneIndex} card={c} />
          ))
        )}
      </div>
    </div>
  )
}


function ChapterCard({ paneIndex, card }: { paneIndex: number; card: Extract<ReaderCard,{type:'chapter'}> }){
  const highlights = useReaderStore((s: ReaderState) => s.highlightVerseIds)
  const showDetails = useReaderStore((s: ReaderState) => s.showVerseDetails)
  const cacheChapter = useReaderStore((s: ReaderState) => s.cacheChapter)
  const getCachedChapter = useReaderStore((s: ReaderState) => s.getCachedChapter)
  const toggleCollapse = useReaderStore((s: ReaderState) => s.toggleCollapse)
  const closeCard = useReaderStore((s: ReaderState) => s.closeCard)
  const appendSuggestions = useReaderStore((s: ReaderState) => s.appendSuggestionsBelow)
  const suggestionsToAdd = useReaderStore((s: ReaderState) => s.suggestionsToAdd)
  const excludeSameChapter = useReaderStore((s: ReaderState) => s.excludeSameChapter)
  const excludeSameBook = useReaderStore((s: ReaderState) => s.excludeSameBook)
  const excludeSameWork = useReaderStore((s: ReaderState) => s.excludeSameWork)
  const moveCard = useReaderStore((s: ReaderState) => s.moveCard)
  const reorderCard = useReaderStore((s: ReaderState) => s.reorderCard)
  const [chapter, setChapter] = useState<ChapterRow | null>(null)
  const [verses, setVerses] = useState<VerseRow[]>([])
  const [bookTitle, setBookTitle] = useState<string>('')
  const list = useReaderStore((s: ReaderState) => s.panes[paneIndex])
  const index = useReaderStore((s: ReaderState) => s.panes[paneIndex].findIndex(c => c.key === card.key))

  useEffect(() => {
    const chapterId = card.chapterId
    if (!chapterId) { setChapter(null); setVerses([]); return }
    const cached = getCachedChapter(chapterId)
    if (cached) {
      setChapter(cached.chapter)
      setVerses(cached.verses as any)
      return
    }
    const sb = supabaseBrowser()
    sb.from('chapters').select('id, title, seq, book_id').eq('id', chapterId).single().then(async ({ data }) => {
      setChapter(data as any)
      if (data) {
        const ch = data as ChapterRow
        try {
          const { data: b } = await sb.from('books').select('id,title').eq('id', ch.book_id).maybeSingle()
          if (b?.title) setBookTitle(String(b.title))
        } catch {}
        sb.from('verses')
          .select('id, book_id, chapter_seq, verse_seq, text, chunk_id')
          .eq('book_id', ch.book_id)
          .eq('chapter_seq', ch.seq)
          .order('verse_seq', { ascending: true })
          .then(({ data }) => {
            const list = (data as any) || []
            setVerses(list)
            cacheChapter(chapterId, ch, list)
          })
      } else {
        setVerses([])
      }
    })
  }, [card.chapterId])

  const findRelated = async (verseId: string) => {
    try {
      const res = await fetch('/api/search/similar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verseId, topK: 50, excludeSameChapter, excludeSameBook, excludeSameWork })
      })
      const json = await res.json()
      const limited = {
        ...json,
        suggestions: Array.isArray(json?.suggestions)
          ? json.suggestions.slice(0, suggestionsToAdd)
          : []
      }
      appendSuggestions(paneIndex, verseId, limited)
    } catch (e) {
      console.error(e)
    }
  }

  const onDragStart = (e: React.DragEvent) => {
    if (!card.collapsed) return
    e.dataTransfer.setData('application/x-reader-card', JSON.stringify({ key: card.key, paneIndex }))
    e.dataTransfer.effectAllowed = 'move'
  }

  const [dragPos, setDragPos] = useState<null | 'above' | 'below'>(null)
  const onDragOverCard = (e: React.DragEvent) => {
    if (!card.collapsed) return
    if (e.dataTransfer.types.includes('application/x-reader-card')) {
      e.preventDefault()
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
      const y = e.clientY - rect.top
      setDragPos(y < rect.height / 2 ? 'above' : 'below')
    }
  }
  const onDragLeaveCard = () => setDragPos(null)
  const onDropCard = (e: React.DragEvent) => {
    if (!card.collapsed) return
    const raw = e.dataTransfer.getData('application/x-reader-card')
    if (!raw) return
    try {
      const payload = JSON.parse(raw) as { key: string; paneIndex: number }
      const nextKey = list[index+1]?.key
      const beforeKey = dragPos === 'above' ? card.key : nextKey
      if (payload.paneIndex !== paneIndex) {
        moveCard(payload.paneIndex, paneIndex, payload.key)
        if (beforeKey) reorderCard(paneIndex, payload.key, beforeKey)
      } else if (payload.key !== card.key) {
        reorderCard(paneIndex, payload.key, beforeKey)
      }
    } catch {}
    setDragPos(null)
  }
  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800" draggable={card.collapsed} onDragStart={onDragStart} onDragOver={onDragOverCard} onDragLeave={onDragLeaveCard} onDrop={onDropCard}>
      {dragPos === 'above' && <div className="h-1 -mt-1 rounded-t bg-primary/30" />}
      <div className="p-2 flex items-center justify-between">
        <div
          className="font-semibold cursor-pointer select-none"
          role="button"
          tabIndex={0}
          onClick={()=>toggleCollapse(paneIndex, card.key)}
          onKeyDown={(e)=>{ if(e.key==='Enter' || e.key===' ') toggleCollapse(paneIndex, card.key) }}
        >
          {chapter ? ((bookTitle ? `${bookTitle} — ` : '') + (chapter.title || `Chapter ${chapter.seq}`) || '') : 'Loading…'}
        </div>
        <div className="flex items-center gap-2 text-[10px]">
          <button className="px-2 py-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-900" onClick={(e)=>{ e.stopPropagation(); toggleCollapse(paneIndex, card.key) }}>{card.collapsed ? 'Expand' : 'Collapse'}</button>
          {/* movement controls removed */}
          <button className="px-2 py-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-900" onClick={(e)=>{ e.stopPropagation(); closeCard(paneIndex, card.key) }}>Close</button>
        </div>
      </div>
      {!card.collapsed && (
        <div className="px-2 pb-2 space-y-3">
          {verses.map(v => (
            <div key={v.id} className={`relative rounded-md p-2 border ${highlights.includes(v.id) ? 'border-accent bg-accent/5' : 'border-transparent hover:bg-zinc-50 dark:hover:bg-zinc-900'}`}>
              <div className="flex items-start gap-2">
                <span className="text-xs mt-1 w-5 text-zinc-500">{v.verse_seq}</span>
                <p className="flex-1 leading-relaxed">{v.text}</p>
                <button className="text-xs rounded-md border border-zinc-200 dark:border-zinc-800 px-2 py-1 hover:bg-zinc-50 dark:hover:bg-zinc-900" onClick={() => findRelated(v.id)}>Find Related</button>
              </div>
              {showDetails && (
                <div className="absolute bottom-1 right-2 text-[10px] text-zinc-400 select-all">
                  {v.id}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {dragPos === 'below' && <div className="h-1 rounded-b bg-primary/30" />}
    </div>
  )
}

function SuggestionsCard({ paneIndex, card }: { paneIndex: number; card: Extract<ReaderCard,{type:'suggestions'}> }){
  const closeCard = useReaderStore((s: ReaderState) => s.closeCard)
  const toggleCollapse = useReaderStore((s: ReaderState) => s.toggleCollapse)
  const moveCard = useReaderStore((s: ReaderState) => s.moveCard)
  const reorderCard = useReaderStore((s: ReaderState) => s.reorderCard)
  const [books, setBooks] = useState<any[]>([])
  const list = useReaderStore((s: ReaderState) => s.panes[paneIndex])
  const index = useReaderStore((s: ReaderState) => s.panes[paneIndex].findIndex(c => c.key === card.key))

  const onDragStart = (e: React.DragEvent) => {
    if (!card.collapsed) return
    e.dataTransfer.setData('application/x-reader-card', JSON.stringify({ key: card.key, paneIndex }))
    e.dataTransfer.effectAllowed = 'move'
  }

  useEffect(() => {
    fetch('/api/catalog/books').then(r=>r.json()).then(j=>setBooks(j.books||[])).catch(()=>setBooks([]))
  }, [])

  const [sourceLabel, setSourceLabel] = useState<string>('')
  useEffect(() => {
    const run = async () => {
      try {
        const sb = supabaseBrowser()
        const { data: v } = await sb.from('verses').select('book_id, chapter_seq, verse_seq').eq('id', card.forVerseId).maybeSingle()
        if (v) {
          const b = books.find(bk => bk.id === v.book_id)
          const bookLabel = b ? b.title : 'Book'
          setSourceLabel(`${bookLabel} ${v.chapter_seq}:${v.verse_seq}`)
        }
      } catch {}
    }
    run()
  }, [card.forVerseId, books])

  const title = useMemo(()=> sourceLabel ? `Related passages for ${sourceLabel}` : `Related passages`, [sourceLabel])
  const suggestions: any[] = card.data?.suggestions || []

  const [dragPos, setDragPos] = useState<null | 'above' | 'below'>(null)
  const onDragOverCard = (e: React.DragEvent) => {
    if (!card.collapsed) return
    if (e.dataTransfer.types.includes('application/x-reader-card')) {
      e.preventDefault()
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
      const y = e.clientY - rect.top
      setDragPos(y < rect.height / 2 ? 'above' : 'below')
    }
  }
  const onDragLeaveCard = () => setDragPos(null)
  const onDropCard = (e: React.DragEvent) => {
    if (!card.collapsed) return
    const raw = e.dataTransfer.getData('application/x-reader-card')
    if (!raw) return
    try {
      const payload = JSON.parse(raw) as { key: string; paneIndex: number }
      const nextKey = list[index+1]?.key
      const beforeKey = dragPos === 'above' ? card.key : nextKey
      if (payload.paneIndex !== paneIndex) {
        moveCard(payload.paneIndex, paneIndex, payload.key)
        if (beforeKey) reorderCard(paneIndex, payload.key, beforeKey)
      } else if (payload.key !== card.key) {
        reorderCard(paneIndex, payload.key, beforeKey)
      }
    } catch {}
    setDragPos(null)
  }
  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800" draggable={card.collapsed} onDragStart={onDragStart} onDragOver={onDragOverCard} onDragLeave={onDragLeaveCard} onDrop={onDropCard}>
      {dragPos === 'above' && <div className="h-1 -mt-1 rounded-t bg-primary/30" />}
      <div className="p-2 flex items-center justify-between bg-zinc-50 dark:bg-zinc-900/40 rounded-t-lg">
        <div
          className="font-medium cursor-pointer select-none"
          role="button"
          tabIndex={0}
          onClick={()=>toggleCollapse(paneIndex, card.key)}
          onKeyDown={(e)=>{ if(e.key==='Enter' || e.key===' ') toggleCollapse(paneIndex, card.key) }}
        >{title}</div>
        <div className="flex items-center gap-2 text-[10px]">
          <button className="px-2 py-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-900" onClick={(e)=>{ e.stopPropagation(); toggleCollapse(paneIndex, card.key)}}>{card.collapsed ? 'Expand' : 'Collapse'}</button>
          {/* movement controls removed */}
          <button className="px-2 py-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-900" onClick={(e)=>{ e.stopPropagation(); closeCard(paneIndex, card.key)}}>Close</button>
        </div>
      </div>
      {!card.collapsed && (
        <div className="px-2 pb-2">
          {suggestions.length === 0 ? (
            <div className="text-sm text-zinc-500 p-2">No suggestions.</div>
          ) : (
            <ul className="space-y-2 text-sm">
              {suggestions.map((s:any,i:number)=> {
                const groups = (() => {
                  const by: Record<string, any[]> = {}
                  for (const v of (s.verses || [])) {
                    const key = v?.chunk_id || `verse:${v?.id}`
                    if (!by[key]) by[key] = []
                    by[key].push(v)
                  }
                  return Object.values(by)
                })()
                return (
                  <li key={i} className="rounded-md border border-zinc-200 dark:border-zinc-800 p-2">
                    <div className="font-medium">
                      {(() => {
                        const b = books.find(bk => bk.id === s.chapter.book_id)
                        const bookLabel = b ? b.title : (s.chapter.book_title || 'Book')
                        const chapLabel = s.chapter.seq ? `Chapter ${s.chapter.seq}` : (s.chapter.title || 'Chapter')
                        return `${bookLabel} — ${chapLabel}`
                      })()}
                    </div>
                    <div className="mt-1 space-y-1">
                      {groups.map((g:any[], gi:number)=> (
                        <div key={gi} className="text-zinc-600 dark:text-zinc-400">
                          {g.map((v:any)=>v.text).join('  ')}
                        </div>
                      ))}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
      {dragPos === 'below' && <div className="h-1 rounded-b bg-primary/30" />}
    </div>
  )
}
