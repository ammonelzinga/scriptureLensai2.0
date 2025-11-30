# ScriptureLens AI

A Scripture Comparison & AI Study Platform for viewing, comparing, uploading, and analyzing scriptural texts across traditions.

- Two-pane reader with hierarchical navigation tree
- Verse-level “Find Related Scriptures” via embeddings
- Admin upload with auto-parsing and auto-generated verses
- AI tools: Similar Texts, Semantic Topic Explorer

## Quick Start (Windows PowerShell)

1) Install dependencies

```powershell
npm install
```

2) Create `.env.local` from template

```powershell
Copy-Item .env.example .env.local
```

3) Set environment variables in `.env.local`

- `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` (server-only; do NOT expose publicly)
- `OPENAI_API_KEY` (required)
- Optional: `OPENAI_EMBEDDING_MODEL` (default `text-embedding-3-small`), `OPENAI_CHAT_MODEL` (default `gpt-4.1`)
- `UPLOAD_PASSWORD` (default `searchponderpray`)

4) Initialize Supabase schema

- Using Supabase SQL editor or CLI, run the SQL in `supabase/schema.sql` on your project database.

5) Run the dev server

```powershell
npm run dev
```

Open http://localhost:3000

## Pages

- `/` — Home
- `/read` — Two-pane scripture reader with tree navigation
- `/upload` — Admin upload (password: `searchponderpray` by default; configurable via env)
- `/ai` — AI tools (Similar Texts & Ask a Question)

## Data Model

Tables (see `supabase/schema.sql`):
- `traditions(id, name)` — e.g., Christian, Ancient Egyptian
- `sources(id, tradition_id, name)` — e.g., Church of Jesus Christ of LDS, Historical Writings
- `works(id, source_id, name, abbrev)` — e.g., Book of Mormon, Jewish War
- `books(id, work_id, seq, title)` — optional layer for works with named books
- `chapters(id, work_id, book_id?, seq, title, embedding vector(1536))`
- `verses(id, chapter_id, seq, text, embedding vector(1536))`

Indexes and RPCs:
- pgvector `ivfflat` indexes on chapter and verse embeddings
- `match_chapters(query_embedding, match_count)` for similarity search

RLS:
- Public read policies enabled for all tables
- No anon write policies; server-side writes use `SUPABASE_SERVICE_ROLE_KEY` (service role bypasses RLS)

## Architecture

- Frontend: Next.js (App Router), TailwindCSS, TypeScript, Zustand
- Backend: Next.js Route Handlers calling Supabase and OpenAI
- Vector Search: pgvector in Supabase

Key folders:
- `src/app/*` — Pages and API routes
- `src/components/*` — UI components (navigation tree, panes, theme toggle)
- `src/lib/*` — Clients (Supabase/OpenAI), parsing utilities, types, tree builder
- `scripts/*` — Maintenance scripts (e.g., `backfill-embeddings.ts`)
- `supabase/schema.sql` — Database schema, indexes, and RPCs

### Upload & Embedding Flow

1. Admin fills path (tradition → source → work → optional book) and uploads EITHER plain text or JSON
2. API `/api/upload`:
    - Upserts hierarchy rows
    - If `text` provided: parses into chapters & verses
    - If `book` JSON provided: uses supplied chapter/verse numbers directly
    - Inserts chapters and verses
    - Generates embeddings for each verse and the full chapter (Edge Function batching)

JSON book upload example:
```json
{
   "tradition": "KJV",
   "source": "KJV Source",
   "work": "Holy Bible",
   "book": {
      "title": "Genesis",
      "chapters": [ { "number": 1, "verses": [ { "number": 1, "text": "In the beginning..." } ] } ]
   }
}
```
Header: `x-upload-password: <UPLOAD_PASSWORD>`

### Similarity Search Flow (Verse-Level)

1. User clicks “Find Related Scriptures” on a verse in the reader
2. API `/api/search/similar`:
   - Retrieves verse embedding
   - Finds top-N similar chapters via pgvector
   - Scores verses within each top chapter
   - Returns suggested chapters, verses, and a short GPT summary
3. Reader highlights returned verse IDs in the opposite pane

### Semantic Topic Explorer (Q&A)

1. User enters a question (e.g., “What do scriptures say about how to go to heaven?”)
2. API `/api/ai/question`:
   - Expands the question with GPT for richer semantics
   - Embeds the expanded statement
   - Finds most relevant chapters and verses
   - Returns a synthesized overview and ranked results

## Scripts

- `scripts/backfill-embeddings.ts`: Backfills missing embeddings for verses and chapters.
- `scripts/split_bible_kjv.py`: Split numbered KJV master file into per-book `.txt` (Chapter N + verse lines).
- `scripts/export_bible_json.py`: Produce per-book JSON files (and optionally upload via `/api/upload` in JSON mode). Supports direct parsing of numbered master file or existing per-book `.txt` outputs.

Run (Node ESM):
```powershell
node --loader ts-node/esm scripts/backfill-embeddings.ts
```
Or compile with `tsc` and run the emitted JS.

### Edge Function (Batch Embeddings)

Supabase Edge Function provided at `supabase/functions/embedding` for batching verse/chapter embeddings.

Deploy:
```powershell
supabase functions deploy embedding --no-verify-jwt
```

Invoke example (PowerShell):
```powershell
curl -X POST "$env:SUPABASE_URL/functions/v1/embedding" `
   -H "Authorization: Bearer $env:SUPABASE_SERVICE_ROLE_KEY" `
   -H "Content-Type: application/json" `
   -d '{"verses":[{"id":"v1","text":"In the beginning..."}],"chapters":[{"id":"c1","text":"Full chapter text..."}]}'
```

You can replace direct OpenAI calls in the upload API with this Edge Function for isolation and rate management.

### Verse Similarity RPC
### Combined Similarity Endpoint

API route: `POST /api/search/combined`

Body example:
```json
{
   "verseId": "<existing-verse-uuid>",
   "chapterCount": 5,
   "verseCount": 10
}
```
Or raw text:
```json
{
   "text": "Faith hope charity enduring to the end",
   "chapterCount": 5,
   "verseCount": 10
}
```
Returns:
```json
{
   "chapters": [ { "id": "...", "similarity": 0.87, "text": "Chapter 1" } ],
   "verses": [ { "id": "...", "parent_chapter": "...", "similarity": 0.92, "text": "Verse text" } ]
}
```
Useful for unified relevance ranking using one embedding call.

Added `match_verses(query_embedding, match_count)` for fine-grained nearest verse queries. You can combine chapter + verse similarity for richer AI features.

## Production Considerations

- Rate limits: Batch embeddings where possible; this sample performs simple per-row calls for clarity.
- Costs: Prefer `text-embedding-3-small` for storage/perf; switch to `-large` when needed.
- Caching: Cache AI summaries (e.g., in a `summaries` table) if usage grows.
- Observability: Add logging and tracing for upload and search endpoints.
- Access control: Keep service role key server-only; never ship to the client.

## Environment Variables

- `NEXT_PUBLIC_SUPABASE_URL`: Your Supabase URL
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`: Supabase anon key for client reads
- `SUPABASE_SERVICE_ROLE_KEY`: Service role key for server writes/embeddings
- `OPENAI_API_KEY`: OpenAI API key
- `OPENAI_EMBEDDING_MODEL`: Defaults to `text-embedding-3-small` (1536 dims)
- `OPENAI_CHAT_MODEL`: Defaults to `gpt-4.1`
- `UPLOAD_PASSWORD`: Upload gate (default `searchponderpray`)

## Deploy

- Deploy Next.js to Vercel or your preferred host
- Set all environment variables in the hosting platform
- Apply `supabase/schema.sql` to your Supabase project

—

ScriptureLens AI — “Search, Ponder, Pray, and Compare.”
