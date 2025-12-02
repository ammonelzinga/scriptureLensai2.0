-- =============================================
-- New Scripture Embedding Architecture Migration
-- =============================================
-- Extensions
create extension if not exists vector;            -- pgvector for embeddings
create extension if not exists pg_trgm;           -- trigram lexical similarity
create extension if not exists pgcrypto;          -- for gen_random_uuid()

-- =============================================
-- Core Reference Entities (Provenance / Metadata)
-- =============================================
create table if not exists traditions (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz default now()
);

create table if not exists sources (
  id uuid primary key default gen_random_uuid(),
  tradition_id uuid not null references traditions(id) on delete cascade,
  name text not null,
  unique(tradition_id, name),
  created_at timestamptz default now()
);

create table if not exists works (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references sources(id) on delete cascade,
  name text not null,
  abbrev text,
  unique(source_id, name),
  created_at timestamptz default now()
);

create table if not exists books (
  id uuid primary key default gen_random_uuid(),
  work_id uuid not null references works(id) on delete cascade,
  seq int not null,
  title text not null,
  unique(work_id, seq),
  created_at timestamptz default now()
);

-- =============================================
-- Chapters (No embeddings anymore)
-- =============================================
create table if not exists chapters (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references books(id) on delete cascade,
  seq int not null,
  title text,
  unique(book_id, seq),
  created_at timestamptz default now()
);
create index if not exists chapters_book_seq_idx on chapters(book_id, seq);
create index if not exists chapters_title_trgm_idx on chapters using gin (title gin_trgm_ops);

-- =============================================
-- Embedding Chunks (Group of verses, 3-10 verses)
-- =============================================
create table if not exists embedding_chunks (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references books(id) on delete cascade,
  start_chapter int not null,            -- first chapter touched (for filtering)
  end_chapter int not null,              -- last chapter touched (inclusive)
  verse_numbers int[] not null,          -- ordered verse numbers within their chapters (flattened sequentially)
  chapter_numbers int[] not null,        -- parallel array of chapter numbers (same length as verse_numbers)
  combined_text text not null,           -- concatenated verse text
  embedding vector(512) not null,        -- 512-dim embedding (text-embedding-3-small)
  verses_count int generated always as (cardinality(verse_numbers)) stored,
  combined_hash text,                    -- deterministic hash of (book_id + chapter_numbers + verse_numbers) for idempotent upserts
  created_at timestamptz default now(),
  constraint chk_chunk_min_max check (cardinality(verse_numbers) >= 3 and cardinality(verse_numbers) <= 10)
);
-- Vector index (use ivfflat; requires data loaded before efficient usage)
create index if not exists embedding_chunks_embedding_idx on embedding_chunks using ivfflat (embedding vector_cosine_ops) with (lists = 100);
create index if not exists embedding_chunks_book_idx on embedding_chunks(book_id);
-- Unique natural key index for idempotency (skip re-embedding identical chunk)
alter table embedding_chunks add column if not exists combined_hash text;
create unique index if not exists embedding_chunks_combined_hash_uidx on embedding_chunks(combined_hash);

-- =============================================
-- Verses (One row per verse, referencing chunk)
-- =============================================
create table if not exists verses (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references books(id) on delete cascade,
  chapter_seq int not null,              -- chapter number within book
  verse_seq int not null,                -- verse number within chapter
  text text not null,
  chunk_id uuid not null references embedding_chunks(id) on delete restrict,
  unique(book_id, chapter_seq, verse_seq),
  created_at timestamptz default now()
);
create index if not exists verses_chunk_idx on verses(chunk_id);
create index if not exists verses_book_chapter_idx on verses(book_id, chapter_seq);
create index if not exists verses_text_trgm_idx on verses using gin (text gin_trgm_ops);

-- =============================================
-- Search / Similarity Helper Functions (Vector + Lexical)
-- =============================================
-- Return matching chunk IDs with similarity score (cosine)
create or replace function match_embedding_chunks(
  query_embedding vector(512),
  match_count int default 10,
  p_book_id uuid default null,
  p_work_id uuid default null,
  p_book_seq_min int default null,
  p_book_seq_max int default null
)
returns table (chunk_id uuid, score double precision)
language plpgsql stable as $$
begin
  -- Improve recall for IVFFLAT by increasing probes (approximate → closer to exact)
  perform set_config('ivfflat.probes', greatest(10, match_count)::text, true);

  return query
  select c.id as chunk_id,
         1 - (c.embedding <=> query_embedding) as score
  from embedding_chunks c
  join books b on b.id = c.book_id
  where (p_book_id is null or c.book_id = p_book_id)
    and (p_work_id is null or b.work_id = p_work_id)
    and (p_book_seq_min is null or b.seq >= p_book_seq_min)
    and (p_book_seq_max is null or b.seq <= p_book_seq_max)
  order by c.embedding <=> query_embedding
  limit match_count;
end;
$$;

-- Expand chunks into verses ranked by chunk similarity; optionally include lexical similarity
create or replace function semantic_search_verses(
  query_embedding vector(512),
  match_count int default 25,
  include_lexical boolean default true,
  lexical_text text default null,
  p_book_id uuid default null,
  p_work_id uuid default null,
  p_book_seq_min int default null,
  p_book_seq_max int default null
)
returns table (
  verse_id uuid,
  book_id uuid,
  chapter_seq int,
  verse_seq int,
  text text,
  chunk_id uuid,
  chunk_score double precision,
  lexical_score double precision,
  combined_score double precision
)
language plpgsql stable as $$
begin
  -- Improve recall for IVFFLAT by increasing probes
  perform set_config('ivfflat.probes', greatest(10, match_count * 2)::text, true);

  return query
  with chunk_matches as (
    select c.id, 1 - (c.embedding <=> query_embedding) as score
    from embedding_chunks c
    join books b on b.id = c.book_id
    where (p_book_id is null or c.book_id = p_book_id)
      and (p_work_id is null or b.work_id = p_work_id)
      and (p_book_seq_min is null or b.seq >= p_book_seq_min)
      and (p_book_seq_max is null or b.seq <= p_book_seq_max)
    order by c.embedding <=> query_embedding
    limit match_count * 2  -- fetch extra chunks then fan out verses
  )
  select v.id as verse_id,
         v.book_id,
         v.chapter_seq,
         v.verse_seq,
         v.text,
         v.chunk_id,
         cm.score as chunk_score,
         case when include_lexical and lexical_text is not null then similarity(v.text, lexical_text) else 0::double precision end as lexical_score,
         cm.score + (case when include_lexical and lexical_text is not null then similarity(v.text, lexical_text) * 0.15 else 0::double precision end) as combined_score
  from verses v
  join chunk_matches cm on cm.id = v.chunk_id
  order by combined_score desc
  limit match_count;
end;
$$;

-- Given a verse id, search for similar verses via its chunk embedding (self-exclusion optional)
create or replace function semantic_search_by_verse(
  verse_uuid uuid,
  match_count int default 20,
  exclude_self boolean default true,
  p_book_id uuid default null,
  p_work_id uuid default null,
  p_book_seq_min int default null,
  p_book_seq_max int default null
)
returns table (
  verse_id uuid,
  book_id uuid,
  chapter_seq int,
  verse_seq int,
  text text,
  source_chunk uuid,
  match_chunk uuid,
  chunk_score double precision
)
language plpgsql stable as $$
begin
  -- Improve recall for IVFFLAT by increasing probes
  perform set_config('ivfflat.probes', greatest(10, match_count * 2)::text, true);

  return query
  with src as (
    select v.id as verse_id, c.embedding, v.chunk_id
    from verses v
    join embedding_chunks c on c.id = v.chunk_id
    where v.id = verse_uuid
  ), chunk_neighbors as (
    select ec.id, 1 - (ec.embedding <=> s.embedding) as score
    from embedding_chunks ec, src s
    join books b on b.id = ec.book_id
    where (p_book_id is null or ec.book_id = p_book_id)
      and (p_work_id is null or b.work_id = p_work_id)
      and (p_book_seq_min is null or b.seq >= p_book_seq_min)
      and (p_book_seq_max is null or b.seq <= p_book_seq_max)
    order by ec.embedding <=> s.embedding
    limit match_count * 2
  )
  select v.id as verse_id,
         v.book_id,
         v.chapter_seq,
         v.verse_seq,
         v.text,
         (select chunk_id from src) as source_chunk,
         v.chunk_id as match_chunk,
         cn.score as chunk_score
  from verses v
  join chunk_neighbors cn on cn.id = v.chunk_id
  where not (exclude_self and v.id = verse_uuid)
  order by chunk_score desc
  limit match_count;
end;
$$;

-- Simple lexical verse search (trigram)
create or replace function lexical_search_verses(
  q text,
  match_count int default 20,
  p_book_id uuid default null,
  p_work_id uuid default null,
  p_book_seq_min int default null,
  p_book_seq_max int default null
)
returns table (verse_id uuid, book_id uuid, chapter_seq int, verse_seq int, text text, similarity float)
language sql stable as $$
  select v.id, v.book_id, v.chapter_seq, v.verse_seq, v.text, similarity(v.text, q) as similarity
  from verses v
  join books b on b.id = v.book_id
  where v.text % q
    and (p_book_id is null or v.book_id = p_book_id)
    and (p_work_id is null or b.work_id = p_work_id)
    and (p_book_seq_min is null or b.seq >= p_book_seq_min)
    and (p_book_seq_max is null or b.seq <= p_book_seq_max)
  order by similarity(v.text, q) desc
  limit match_count
$$;

-- Exact single-word verse search using regex word boundaries (case-insensitive)
create or replace function lexical_search_word_exact(
  q text,
  match_count int default 20,
  p_book_id uuid default null,
  p_work_id uuid default null,
  p_book_seq_min int default null,
  p_book_seq_max int default null
)
returns table (verse_id uuid, book_id uuid, chapter_seq int, verse_seq int, text text)
language sql stable as $$
  select v.id, v.book_id, v.chapter_seq, v.verse_seq, v.text
  from verses v
  join books b on b.id = v.book_id
  where v.text ~* ('\\m' || q || '\\M')
    and (p_book_id is null or v.book_id = p_book_id)
    and (p_work_id is null or b.work_id = p_work_id)
    and (p_book_seq_min is null or b.seq >= p_book_seq_min)
    and (p_book_seq_max is null or b.seq <= p_book_seq_max)
  order by v.book_id, v.chapter_seq, v.verse_seq
  limit match_count
$$;

-- =============================================
-- Row Level Security (Public read only)
-- =============================================
alter table traditions        enable row level security;
alter table sources           enable row level security;
alter table works             enable row level security;
alter table books             enable row level security;
alter table chapters          enable row level security;
alter table embedding_chunks  enable row level security;
alter table verses            enable row level security;

-- Helper to create read policy if not present
do $$ begin if not exists (select 1 from pg_policies where schemaname='public' and tablename='traditions' and policyname='read_traditions') then create policy read_traditions on traditions for select using (true); end if; end $$;
do $$ begin if not exists (select 1 from pg_policies where schemaname='public' and tablename='sources' and policyname='read_sources') then create policy read_sources on sources for select using (true); end if; end $$;
do $$ begin if not exists (select 1 from pg_policies where schemaname='public' and tablename='works' and policyname='read_works') then create policy read_works on works for select using (true); end if; end $$;
do $$ begin if not exists (select 1 from pg_policies where schemaname='public' and tablename='books' and policyname='read_books') then create policy read_books on books for select using (true); end if; end $$;
do $$ begin if not exists (select 1 from pg_policies where schemaname='public' and tablename='chapters' and policyname='read_chapters') then create policy read_chapters on chapters for select using (true); end if; end $$;
do $$ begin if not exists (select 1 from pg_policies where schemaname='public' and tablename='embedding_chunks' and policyname='read_embedding_chunks') then create policy read_embedding_chunks on embedding_chunks for select using (true); end if; end $$;
do $$ begin if not exists (select 1 from pg_policies where schemaname='public' and tablename='verses' and policyname='read_verses') then create policy read_verses on verses for select using (true); end if; end $$;

-- =============================================
-- Notes:
-- * Embeddings only stored at chunk level (512 dims).
-- * Verses link to chunk via chunk_id.
-- * All previous chapter/verse embedding columns & queues removed.
-- * Functions provided for semantic search by query embedding or verse id.
-- * Use cosine distance ordering: ORDER BY embedding <-> query_vector (via <=> for distance then 1 - for similarity).
-- =============================================
