"use client"
import { useEffect, useState } from 'react'
import { supabaseBrowser } from '@/lib/supabase'
import { useReaderStore } from '@/store/reader'
import type { ReaderState } from '@/store/reader'

type VerseRow = { id: string; book_id: string; chapter_seq: number; verse_seq: number; text: string; chunk_id: string }
type ChapterRow = { id: string; title: string | null; seq: number; book_id: string }

export function ScripturePane({ side }: { side: 'left' | 'right' }) {
  const chapterId = useReaderStore((s: ReaderState) => side === 'left' ? s.leftChapterId : s.rightChapterId)
  const highlights = useReaderStore((s: ReaderState) => s.highlightVerseIds)
  const showDetails = useReaderStore((s: ReaderState) => s.showVerseDetails)
  const cacheChapter = useReaderStore((s: ReaderState) => s.cacheChapter)
  const getCachedChapter = useReaderStore((s: ReaderState) => s.getCachedChapter)
  const [chapter, setChapter] = useState<ChapterRow | null>(null)
  const [verses, setVerses] = useState<VerseRow[]>([])

  useEffect(() => {
    if (!chapterId) { setChapter(null); setVerses([]); return }
    // Try cache first to avoid refetching on navigation back to /read
    const cached = getCachedChapter(chapterId)
    if (cached) {
      setChapter(cached.chapter)
      setVerses(cached.verses as any)
      return
    }
    const sb = supabaseBrowser()
    sb.from('chapters').select('id, title, seq, book_id').eq('id', chapterId).single().then(({ data }) => {
      setChapter(data as any)
      if (data) {
        const ch = data as ChapterRow
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
  }, [chapterId])

  const findRelated = async (verseId: string) => {
    try {
      const res = await fetch('/api/search/similar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verseId, topK: 10 })
      })
      const json = await res.json()
      // highlight suggested verses on the other pane
      useReaderStore.getState().setHighlights(json?.relevantVerseIds || [])
    } catch (e) {
      console.error(e)
    }
  }

  if (!chapter) return <div className="text-sm text-zinc-500">Select a chapter…</div>
  return (
    <div>
      <h3 className="font-semibold mb-3">{chapter.title || `Chapter ${chapter.seq}`}</h3>
      <div className="space-y-3">
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
    </div>
  )
}
