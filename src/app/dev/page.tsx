"use client"
import { useState, useEffect } from 'react'

type MissingData = {
  works: Array<{
    id: string
    name: string
    abbrev?: string
    missingChapterCount: number
    missingVerseCount: number
    books: Array<{
      id: string
      title: string
      seq: number
      missingChapterCount: number
      missingVerseCount: number
      chapters: Array<{
        id: string
        seq: number
        title: string
        missingVerses: Array<{ id: string; seq: number; text: string }>
      }>
    }>
  }>
}

const PASSWORD = 'searchponderpray'

export default function DevPage() {
  const [password, setPassword] = useState('')
  const [unlocked, setUnlocked] = useState(false)
  const [data, setData] = useState<MissingData | null>(null)
  const [loading, setLoading] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string>('')

  const unlock = async () => {
    if (password !== PASSWORD) { setError('Incorrect password'); return }
    setError(''); setUnlocked(true); await refresh()
  }

  const refresh = async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/dev/missing?password=${encodeURIComponent(password)}`)
      const json = await res.json()
      setData(json)
    } finally { setLoading(false) }
  }

  const callEmbed = async (payload: any, key: string) => {
    setBusyId(key)
    try {
      const res = await fetch('/api/dev/embed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password, ...payload }) })
      await res.json()
      await refresh()
    } finally { setBusyId(null) }
  }

  useEffect(()=>{ if(unlocked) refresh() },[unlocked])

  return (
    <div className="space-y-6 max-w-5xl mx-auto p-4">
      <h1 className="text-2xl font-semibold">Developer Embedding Maintenance</h1>
      {!unlocked && (
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4 space-y-3">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">This page is for testing and maintenance purposes. Enter the developer password to view and generate missing embeddings.</p>
          <input
            type="password"
            value={password}
            onChange={e=>setPassword(e.target.value)}
            placeholder="developer password"
            className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm"
          />
          {error && <div className="text-xs text-red-600">{error}</div>}
          <button
            onClick={unlock}
            className="rounded-md bg-primary px-4 py-2 text-primary-foreground text-sm"
            disabled={!password.trim()}
          >Unlock</button>
        </div>
      )}
      {unlocked && (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <button onClick={refresh} className="text-xs underline" disabled={loading}>{loading?'Refreshing…':'Refresh list'}</button>
            <span className="text-xs text-zinc-500">Only rows with null embeddings are shown.</span>
          </div>
          {!data && !loading && <div className="text-sm">No data loaded yet.</div>}
          {data && data.works.map(work => (
            <div key={work.id} className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="font-medium">Work: {work.abbrev || work.name}</h2>
                  <p className="text-xs text-zinc-500">Missing chapters: {work.missingChapterCount} • Missing verses: {work.missingVerseCount}</p>
                </div>
                <button
                  disabled={busyId!==null}
                  onClick={()=>callEmbed({ workId: work.id }, `work-${work.id}`)}
                  className="text-xs underline"
                >{busyId===`work-${work.id}`?'Embedding…':'Embed all missing in work'}</button>
              </div>
              <div className="space-y-2">
                {work.books.map(book => (
                  <div key={book.id} className="border border-zinc-100 dark:border-zinc-700 rounded-md p-3">
                    <div className="flex items-center justify-between">
                      <div className="text-sm font-medium">{book.seq}. {book.title}</div>
                      <div className="text-[11px] text-zinc-500">Ch missing: {book.missingChapterCount} • V missing: {book.missingVerseCount}</div>
                    </div>
                    {book.chapters.length>0 ? (
                      <ul className="mt-2 space-y-2 text-xs">
                        {book.chapters.map(ch => (
                          <li key={ch.id} className="border border-zinc-200 dark:border-zinc-800 rounded-md p-2">
                            <div className="flex items-center justify-between">
                              <span className="font-medium">Chapter {ch.seq} {ch.title && `– ${ch.title}`}</span>
                              <button
                                disabled={busyId!==null}
                                onClick={()=>callEmbed({ chapterId: ch.id }, `chapter-${ch.id}`)}
                                className="underline"
                              >{busyId===`chapter-${ch.id}`?'Embedding…':'Embed chapter & missing verses'}</button>
                            </div>
                            {ch.missingVerses.length>0 && (
                              <ul className="mt-2 flex flex-wrap gap-2">
                                {ch.missingVerses.map(v => (
                                  <li key={v.id} className="rounded border border-zinc-300 dark:border-zinc-700 px-2 py-1 flex items-center gap-2">
                                    <span className="text-[11px] font-medium">V{v.seq}</span>
                                    <button
                                      disabled={busyId!==null}
                                      onClick={()=>callEmbed({ verseId: v.id }, `verse-${v.id}`)}
                                      className="text-[11px] underline"
                                    >{busyId===`verse-${v.id}`?'Embedding…':'Embed verse'}</button>
                                  </li>
                                ))}
                              </ul>
                            )}
                            {ch.missingVerses.length===0 && <div className="mt-1 text-[11px] text-zinc-500">No missing verses</div>}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <div className="mt-2 text-[11px] text-zinc-500">No missing chapters in this book.</div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
