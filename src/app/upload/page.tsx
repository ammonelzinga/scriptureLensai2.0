"use client"
import { useEffect, useState } from 'react'

export default function UploadPage() {
  const [password, setPassword] = useState('')
  const [granted, setGranted] = useState(false)
  const defaultPw = process.env.NEXT_PUBLIC_UPLOAD_PASSWORD ?? ''

  useEffect(() => {
    if (!defaultPw) return
    setPassword(defaultPw)
  }, [defaultPw])

  const [tradition, setTradition] = useState('')
  const [source, setSource] = useState('')
  const [work, setWork] = useState('')
  const [bookTitle, setBookTitle] = useState('')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string>('')

  const submit = async () => {
    setBusy(true); setResult('')
    try {
      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-upload-password': password },
        body: JSON.stringify({ tradition, source, work, bookTitle, text })
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Upload failed')
      setResult(`Uploaded ${json.chapters} chapter(s).`)
    } catch (e:any) {
      setResult(`Error: ${e.message}`)
    } finally {
      setBusy(false)
    }
  }

  if (!granted) {
    return (
      <div className="max-w-md">
        <h2 className="text-lg font-semibold mb-2">Admin Upload</h2>
        <p className="text-sm text-zinc-500 mb-3">Enter password to continue.</p>
        <input value={password} onChange={e=>setPassword(e.target.value)} placeholder="Password" type="password" className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 px-3 py-2" />
        <button onClick={()=>setGranted(true)} className="mt-3 rounded-md bg-primary px-4 py-2 text-primary-foreground">Unlock</button>
      </div>
    )
  }

  return (
    <div className="space-y-4 max-w-2xl">
      <h2 className="text-lg font-semibold">Upload Scripture Text</h2>
      <div className="grid sm:grid-cols-2 gap-3">
        <input value={tradition} onChange={e=>setTradition(e.target.value)} placeholder="Tradition (e.g., Christian)" className="rounded-md border border-zinc-300 dark:border-zinc-700 px-3 py-2" />
        <input value={source} onChange={e=>setSource(e.target.value)} placeholder="Source (e.g., Church of Jesus Christ...)" className="rounded-md border border-zinc-300 dark:border-zinc-700 px-3 py-2" />
        <input value={work} onChange={e=>setWork(e.target.value)} placeholder="Work (e.g., Book of Mormon)" className="rounded-md border border-zinc-300 dark:border-zinc-700 px-3 py-2" />
        <input value={bookTitle} onChange={e=>setBookTitle(e.target.value)} placeholder="Book title (optional, e.g., 1 Nephi)" className="rounded-md border border-zinc-300 dark:border-zinc-700 px-3 py-2" />
      </div>
      <textarea value={text} onChange={e=>setText(e.target.value)} placeholder="Paste plain UTF-8 text here..." rows={12} className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 px-3 py-2" />
      <div className="flex items-center gap-3">
        <button disabled={busy} onClick={submit} className="rounded-md bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50">{busy ? 'Uploading…' : 'Upload & Embed'}</button>
        <button onClick={()=>{setText(''); setResult('')}} className="rounded-md border border-zinc-300 dark:border-zinc-700 px-4 py-2">Reset</button>
      </div>
      {result && <p className="text-sm">{result}</p>}
      <p className="text-xs text-zinc-500">Tip: If uploading a single chapter, include a header like "Chapter 1" or leave as is — the system will auto-chunk by ~25 words without splitting sentences.</p>
    </div>
  )
}
