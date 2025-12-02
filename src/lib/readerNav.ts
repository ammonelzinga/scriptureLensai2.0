"use client"
import { useRouter } from 'next/navigation'
import { useCallback } from 'react'
import { supabaseBrowser } from '@/lib/supabase'
import { useReaderStore } from '@/store/reader'

// Append a chapter to the next pane and go to /read
export function useAppendToReaderFlexible(){
  const router = useRouter()
  const addChapterToNextPane = useReaderStore(s => s.addChapterToNextPane)
  const setHighlights = useReaderStore(s => s.setHighlights)

  const resolveChapterId = useCallback(async (opts: { chapterId?: string; bookId?: string; chapterSeq?: number }): Promise<string|undefined> => {
    if (opts.chapterId) return opts.chapterId
    if (opts.bookId && typeof opts.chapterSeq === 'number') {
      const sb = supabaseBrowser()
      const { data } = await sb.from('chapters').select('id').eq('book_id', opts.bookId).eq('seq', opts.chapterSeq).maybeSingle()
      return data?.id
    }
    return undefined
  }, [])

  return async (loc: { chapterId?: string; bookId?: string; chapterSeq?: number }, highlightIds?: string[]) => {
    const cid = await resolveChapterId(loc)
    if (!cid) { router.push('/read'); return }
    addChapterToNextPane(cid)
    if (highlightIds && highlightIds.length > 0) setHighlights(highlightIds)
    router.push('/read')
  }
}
