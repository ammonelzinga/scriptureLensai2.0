import { supabaseBrowser } from '@/lib/supabase'
import { TreeNode } from '@/lib/types'

export async function fetchNavigationTree(): Promise<TreeNode[]> {
  const sb = supabaseBrowser()

  const { data: traditions } = await sb.from('traditions').select('*').order('name')
  if (!traditions) return []

  const { data: sources } = await sb.from('sources').select('*')
  const { data: works } = await sb.from('works').select('*')
  const { data: books } = await sb.from('books').select('*')
  // Page through chapters to avoid server-side row limits (~1000 default)
  const chapters: any[] = []
  const pageSize = 1000
  for (let from = 0; ; from += pageSize) {
    const { data } = await sb
      .from('chapters')
      .select('*')
      .order('book_id')
      .order('seq', { ascending: true })
      .range(from, from + pageSize - 1)
    if (!data || data.length === 0) break
    chapters.push(...data)
    if (data.length < pageSize) break
  }

  const sourceByTrad = new Map<string, any[]>(traditions.map(t => [t.id, []]))
  sources?.forEach(s => sourceByTrad.get(s.tradition_id)?.push(s))

  const worksBySource = new Map<string, any[]>(sources?.map(s => [s.id, []]) || [])
  works?.forEach(w => worksBySource.get(w.source_id)?.push(w))

  const booksByWork = new Map<string, any[]>(works?.map(w => [w.id, []]) || [])
  books?.forEach(b => booksByWork.get(b.work_id)?.push(b))

  const chaptersByWork = new Map<string, any[]>(works?.map(w => [w.id, []]) || [])
  // Note: chapters table has no work_id; fallback below handles works without books.

  const chaptersByBook = new Map<string, any[]>(books?.map(b => [b.id, []]) || [])
  chapters?.forEach(c => c.book_id && chaptersByBook.get(c.book_id)?.push(c))

  // Defensive fallback: if any book has no chapters collected, try fetching directly by book_id
  if (books && books.length) {
    const missing = books.filter(b => (chaptersByBook.get(b.id) || []).length === 0)
    for (const b of missing) {
      const { data: chForBook } = await sb.from('chapters').select('*').eq('book_id', b.id)
      if (chForBook && chForBook.length) {
        chaptersByBook.set(b.id, chForBook)
      }
    }
  }

  const tree: TreeNode[] = traditions.map(t => ({
    key: `tradition:${t.id}`,
    label: t.name,
    type: 'tradition',
    id: t.id,
    children: (sourceByTrad.get(t.id) || []).sort((a,b)=>a.name.localeCompare(b.name)).map(s => ({
      key: `source:${s.id}`,
      label: s.name,
      type: 'source',
      id: s.id,
      children: (worksBySource.get(s.id) || []).sort((a,b)=>a.name.localeCompare(b.name)).map(w => ({
        key: `work:${w.id}`,
        label: w.name,
        type: 'work',
        id: w.id,
        children: (() => {
          const bks = (booksByWork.get(w.id) || []).sort((a,b)=>a.seq-b.seq)
          if (bks.length) {
            return bks.map(b => ({
              key: `book:${b.id}`,
              label: b.title,
              type: 'book',
              id: b.id,
              children: (chaptersByBook.get(b.id) || []).sort((a,b)=>a.seq-b.seq).map((c:any)=>({
                key: `chapter:${c.id}`,
                label: c.title || `Chapter ${c.seq}`,
                type: 'chapter',
                id: c.id,
              }))
            }))
          }
          // works without books
          return (chaptersByWork.get(w.id) || []).sort((a,b)=>a.seq-b.seq).map((c:any)=>({
            key: `chapter:${c.id}`,
            label: c.title || `Chapter ${c.seq}`,
            type: 'chapter',
            id: c.id,
          }))
        })()
      }))
    }))
  }))

  return tree
}
