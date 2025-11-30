"use client"
import { useEffect, useState } from 'react'
import { fetchNavigationTree } from '@/lib/tree'
import type { TreeNode } from '@/lib/types'
import { ChevronDown, ChevronRight } from 'lucide-react'

type Props = {
  onSelectChapter?: (chapterId: string) => void
}

export function NavigationTree({ onSelectChapter }: Props) {
  const [tree, setTree] = useState<TreeNode[]>([])
  const [open, setOpen] = useState<Record<string, boolean>>({})

  useEffect(() => {
    fetchNavigationTree().then(setTree).catch(() => setTree([]))
  }, [])

  const toggle = (k: string) => setOpen(o => ({ ...o, [k]: !o[k] }))

  return (
    <div className="text-sm">
      {tree.map(node => (
        <Node key={node.key} node={node} open={open} onToggle={toggle} onSelectChapter={onSelectChapter} />
      ))}
    </div>
  )
}

function Node({ node, open, onToggle, onSelectChapter }: { node: TreeNode; open: Record<string, boolean>; onToggle: (k: string)=>void; onSelectChapter?: (id: string)=>void }) {
  const hasChildren = !!node.children?.length
  const isLeaf = node.type === 'chapter' || node.type === 'verse'
  const expanded = open[node.key]
  return (
    <div className="pl-2">
      <div className="flex items-center gap-2 py-1">
        {hasChildren ? (
          <button className="inline-flex" onClick={()=>onToggle(node.key)} aria-label="toggle">
            {expanded ? <ChevronDown size={16}/> : <ChevronRight size={16}/>} 
          </button>
        ) : (
          <span className="inline-block w-4" />
        )}
        <button
          className="text-left hover:text-primary"
          onClick={() => {
            if (node.type === 'chapter' && onSelectChapter) onSelectChapter(node.id)
            if (hasChildren) onToggle(node.key)
          }}
        >
          {node.label}
        </button>
      </div>
      {hasChildren && expanded && (
        <div className="pl-4 border-l border-zinc-200 dark:border-zinc-800">
          {node.children!.map(c => (
            <Node key={c.key} node={c} open={open} onToggle={onToggle} onSelectChapter={onSelectChapter} />
          ))}
        </div>
      )}
    </div>
  )
}
