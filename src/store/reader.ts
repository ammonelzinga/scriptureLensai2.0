"use client"
import { create } from 'zustand'

type ReaderState = {
  leftChapterId?: string
  rightChapterId?: string
  highlightVerseIds: string[]
  showVerseDetails: boolean
  setLeft: (id?: string) => void
  setRight: (id?: string) => void
  setHighlights: (ids: string[]) => void
  toggleVerseDetails: () => void
}

export const useReaderStore = create<ReaderState>((set) => ({
  leftChapterId: undefined,
  rightChapterId: undefined,
  highlightVerseIds: [],
  showVerseDetails: typeof window !== 'undefined' ? localStorage.getItem('sl_showVerseDetails') === '1' : false,
  setLeft: (id) => set({ leftChapterId: id }),
  setRight: (id) => set({ rightChapterId: id }),
  setHighlights: (ids) => set({ highlightVerseIds: ids }),
  toggleVerseDetails: () => set(s => {
    const next = !s.showVerseDetails
    if (typeof window !== 'undefined') localStorage.setItem('sl_showVerseDetails', next ? '1' : '0')
    return { showVerseDetails: next }
  })
}))
