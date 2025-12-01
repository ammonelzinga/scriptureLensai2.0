"use client"
import { create } from 'zustand'

export type ReaderState = {
  leftChapterId?: string
  rightChapterId?: string
  highlightVerseIds: string[]
  showVerseDetails: boolean
  // Simple in-memory cache for chapters and verses to avoid refetches between navigations
  chapterCache: Record<string, { chapter: any; verses: any[] }>
  setLeft: (id?: string) => void
  setRight: (id?: string) => void
  setHighlights: (ids: string[]) => void
  toggleVerseDetails: () => void
  cacheChapter: (id: string, chapter: any, verses: any[]) => void
  getCachedChapter: (id: string) => { chapter: any; verses: any[] } | undefined
}

export const useReaderStore = create<ReaderState>((set, get) => ({
  leftChapterId: undefined,
  rightChapterId: undefined,
  highlightVerseIds: [],
  showVerseDetails: typeof window !== 'undefined' ? localStorage.getItem('sl_showVerseDetails') === '1' : false,
  chapterCache: {},
  setLeft: (id) => set({ leftChapterId: id }),
  setRight: (id) => set({ rightChapterId: id }),
  setHighlights: (ids) => set({ highlightVerseIds: ids }),
  toggleVerseDetails: () => set(s => {
    const next = !s.showVerseDetails
    if (typeof window !== 'undefined') localStorage.setItem('sl_showVerseDetails', next ? '1' : '0')
    return { showVerseDetails: next }
  }),
  cacheChapter: (id, chapter, verses) => set(s => ({ chapterCache: { ...s.chapterCache, [id]: { chapter, verses } } })),
  getCachedChapter: (id) => get().chapterCache[id]
}))
