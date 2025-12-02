import type { Metadata } from 'next'
import './globals.css'
import { ThemeProvider } from 'next-themes'
import Link from 'next/link'
import { ThemeToggle } from '@/components/ThemeToggle'

export const metadata: Metadata = {
  title: 'ScriptureLens AI',
  description: 'Scripture Comparison & AI Study Platform',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          <header className="border-b border-zinc-200 dark:border-zinc-800">
            <div className="mx-auto max-w-7xl px-4 sm:px-6 py-3 flex items-center justify-between">
              <Link href="/" className="text-lg font-semibold tracking-tight">
                <span className="text-primary">ScriptureLens</span> AI
              </Link>
              <nav className="flex gap-4 text-sm">
                <Link href="/read" className="hover:text-primary">Read</Link>
                {/* AI Tools temporarily hidden */}
                {/* <Link href="/ai" className="hover:text-primary">AI Tools</Link> */}
                <Link href="/upload" className="hover:text-primary">Upload</Link>
                <ThemeToggle />
              </nav>
            </div>
          </header>
          <main className="mx-auto max-w-7xl px-4 sm:px-6 py-6">{children}</main>
        </ThemeProvider>
      </body>
    </html>
  )
}
