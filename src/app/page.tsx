import Link from 'next/link'

export default function HomePage() {
  return (
    <div className="space-y-8">
      <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 p-6 bg-white/60 dark:bg-zinc-900/60 backdrop-blur">
        <h1 className="text-2xl font-semibold">Welcome to ScriptureLens AI</h1>
        <p className="mt-2 text-zinc-600 dark:text-zinc-400 max-w-2xl">
          A platform to read, compare, upload, and analyze scriptural texts across traditions — with AI tools to discover related passages and explore topics.
        </p>
        <div className="mt-4 flex gap-3">
          <Link href="/read" className="rounded-md bg-primary px-4 py-2 text-primary-foreground hover:opacity-90">Open Reader</Link>
          <Link href="/ai" className="rounded-md border border-zinc-200 dark:border-zinc-800 px-4 py-2 hover:bg-zinc-50 dark:hover:bg-zinc-900">Explore AI Tools</Link>
        </div>
      </section>

      <section className="grid sm:grid-cols-2 gap-4">
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4">
          <h2 className="font-medium">Two-Pane Comparison</h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">Read any two passages side-by-side, with verse-level AI suggestions.</p>
        </div>
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4">
          <h2 className="font-medium">Upload Your Texts</h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">Parse chapters/verses and auto-generate embeddings for semantic study.</p>
        </div>
      </section>
    </div>
  )
}
