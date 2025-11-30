"use client"
import { NavigationTree } from '@/components/NavigationTree'
import { ScripturePane } from '@/components/ScripturePane'
import { useReaderStore } from '@/store/reader'
import { useEffect } from 'react'

export default function ReadPage() {
  const setLeft = useReaderStore(s => s.setLeft)
  const setRight = useReaderStore(s => s.setRight)
  const setHighlights = useReaderStore(s => s.setHighlights)
  const showVerseDetails = useReaderStore(s => s.showVerseDetails)
  const toggleVerseDetails = useReaderStore(s => s.toggleVerseDetails)
  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    const chapterLeft = params.get('chapterId') || params.get('left')
    const chapterRight = params.get('right')
    const highlight = params.get('highlight')
    if (chapterLeft) setLeft(chapterLeft)
    if (chapterRight) setRight(chapterRight)
    if (highlight) setHighlights(highlight.split(',').filter(Boolean))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
      <aside className="lg:col-span-3 border border-zinc-200 dark:border-zinc-800 rounded-lg p-3">
        <h2 className="font-medium mb-2">Scriptures</h2>
        <div className="mb-3 flex items-center gap-2">
          <button onClick={toggleVerseDetails} className="text-xs underline">
            {showVerseDetails ? 'Hide Verse Details' : 'Show Verse Details'}
          </button>
          {showVerseDetails && <span className="text-[10px] text-zinc-500">IDs selectable</span>}
        </div>
        <NavigationTree onSelectChapter={(id) => {
          const state = useReaderStore.getState()
          if (!state.leftChapterId) setLeft(id)
          else setRight(id)
        }} />
      </aside>
      <section className="lg:col-span-9 grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="border border-zinc-200 dark:border-zinc-800 rounded-lg p-4">
          <div className="flex items-center justify-between mb-2">
            <h2 className="font-medium">Left Pane</h2>
            <button className="text-xs underline" onClick={()=>setLeft(undefined)}>Clear</button>
          </div>
          <ScripturePane side="left" />
        </div>
        <div className="border border-zinc-200 dark:border-zinc-800 rounded-lg p-4">
          <div className="flex items-center justify-between mb-2">
            <h2 className="font-medium">Right Pane</h2>
            <button className="text-xs underline" onClick={()=>setRight(undefined)}>Clear</button>
          </div>
          <ScripturePane side="right" />
        </div>
      </section>
    </div>
  )
}
