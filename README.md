# ScriptureLens AI (Chunk Embedding Architecture)

Clean rebuilt system using chunk-level (3–10 verses) 512‑dim embeddings (OpenAI `text-embedding-3-small` with dimensions=512). Chapters no longer store embeddings; all semantic search flows reference `embedding_chunks` joined back to `verses`.

- Two-pane reader with hierarchical navigation tree
- Verse-level similarity based on chunk embeddings
- Admin ingestion pipeline (raw KJV → parsed JSON → semantic chunking → embeddings → Supabase)
- AI tools: Semantic verse search & similarity by verse ID

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

Run the SQL in `supabase/schema.sql` (new architecture). This creates:
* `embedding_chunks` (vector(512)) storing combined text + verse/chapter arrays
* `verses` referencing `chunk_id`
* Helper RPC functions: `semantic_search_verses`, `semantic_search_by_verse`, `lexical_search_verses`, `match_embedding_chunks`

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

## Data Model (Updated)

Tables (see `supabase/schema.sql`):
* `traditions(id, name)`
* `sources(id, tradition_id, name)`
* `works(id, source_id, name, abbrev)`
* `books(id, work_id, seq, title)`
* `chapters(id, book_id, seq, title)` — NO embeddings stored here now.
* `embedding_chunks(id, book_id, start_chapter, end_chapter, verse_numbers[], chapter_numbers[], combined_text, embedding vector(512))`
* `verses(id, book_id, chapter_seq, verse_seq, text, chunk_id)`

Indexes:
* ivfflat on `embedding_chunks(embedding vector_cosine_ops)`
* GIN trigram on `verses.text` & chapters.title
* Narrow indexes on foreign key columns for joins

RPC Functions:
* `match_embedding_chunks(query_embedding)` — raw chunk scores
* `semantic_search_verses(query_embedding, include_lexical, lexical_text)` — hybrid ranking (chunk similarity + optional lexical 15% boost)
* `semantic_search_by_verse(verse_uuid)` — uses source verse's chunk embedding for neighbors
* `lexical_search_verses(q)` — trigram search only

RLS: Public read policies only; writes performed by edge function or ingestion pipeline via service role.

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

### Ingestion & Chunking Flow (New)

Run `scripts/ingest_pipeline.ts` against a master KJV file:
1. Parse file into structured verses per book/chapter.
2. For each chapter call GPT (prompt constant `CHUNKING_PROMPT`) to produce semantic chunks (3–10 verses).
3. Persist per-book raw structure to `data/books/<Book>.json`.
4. Persist chunk structure to `data/chunks/<Book>.json`.
5. Embed each chunk (512 dims) & insert `embedding_chunks` rows.
6. Upsert verses referencing `chunk_id`.
7. Idempotent: verses upsert; existing chunks optionally skipped unless `--force`.

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

### Semantic Search Flow (Chunk-Based)

1. User issues query → API `/api/search/semantic`.
2. Query embedded (512 dims).
3. RPC `semantic_search_verses` ranks chunks then expands verses.
4. Optional lexical re-rank (trigram similarity) with 0.15 weight.
5. Returns verse-level results with scores.

Similarity by verse ID uses RPC `semantic_search_by_verse` (source verse's chunk embedding).

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

### Edge Function (Search)

`supabase/functions/embedding` now performs semantic / lexical / hybrid searches:

Request body examples:
```json
{ "query": "love thy neighbour", "mode": "hybrid", "topK": 30 }
{ "verseId": "<uuid>", "mode": "semantic", "topK": 25 }
{ "query": "faith hope charity", "mode": "lexical" }
```
Deploy:
```powershell
supabase functions deploy embedding --no-verify-jwt
```
Invoke:
```powershell
curl -X POST "$env:SUPABASE_URL/functions/v1/embedding" `
   -H "Authorization: Bearer $env:SUPABASE_SERVICE_ROLE_KEY" `
   -H "Content-Type: application/json" `
   -d '{"query":"endure to the end","mode":"hybrid","topK":20}'
```

### Running the Ingestion Pipeline

Prepare raw master text (e.g., `data/kjv_raw.txt`). Then:
```powershell
$env:OPENAI_API_KEY="sk-..."
$env:SUPABASE_URL="https://xyz.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY="service-role-key"
node --loader ts-node/esm scripts/ingest_pipeline.ts --bibleTxt data/kjv_raw.txt --workName "King James Bible"
```
Options:
* `--bookFilter Genesis` ingest only one book
* `--dryRun` generate JSON but skip DB writes
* `--force` re-embed/reinsert chunks

Outputs:
* `data/books/<Book>.json`
* `data/chunks/<Book>.json`

### Performing Semantic Search (API Route)

```powershell
curl -X POST http://localhost:3000/api/search/semantic -H "Content-Type: application/json" -d '{"query":"charity never faileth","topK":15,"includeLexical":true}'
```
Returns: `{ "verses": [ { verse_id, text, chunk_score, lexical_score, combined_score } ] }`

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
-- `OPENAI_EMBEDDING_MODEL`: Defaults to `text-embedding-3-small`
-- `OPENAI_EMBEDDING_DIMENSIONS`: Set to `512` (required for new architecture)
- `OPENAI_CHAT_MODEL`: Defaults to `gpt-4.1`
- `UPLOAD_PASSWORD`: Upload gate (default `searchponderpray`)

## Deploy

- Deploy Next.js to Vercel or your preferred host
- Set all environment variables in the hosting platform
- Apply `supabase/schema.sql` to your Supabase project

—

ScriptureLens AI — “Search, Ponder, Pray, and Compare.” (Chunk Embedding Edition)
