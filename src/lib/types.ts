export type ID = string

export type Tradition = { id: ID; name: string }
export type Source = { id: ID; tradition_id: ID; name: string }
export type Work = { id: ID; source_id: ID; name: string; abbrev?: string | null }
export type Book = { id: ID; work_id: ID; seq: number; title: string }
export type Chapter = { id: ID; work_id: ID; book_id?: ID | null; seq: number; title: string }
export type Verse = { id: ID; chapter_id: ID; seq: number; text: string }

export type TreeNode = {
  key: string
  label: string
  type: 'tradition' | 'source' | 'work' | 'book' | 'chapter' | 'verse'
  id: ID
  children?: TreeNode[]
}
