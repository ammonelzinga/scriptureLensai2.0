-- Enable pgvector
create extension if not exists vector;
-- Enable pg_trgm for fast lexical search
create extension if not exists pg_trgm;

-- Entities
create table if not exists traditions (
  id uuid primary key default gen_random_uuid(),
  name text not null unique
);

create table if not exists sources (
  id uuid primary key default gen_random_uuid(),
  tradition_id uuid not null references traditions(id) on delete cascade,
  name text not null,
  unique(tradition_id, name)
);

create table if not exists works (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references sources(id) on delete cascade,
  name text not null,
  abbrev text,
  unique(source_id, name)
);

create table if not exists books (
  id uuid primary key default gen_random_uuid(),
  work_id uuid not null references works(id) on delete cascade,
  seq int not null,
  title text not null,
  unique(work_id, seq)
);

-- Using 1536 dims for text-embedding-3-small by default
create table if not exists chapters (
  id uuid primary key default gen_random_uuid(),
  work_id uuid not null references works(id) on delete cascade,
  book_id uuid references books(id) on delete cascade,
  seq int not null,
  title text,
  embedding vector(1536)
);
create index if not exists chapters_embedding_idx on chapters using ivfflat (embedding vector_cosine_ops) with (lists = 100);

create table if not exists verses (
  id uuid primary key default gen_random_uuid(),
  chapter_id uuid not null references chapters(id) on delete cascade,
  seq int not null,
  text text not null,
  embedding vector(1536)
);
create index if not exists verses_chapter_seq_idx on verses(chapter_id, seq);
create index if not exists verses_embedding_idx on verses using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- Trigram indexes for lexical search
create index if not exists verses_text_trgm_idx on verses using gin (text gin_trgm_ops);
create index if not exists chapters_title_trgm_idx on chapters using gin (title gin_trgm_ops);

-- Lexical search RPCs using pg_trgm similarity
create or replace function lexical_search_verses(q text, match_count int default 20)
returns table (id uuid, chapter_id uuid, seq int, text text, book_id uuid, book_title text, chapter_number int, similarity float)
language sql stable as $$
  select v.id, v.chapter_id, v.seq, v.text, c.book_id, b.title as book_title, c.seq as chapter_number,
         similarity(v.text, q) as similarity
  from verses v
  join chapters c on c.id = v.chapter_id
  join books b on b.id = c.book_id
  where v.text % q
  order by similarity(v.text, q) desc
  limit match_count
$$;

create or replace function lexical_search_chapters(q text, match_count int default 20)
returns table (id uuid, book_id uuid, title text, chapter_number int, book_title text, similarity float)
language sql stable as $$
  select c.id, c.book_id, coalesce(c.title, 'Chapter '||c.seq) as title, c.seq as chapter_number, b.title as book_title,
         similarity(c.title, q) as similarity
  from chapters c
  join books b on b.id = c.book_id
  where c.title % q
  order by similarity(c.title, q) desc
  limit match_count
$$;

-- Similarity RPCs
create or replace function match_chapters(query_embedding vector, match_count int default 10)
returns table (id uuid, title text, seq int, work_id uuid, book_id uuid, similarity float)
language sql stable as $$
  select c.id, c.title, c.seq, c.work_id, c.book_id,
         1 - (c.embedding <=> query_embedding) as similarity
  from chapters c
  where c.embedding is not null
  order by c.embedding <=> query_embedding
  limit match_count
$$;

create or replace function match_verses(query_embedding vector, match_count int default 15)
returns table (id uuid, chapter_id uuid, seq int, text text, similarity float)
language sql stable as $$
  select v.id, v.chapter_id, v.seq, v.text,
         1 - (v.embedding <=> query_embedding) as similarity
  from verses v
  where v.embedding is not null
  order by v.embedding <=> query_embedding
  limit match_count
$$;

-- Embedding jobs queue
create table if not exists embedding_jobs (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null check (entity_type in ('verse','chapter')),
  entity_id uuid not null,
  status text not null default 'pending' check (status in ('pending','processing','done','error')),
  error text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
alter table embedding_jobs enable row level security;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename='embedding_jobs' AND policyname='read_embedding_jobs'
  ) THEN
    CREATE POLICY read_embedding_jobs ON embedding_jobs FOR SELECT USING (true);
  END IF;
END $$;

create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;$$ language plpgsql;

drop trigger if exists trg_embedding_jobs_updated_at on embedding_jobs;
create trigger trg_embedding_jobs_updated_at before update on embedding_jobs for each row execute function set_updated_at();

-- Trigger functions to enqueue embedding jobs when new verse/chapter inserted without embedding
create or replace function enqueue_verse_embedding() returns trigger as $$
begin
  if new.embedding is null then
    insert into embedding_jobs(entity_type, entity_id) values ('verse', new.id);
  end if;
  return new;
end;$$ language plpgsql;

create or replace function enqueue_chapter_embedding() returns trigger as $$
begin
  if new.embedding is null then
    insert into embedding_jobs(entity_type, entity_id) values ('chapter', new.id);
  end if;
  return new;
end;$$ language plpgsql;

drop trigger if exists trg_enqueue_verse on verses;
create trigger trg_enqueue_verse after insert on verses for each row execute function enqueue_verse_embedding();

drop trigger if exists trg_enqueue_chapter on chapters;
create trigger trg_enqueue_chapter after insert on chapters for each row execute function enqueue_chapter_embedding();

-- Combined similarity (chapters + verses)
create or replace function match_chapter_and_verses(query_embedding vector, chapter_count int default 10, verse_count int default 15)
returns table(entity_type text, id uuid, parent_chapter uuid, seq int, text text, similarity float)
language sql stable as $$
  (
    select 'chapter' as entity_type, c.id, c.id as parent_chapter, c.seq, coalesce(c.title, 'Chapter '||c.seq) as text,
           1 - (c.embedding <=> query_embedding) as similarity
    from chapters c
    where c.embedding is not null
    order by c.embedding <=> query_embedding
    limit chapter_count
  )
  union all
  (
    select 'verse' as entity_type, v.id, v.chapter_id as parent_chapter, v.seq, v.text,
           1 - (v.embedding <=> query_embedding) as similarity
    from verses v
    where v.embedding is not null
    order by v.embedding <=> query_embedding
    limit verse_count
  )
$$;


-- RLS
alter table traditions enable row level security;
alter table sources enable row level security;
alter table works enable row level security;
alter table books enable row level security;
alter table chapters enable row level security;
alter table verses enable row level security;

-- Public read policies
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='traditions' AND policyname='read_traditions') THEN
    CREATE POLICY read_traditions ON traditions FOR SELECT USING (true);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='sources' AND policyname='read_sources') THEN
    CREATE POLICY read_sources ON sources FOR SELECT USING (true);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='works' AND policyname='read_works') THEN
    CREATE POLICY read_works ON works FOR SELECT USING (true);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='books' AND policyname='read_books') THEN
    CREATE POLICY read_books ON books FOR SELECT USING (true);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='chapters' AND policyname='read_chapters') THEN
    CREATE POLICY read_chapters ON chapters FOR SELECT USING (true);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='verses' AND policyname='read_verses') THEN
    CREATE POLICY read_verses ON verses FOR SELECT USING (true);
  END IF;
END $$;

-- No insert/update/delete policies for anon; service role bypasses RLS.
