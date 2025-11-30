"use client"
import { useTheme } from 'next-themes'
import { Sun, Moon } from 'lucide-react'

export function ThemeToggle() {
  const { theme, setTheme } = useTheme()
  const isDark = theme === 'dark'
  return (
    <button
      aria-label="Toggle theme"
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
      className="inline-flex items-center gap-2 rounded-md border border-zinc-200 dark:border-zinc-800 px-2 py-1 text-xs hover:bg-zinc-50 dark:hover:bg-zinc-900"
    >
      {isDark ? <Sun size={14} /> : <Moon size={14} />}
      {isDark ? 'Light' : 'Dark'}
    </button>
  )
}
