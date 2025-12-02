"use client"
import { ReaderStack } from '@/components/ReaderStack'

// Backwards-compatible wrapper: ScripturePane now renders the full ReaderStack for the given side.
export function ScripturePane({ side }: { side: 'left' | 'right' }) {
  const paneIndex = side === 'left' ? 0 : 1
  return <ReaderStack paneIndex={paneIndex} />
}
