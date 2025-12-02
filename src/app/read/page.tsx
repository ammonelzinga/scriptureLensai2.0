"use client"
import { NavigationTree } from '@/components/NavigationTree'
import { ReaderStack } from '@/components/ReaderStack'
import { useReaderStore } from '@/store/reader'
import type { ReaderState } from '@/store/reader'
import { useEffect, useRef, useState } from 'react'
import { AISidebar } from '@/components/AISidebar'

export default function ReadPage() {
  const [aiOpen, setAiOpen] = useState(false)
  const [leftCollapsed, setLeftCollapsed] = useState(false)
  const [controlsOpen, setControlsOpen] = useState(false) // sidebar options card collapsed by default
  const [contentWidth, setContentWidth] = useState<number>(typeof window !== 'undefined' ? window.innerWidth : 0)
  const addChapterToPane = useReaderStore((s: ReaderState) => s.addChapterToPane)
  const addChapterToNextPane = useReaderStore((s: ReaderState) => s.addChapterToNextPane)
  const addPane = useReaderStore((s: ReaderState) => s.addPane)
  const panes = useReaderStore((s: ReaderState) => s.panes)
  const setHighlights = useReaderStore((s: ReaderState) => s.setHighlights)
  const showVerseDetails = useReaderStore((s: ReaderState) => s.showVerseDetails)
  const toggleVerseDetails = useReaderStore((s: ReaderState) => s.toggleVerseDetails)
  const suggestionsToAdd = useReaderStore((s: ReaderState) => s.suggestionsToAdd)
  const setSuggestionsToAdd = useReaderStore((s: ReaderState) => s.setSuggestionsToAdd)
  const excludeSameChapter = useReaderStore((s: ReaderState) => s.excludeSameChapter)
  const excludeSameBook = useReaderStore((s: ReaderState) => s.excludeSameBook)
  const excludeSameWork = useReaderStore((s: ReaderState) => s.excludeSameWork)
  const setExcludeSameChapter = useReaderStore((s: ReaderState) => s.setExcludeSameChapter)
  const setExcludeSameBook = useReaderStore((s: ReaderState) => s.setExcludeSameBook)
  const setExcludeSameWork = useReaderStore((s: ReaderState) => s.setExcludeSameWork)
  useEffect(() => {
    if (typeof window === 'undefined') return
    // restore sidebar open state (default closed)
    try {
      const saved = localStorage.getItem('sl_aiSidebarOpen')
      if (saved) setAiOpen(saved === '1')
      const collapsed = localStorage.getItem('sl_leftCollapsed')
      if (collapsed) setLeftCollapsed(collapsed === '1')
      const optOpen = localStorage.getItem('sl_sidebarControlsOpen')
      if (optOpen) setControlsOpen(optOpen === '1')
    } catch {}
    const params = new URLSearchParams(window.location.search)
    const chapterLeft = params.get('chapterId') || params.get('left')
    const chapterRight = params.get('right')
    const highlight = params.get('highlight')
    if (chapterLeft) addChapterToPane(0, chapterLeft)
    if (chapterRight) addChapterToPane(1, chapterRight)
    if (highlight) setHighlights(highlight.split(',').filter(Boolean))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const asideRef = useRef<HTMLDivElement|null>(null)
  const contentRef = useRef<HTMLDivElement|null>(null)

  const onGridWheel: React.WheelEventHandler<HTMLDivElement> = (e) => {
    const target = e.target as Node
    const insideAside = asideRef.current?.contains(target)
    const paneEl = (target as HTMLElement).closest?.('[data-pane-scroll]')
    // If scrolling outside all reader panes and aside, sync-scroll all panes
    if (!insideAside && !paneEl) {
      const nodes = document.querySelectorAll('[data-pane-scroll]')
      nodes.forEach(n => (n as HTMLElement).scrollBy({ top: e.deltaY }))
      e.preventDefault()
    }
  }

  // measure content width
  useEffect(() => {
    if (!contentRef.current) return
    const el = contentRef.current
    const ro = new ResizeObserver(() => {
      setContentWidth(el.clientWidth)
    })
    ro.observe(el)
    setContentWidth(el.clientWidth)
    return () => { ro.disconnect() }
  }, [contentRef.current, leftCollapsed, panes.length])

  // Fixed constraints: max 3 panes, no horizontal scroll; add button only if panes < 3
  const maxPanes = 3
  const canAddPanel = panes.length < maxPanes

  return (
    <div className="relative left-[calc(-50vw+50%)] w-screen px-4 sm:px-6" onWheel={onGridWheel}>
      {/* Layout: flex row full width */}
      <div className="flex gap-4">
        {/* True left sidebar */}
        <aside
          ref={asideRef}
          className={`sticky top-6 h-[calc(100vh-6rem)] ${leftCollapsed ? 'w-9' : 'w-[260px]'} flex-shrink-0 border border-zinc-200 dark:border-zinc-800 rounded-lg overflow-y-auto no-scrollbar bg-white dark:bg-zinc-950`}
        >
          {leftCollapsed ? (
            <div className="h-full flex flex-col items-center py-2">
              <button
                aria-label="Expand sidebar"
                title="Expand"
                onClick={() => { const next=false; setLeftCollapsed(next); try { localStorage.setItem('sl_leftCollapsed','0') } catch {} }}
                className="text-lg px-1 py-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-900"
              >
                ➤
              </button>
            </div>
          ) : (
            <div className="p-3 flex flex-col h-full">
              <div className="flex items-center justify-between mb-2">
                <h2 className="font-medium">Scriptures</h2>
                <button
                  aria-label="Collapse sidebar"
                  title="Collapse"
                  onClick={() => { const next=true; setLeftCollapsed(next); try { localStorage.setItem('sl_leftCollapsed','1') } catch {} }}
                  className="text-lg px-2 py-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-900"
                >
                  ←
                </button>
              </div>
              <div className="mb-3">
                <button
                  type="button"
                  onClick={() => { const next = !controlsOpen; setControlsOpen(next); try { localStorage.setItem('sl_sidebarControlsOpen', next ? '1':'0') } catch {} }}
                  className="w-full flex items-center justify-between text-xs font-medium px-2 py-1 rounded border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 hover:bg-zinc-50 dark:hover:bg-zinc-800"
                  aria-expanded={controlsOpen}
                  aria-controls="sidebar-options-card"
                >
                  <span>Options</span>
                  <span className="text-[10px]">{controlsOpen ? '▾' : '▸'}</span>
                </button>
                {controlsOpen && (
                  <div
                    id="sidebar-options-card"
                    className="mt-2 border border-zinc-200 dark:border-zinc-800 rounded-lg p-3 bg-zinc-50 dark:bg-zinc-900 space-y-3 text-xs"
                    data-droppable-card
                  >
                    <div className="flex items-center gap-2">
                      <label className="flex items-center gap-2">
                        <input type="checkbox" checked={showVerseDetails} onChange={toggleVerseDetails} />
                        Show verse details
                      </label>
                      {showVerseDetails && <span className="text-[10px] text-zinc-500">IDs selectable</span>}
                    </div>
                    <div className="flex items-center gap-2">
                      <label htmlFor="suggestions-count" className="text-zinc-600 dark:text-zinc-300">Passages to add:</label>
                      <select
                        id="suggestions-count"
                        className="border rounded px-2 py-1 bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800"
                        value={suggestionsToAdd}
                        onChange={(e)=> setSuggestionsToAdd(Number(e.target.value))}
                      >
                        {Array.from({ length: 10 }, (_,i)=> i+1).map(n => (
                          <option key={n} value={n}>{n}</option>
                        ))}
                      </select>
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="flex items-center gap-2">
                        <input type="checkbox" checked={excludeSameChapter} onChange={(e)=> setExcludeSameChapter(e.target.checked)} />
                        Exclude same chapter
                      </label>
                      <label className="flex items-center gap-2">
                        <input type="checkbox" checked={excludeSameBook} onChange={(e)=> setExcludeSameBook(e.target.checked)} />
                        Exclude same book
                      </label>
                      <label className="flex items-center gap-2">
                        <input type="checkbox" checked={excludeSameWork} onChange={(e)=> setExcludeSameWork(e.target.checked)} />
                        Exclude same work
                      </label>
                    </div>
                  </div>
                )}
              </div>
              <div className="flex-1 overflow-y-auto no-scrollbar">
                <NavigationTree onSelectChapter={(id) => { addChapterToNextPane(id) }} />
              </div>
            </div>
          )}
        </aside>
        {/* Panels content area */}
        <section ref={contentRef} className="flex-1 relative">
          {/* Action bar: + Panel (small) left of Search Tools */}
          <div className="absolute -top-4 right-0 flex items-center gap-2">
            {canAddPanel && (
              <button
                type="button"
                onClick={() => addPane()}
                className="border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 rounded px-2 py-1 text-[11px] leading-none hover:bg-zinc-50 dark:hover:bg-zinc-800 shadow-sm"
                aria-label="Add panel"
                title="Add panel"
              >+ Panel</button>
            )}
            <button
              type="button"
              onClick={() => { setAiOpen(true); try { localStorage.setItem('sl_aiSidebarOpen','1') } catch {} }}
              className="rounded-md bg-primary text-primary-foreground shadow px-3 py-2 text-xs"
              aria-label="Open Search Tools Sidebar"
              title="Search Tools"
            >Search Tools</button>
          </div>
          <div className="mt-6 flex gap-6 items-start">
            {panes.map((_, idx) => (
              <div key={idx} data-pane-scroll className="flex-1 max-h-[calc(100vh-6rem)] overflow-y-auto no-scrollbar">
                <ReaderStack paneIndex={idx} />
              </div>
            ))}
          </div>
        </section>
      </div>
      {/* AI Sidebar overlay */}
      <AISidebar open={aiOpen} onClose={() => { setAiOpen(false); try { localStorage.setItem('sl_aiSidebarOpen','0') } catch {} }} />
    </div>
  )
}
