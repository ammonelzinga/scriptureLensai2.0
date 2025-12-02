"use client"
import { create } from 'zustand'

export type ReaderCard =
  | { key: string; type: 'chapter'; chapterId: string; collapsed: boolean }
  | { key: string; type: 'suggestions'; forVerseId: string; data: any; collapsed: boolean }

export type ReaderState = {
  panes: ReaderCard[][]
  lastPane: number
  highlightVerseIds: string[]
  showVerseDetails: boolean
  suggestionsToAdd: number
  excludeSameChapter: boolean
  excludeSameBook: boolean
  excludeSameWork: boolean
  // Simple in-memory cache for chapters and verses to avoid refetches between navigations
  chapterCache: Record<string, { chapter: any; verses: any[] }>
  // Actions
  addPane: () => number
  removePane: (paneIndex: number) => void
  addChapterToNextPane: (chapterId: string) => void
  addChapterToPane: (paneIndex: number, chapterId: string) => void
  clearPane: (paneIndex: number) => void
  closeCard: (paneIndex: number, key: string) => void
  toggleCollapse: (paneIndex: number, key: string) => void
  moveCard: (fromPane: number, toPane: number, key: string) => void
  reorderCard: (paneIndex: number, key: string, beforeKey?: string) => void
  appendSuggestionsBelow: (paneIndex: number, forVerseId: string, data: any) => void
  setHighlights: (ids: string[]) => void
  toggleVerseDetails: () => void
  setSuggestionsToAdd: (n: number) => void
  setExcludeSameChapter: (v: boolean) => void
  setExcludeSameBook: (v: boolean) => void
  setExcludeSameWork: (v: boolean) => void
  cacheChapter: (id: string, chapter: any, verses: any[]) => void
  getCachedChapter: (id: string) => { chapter: any; verses: any[] } | undefined
}

export const useReaderStore = create<ReaderState>((set, get) => ({
  panes: (() => {
    if (typeof window === 'undefined') return [[], []]
    try {
      const raw = localStorage.getItem('sl_reader_panes')
      if (raw) {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) {
          return parsed as ReaderCard[][]
        }
        // migrate from { left, right }
        if (parsed && typeof parsed === 'object' && 'left' in parsed && 'right' in parsed) {
          const next = [Array.isArray(parsed.left) ? parsed.left : [], Array.isArray(parsed.right) ? parsed.right : []]
          try { localStorage.setItem('sl_reader_panes', JSON.stringify(next)) } catch {}
          return next
        }
      }
    } catch {}
    return [[], []]
  })(),
  lastPane: 1,
  highlightVerseIds: [],
  showVerseDetails: typeof window !== 'undefined' ? localStorage.getItem('sl_showVerseDetails') === '1' : false,
  suggestionsToAdd: (() => {
    if (typeof window === 'undefined') return 2
    const v = Number(localStorage.getItem('sl_suggestionsToAdd') || '2')
    if (!Number.isFinite(v)) return 2
    return Math.min(10, Math.max(1, Math.floor(v)))
  })(),
  excludeSameChapter: typeof window !== 'undefined' ? localStorage.getItem('sl_excludeSameChapter') !== '0' : true,
  excludeSameBook: typeof window !== 'undefined' ? localStorage.getItem('sl_excludeSameBook') === '1' : false,
  excludeSameWork: typeof window !== 'undefined' ? localStorage.getItem('sl_excludeSameWork') === '1' : false,
  chapterCache: {},
  addPane: () => {
    let newIndex = -1
    set(s => {
      const panes = [...s.panes.map(p => p.map(c => ({ ...c, collapsed: true }))), []]
      newIndex = panes.length - 1
      if (typeof window !== 'undefined') localStorage.setItem('sl_reader_panes', JSON.stringify(panes))
      return { panes, lastPane: newIndex }
    })
    return newIndex
  },
  removePane: (paneIndex) => set(s => {
    if (s.panes.length <= 1) return {}
    const target = Math.max(0, Math.min(paneIndex, s.panes.length - 1))
    const panes = s.panes.filter((_, idx) => idx !== target)
    const lastPane = Math.min(s.lastPane, panes.length - 1)
    if (typeof window !== 'undefined') localStorage.setItem('sl_reader_panes', JSON.stringify(panes))
    return { panes, lastPane }
  }),
  addChapterToNextPane: (chapterId: string) => set(s => {
    const card: ReaderCard = { key: `chapter:${chapterId}:${Date.now()}` , type: 'chapter', chapterId, collapsed: true }
    const panes = s.panes.length === 0 ? [[], []] : s.panes
    const nextPane = (s.lastPane + 1) % panes.length
    const collapsedExisting = panes[nextPane].map(c => ({ ...c, collapsed: true }))
    const newPanes = panes.map((p, idx) => idx === nextPane ? [...collapsedExisting, card] : p.map(c => ({ ...c, collapsed: true })))
    if (typeof window !== 'undefined') localStorage.setItem('sl_reader_panes', JSON.stringify(newPanes))
    return { panes: newPanes, lastPane: nextPane }
  }),
  addChapterToPane: (paneIndex, chapterId) => set(s => {
    const card: ReaderCard = { key: `chapter:${chapterId}:${Date.now()}`, type: 'chapter', chapterId, collapsed: true }
    let panes = s.panes.length === 0 ? [[], []] : s.panes
    if (paneIndex >= panes.length) {
      const toAdd = paneIndex - panes.length + 1
      panes = [...panes.map(p => p), ...Array.from({ length: toAdd }, () => [])]
    }
    const target = Math.max(0, Math.min(paneIndex, panes.length - 1))
    const collapsedExisting = panes[target].map(c => ({ ...c, collapsed: true }))
    const newPanes = panes.map((p, idx) => idx === target ? [...collapsedExisting, card] : p.map(c => ({ ...c, collapsed: true })))
    if (typeof window !== 'undefined') localStorage.setItem('sl_reader_panes', JSON.stringify(newPanes))
    return { panes: newPanes, lastPane: target }
  }),
  clearPane: (paneIndex) => set(s => {
    const panes = s.panes.map((p, idx) => idx === paneIndex ? [] : p)
    if (typeof window !== 'undefined') localStorage.setItem('sl_reader_panes', JSON.stringify(panes))
    return { panes }
  }),
  closeCard: (paneIndex, key) => set(s => {
    const panes = s.panes.map((p, idx) => idx === paneIndex ? p.filter(c => c.key !== key) : p)
    if (typeof window !== 'undefined') localStorage.setItem('sl_reader_panes', JSON.stringify(panes))
    return { panes }
  }),
  toggleCollapse: (paneIndex, key) => set(s => {
    const panes = s.panes.map((p, idx) => idx === paneIndex ? p.map(c => c.key === key ? { ...c, collapsed: !c.collapsed } : c) : p)
    if (typeof window !== 'undefined') localStorage.setItem('sl_reader_panes', JSON.stringify(panes))
    return { panes }
  }),
  moveCard: (fromPane, toPane, key) => set(s => {
    if (fromPane === toPane) return {}
    const panes = s.panes.length === 0 ? [[], []] : s.panes
    const src = panes[fromPane] || []
    const dst = panes[toPane] || []
    const idx = src.findIndex(c => c.key === key)
    if (idx === -1) return {}
    const card = src[idx]
    const newSrc = [...src.slice(0, idx), ...src.slice(idx+1)]
    const collapsedDst = dst.map(c => ({ ...c, collapsed: true }))
    const newDst = [...collapsedDst, { ...card, collapsed: true }]
    const newPanes = panes.map((p, i) => i === fromPane ? newSrc : (i === toPane ? newDst : p.map(c => ({ ...c, collapsed: true }))))
    if (typeof window !== 'undefined') localStorage.setItem('sl_reader_panes', JSON.stringify(newPanes))
    return { panes: newPanes, lastPane: toPane }
  }),
  reorderCard: (paneIndex, key, beforeKey) => set(s => {
    const list = s.panes[paneIndex] || []
    const fromIdx = list.findIndex(c => c.key === key)
    if (fromIdx === -1) return {}
    const card = list[fromIdx]
    let newList = [...list.slice(0, fromIdx), ...list.slice(fromIdx+1)]
    let toIdx = typeof beforeKey === 'string' ? newList.findIndex(c => c.key === beforeKey) : -1
    if (toIdx < 0) newList = [...newList, { ...card }]
    else newList = [...newList.slice(0, toIdx), { ...card }, ...newList.slice(toIdx)]
    const panes = s.panes.map((p, idx) => idx === paneIndex ? newList : p)
    if (typeof window !== 'undefined') localStorage.setItem('sl_reader_panes', JSON.stringify(panes))
    return { panes }
  }),
  appendSuggestionsBelow: (paneIndex, forVerseId, data) => set(s => {
    const card: ReaderCard = { key: `sugg:${forVerseId}:${Date.now()}`, type: 'suggestions', forVerseId, data, collapsed: true }
    const panes = s.panes.length === 0 ? [[], []] : s.panes
    const collapsedExisting = panes[paneIndex]?.map(c => ({ ...c, collapsed: true })) || []
    const newPanes = panes.map((p, idx) => idx === paneIndex ? [...collapsedExisting, card] : p.map(c => ({ ...c, collapsed: true })))
    if (typeof window !== 'undefined') localStorage.setItem('sl_reader_panes', JSON.stringify(newPanes))
    return { panes: newPanes }
  }),
  setHighlights: (ids) => set({ highlightVerseIds: ids }),
  toggleVerseDetails: () => set(s => {
    const next = !s.showVerseDetails
    if (typeof window !== 'undefined') localStorage.setItem('sl_showVerseDetails', next ? '1' : '0')
    return { showVerseDetails: next }
  }),
  setSuggestionsToAdd: (n: number) => set(() => {
    const clamped = Math.min(10, Math.max(1, Math.floor(n)))
    if (typeof window !== 'undefined') localStorage.setItem('sl_suggestionsToAdd', String(clamped))
    return { suggestionsToAdd: clamped }
  }),
  setExcludeSameChapter: (v: boolean) => set(() => {
    if (typeof window !== 'undefined') localStorage.setItem('sl_excludeSameChapter', v ? '1' : '0')
    return { excludeSameChapter: v }
  }),
  setExcludeSameBook: (v: boolean) => set(() => {
    if (typeof window !== 'undefined') localStorage.setItem('sl_excludeSameBook', v ? '1' : '0')
    return { excludeSameBook: v }
  }),
  setExcludeSameWork: (v: boolean) => set(() => {
    if (typeof window !== 'undefined') localStorage.setItem('sl_excludeSameWork', v ? '1' : '0')
    return { excludeSameWork: v }
  }),
  cacheChapter: (id, chapter, verses) => set(s => ({ chapterCache: { ...s.chapterCache, [id]: { chapter, verses } } })),
  getCachedChapter: (id) => get().chapterCache[id]
}))
