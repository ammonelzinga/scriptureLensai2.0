import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import { openai as sharedOpenAI, CHUNKING_PROMPT, embedMany } from '../src/lib/openai.ts';
import crypto from 'node:crypto';

type Verse = {
  id: string;
  book_id: string;
  work_id: string;
  source_id: string;
  tradition_id: string;
  book_name: string;
  work_name: string;
  source_name: string;
  tradition_name: string;
  chapter: number;
  verse: number;
  text: string;
};

type BookFile = {
  book_id?: string;
  book_name?: string;
  work_id?: string;
  work_name?: string;
  source_id?: string;
  source_name?: string;
  tradition_id?: string;
  tradition_name?: string;
  verses?: Verse[];
  // Alternate format as produced by pearl transformer
  book?: string;
  order?: number;
  chapters?: Array<{ number: number; verses: Array<{ number: number; text: string }> }>;
};

type Chunk = {
  id: string;
  chunk_index: number;
  text: string;
  token_count: number;
  book_id: string;
  work_id: string;
  source_id: string;
  tradition_id: string;
  book_name: string;
  work_name: string;
  source_name: string;
  tradition_name: string;
  start_chapter: number;
  start_verse: number;
  end_chapter: number;
  end_verse: number;
  verse_ids: string[];
  embedding?: number[];
};

function getEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

function readPearlJsonFiles(dir: string): BookFile[] {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  return files.map((f) => {
    const content = fs.readFileSync(path.join(dir, f), 'utf-8');
    const raw = JSON.parse(content) as BookFile;
    // If already normalized with verses, return as-is
    if (raw.verses && Array.isArray(raw.verses)) return raw;
    // Else transform chapters -> verses
    const book_name = raw.book ?? path.basename(f, '.json');
    const verses: Verse[] = [];
    for (const ch of raw.chapters ?? []) {
      for (const v of ch.verses ?? []) {
        verses.push({
          id: `${book_name}:${ch.number}:${v.number}`,
          book_id: raw.book_id ?? book_name,
          work_id: raw.work_id ?? (raw.work_name ?? 'Pearl of Great Price'),
          source_id: raw.source_id ?? (raw.source_name ?? 'Church of Jesus Christ of Latter-day Saints'),
          tradition_id: raw.tradition_id ?? (raw.tradition_name ?? 'Christian'),
          book_name: raw.book_name ?? book_name,
          work_name: raw.work_name ?? 'Pearl of Great Price',
          source_name: raw.source_name ?? 'Church of Jesus Christ of Latter-day Saints',
          tradition_name: raw.tradition_name ?? 'Christian',
          chapter: ch.number,
          verse: v.number,
          text: v.text,
        });
      }
    }
    return {
      book_id: raw.book_id,
      book_name,
      work_id: raw.work_id,
      work_name: raw.work_name,
      source_id: raw.source_id,
      source_name: raw.source_name,
      tradition_id: raw.tradition_id,
      tradition_name: raw.tradition_name,
      verses,
    } as BookFile;
  });
}

function approxTokenCount(s: string): number {
  return Math.ceil(s.trim().split(/\s+/).length * 1.3);
}

// Heuristic local chunker (fallback when AI chunking is disabled)
function makeChunks(verses: Verse[], targetTokens = 500, overlapTokens = 50): Chunk[] {
  const chunks: Chunk[] = [];
  let buffer: Verse[] = [];
  let bufferTokens = 0;
  let chunkIndex = 0;

  const flush = () => {
    if (buffer.length === 0) return;
    const text = buffer.map((v) => v.text).join('\n');
    const token_count = approxTokenCount(text);
    const first = buffer[0];
    const last = buffer[buffer.length - 1];
    const id = `${first.book_id}:${first.chapter}:${first.verse}-${last.chapter}:${last.verse}:${chunkIndex}`;
    chunks.push({
      id,
      chunk_index: chunkIndex,
      text,
      token_count,
      book_id: first.book_id,
      work_id: first.work_id,
      source_id: first.source_id,
      tradition_id: first.tradition_id,
      book_name: first.book_name,
      work_name: first.work_name,
      source_name: first.source_name,
      tradition_name: first.tradition_name,
      start_chapter: first.chapter,
      start_verse: first.verse,
      end_chapter: last.chapter,
      end_verse: last.verse,
      verse_ids: buffer.map((v) => v.id),
    });
    chunkIndex++;
  };

  for (const v of verses) {
    const vt = approxTokenCount(v.text);
    if (bufferTokens + vt > targetTokens && buffer.length > 0) {
      flush();
      const overlap: Verse[] = [];
      let overlapSum = 0;
      for (let i = buffer.length - 1; i >= 0; i--) {
        const t = approxTokenCount(buffer[i].text);
        if (overlapSum + t > overlapTokens) break;
        overlap.unshift(buffer[i]);
        overlapSum += t;
      }
      buffer = [...overlap];
      bufferTokens = overlapSum;
    }
    buffer.push(v);
    bufferTokens += vt;
  }
  flush();
  return chunks;
}

type AIPearlChunk = {
  chapter_numbers: number[];
  verse_numbers: number[];
  combined_text: string;
  verses: { chapter: number; verse: number }[];
};

async function aiChunkChapter(openaiClient: OpenAI, bookName: string, chapterNumber: number, verses: Verse[], cacheDir?: string, strictJson = false, maxRetries = 2): Promise<AIPearlChunk[]> {
  // Check cache first
  const cachePath = cacheDir ? path.join(cacheDir, `${bookName}_ch${chapterNumber}.json`) : undefined;
  if (cachePath && fs.existsSync(cachePath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as AIPearlChunk[];
      return cached;
    } catch {}
  }
  const rawPath = cacheDir ? path.join(cacheDir, `${bookName}_ch${chapterNumber}_raw.txt`) : undefined;
  const userPayload = JSON.stringify({
    book: bookName,
    chapter: chapterNumber,
    verses: verses.map((v) => ({ verse: v.verse, text: v.text })),
  });
  const model = process.env.CHUNKING_MODEL ?? process.env.OPENAI_CHAT_MODEL ?? 'gpt-4.1';
  let arr: any[] = [];
  let attempt = 0;
  for (;;) {
    attempt++;
    const resp = await openaiClient.chat.completions.create({
      model,
      temperature: 0,
      messages: [
        { role: 'system', content: CHUNKING_PROMPT },
        { role: 'user', content: userPayload },
      ],
      ...(strictJson ? { response_format: { type: 'json_object' } } : {}),
    });
    const content = resp.choices[0]?.message?.content ?? '';
    if (rawPath) {
      try {
        const dir = path.dirname(rawPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(rawPath, content);
      } catch {}
    }
    let parsed: any;
    try {
      parsed = JSON.parse(content);
    } catch {
      console.warn(`[chunk]  Chapter ${chapterNumber}: non-JSON output (attempt ${attempt}). First 240 chars: ${content.slice(0,240)}...`);
      parsed = { chunks: [] };
    }
    arr = Array.isArray(parsed) ? parsed : (parsed.chunks ?? []);
    if (Array.isArray(arr) && arr.length > 0) break;
    if (attempt >= maxRetries) {
      console.warn(`[chunk]  Chapter ${chapterNumber}: 0 chunks after ${attempt} attempts for book ${bookName}.`);
      break;
    }
    await new Promise((r) => setTimeout(r, 300 + Math.floor(Math.random() * 250)));
  }
  // Write cache
  if (cachePath) {
    const dir = path.dirname(cachePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(arr, null, 2));
  }
  return arr as AIPearlChunk[];
}

async function aiMakeChunks(openai: OpenAI, books: BookFile[], cacheRoot?: string, strictJson = false): Promise<Chunk[]> {
  const out: Chunk[] = [];
  let chunkIndex = 0;
  for (const book of books) {
    const bookName = book.book_name ?? book.book ?? 'Unknown Book';
    console.log(`[chunk] Starting book: ${bookName}`);
    // group verses by chapter
    const chapters = new Map<number, Verse[]>();
    for (const v of (book.verses ?? [])) {
      if (!chapters.has(v.chapter)) chapters.set(v.chapter, []);
      chapters.get(v.chapter)!.push(v);
    }
    const chapterEntries = [...chapters.entries()].sort((a,b)=>a[0]-b[0]);
    for (const [chapterNumber, chapterVerses] of chapterEntries) {
      console.log(`[chunk]  Book ${bookName} → Chapter ${chapterNumber} (${chapterVerses.length} verses)`);
      const cacheDir = cacheRoot ? path.join(cacheRoot, bookName) : undefined;
      const aiChunks = await aiChunkChapter(openai, bookName, chapterNumber, chapterVerses, cacheDir, strictJson, 2);
      console.log(`[chunk]   ↳ AI returned ${aiChunks.length} chunks`);
      for (const c of aiChunks) {
        const text = c.combined_text;
        const token_count = approxTokenCount(text);
        const refs = c.verses.length ? c.verses : c.verse_numbers.map((vn) => ({ chapter: chapterNumber, verse: vn }));
        const firstRef = refs[0];
        const lastRef = refs[refs.length - 1];
        const firstVerse = chapterVerses.find((v) => v.chapter === firstRef.chapter && v.verse === firstRef.verse) ?? chapterVerses[0];
        const lastVerse = chapterVerses.find((v) => v.chapter === lastRef.chapter && v.verse === lastRef.verse) ?? chapterVerses[chapterVerses.length - 1];
        const id = `${firstVerse.book_id}:${firstRef.chapter}:${firstRef.verse}-${lastRef.chapter}:${lastRef.verse}:${chunkIndex}`;
        out.push({
          id,
          chunk_index: chunkIndex,
          text,
          token_count,
          book_id: firstVerse.book_id,
          work_id: firstVerse.work_id,
          source_id: firstVerse.source_id,
          tradition_id: firstVerse.tradition_id,
          book_name: firstVerse.book_name,
          work_name: firstVerse.work_name,
          source_name: firstVerse.source_name,
          tradition_name: firstVerse.tradition_name,
          start_chapter: firstRef.chapter,
          start_verse: firstRef.verse,
          end_chapter: lastRef.chapter,
          end_verse: lastRef.verse,
          verse_ids: refs.map((r) => `${firstVerse.book_id}:${r.chapter}:${r.verse}`),
        });
        chunkIndex++;
      }
    }
    console.log(`[chunk] Finished book: ${bookName}`);
  }
  return out;
}

async function embedChunks(openai: OpenAI, chunks: Chunk[]): Promise<Chunk[]> {
  const model = process.env.EMBEDDING_MODEL ?? 'text-embedding-3-small';
  const res = await openai.embeddings.create({ model, input: chunks.map((c) => c.text), dimensions: 512 });
  const vectors = res.data.map((d) => d.embedding as number[]);
  return chunks.map((c, i) => ({ ...c, embedding: vectors[i] }));
}

// ---- Lineage helpers: ensure tradition/source/work/book UUIDs exist and return ids ----
async function ensureTradition(supabase: any, name: string): Promise<string> {
  const { data: rows, error } = await supabase.from('traditions').select('id').eq('name', name).limit(1);
  if (error) throw error;
  const existing = (rows ?? []) as Array<{ id: string }>;
  if (existing.length) return existing[0].id;
  const { data: ins, error: insErr } = await supabase.from('traditions').insert([{ name }] as any).select('id').limit(1);
  if (insErr) throw insErr;
  const inserted = (ins ?? []) as Array<{ id: string }>;
  return inserted[0].id;
}

async function ensureSource(supabase: any, tradition_id: string, name: string): Promise<string> {
  const { data: rows, error } = await supabase.from('sources').select('id').eq('tradition_id', tradition_id).eq('name', name).limit(1);
  if (error) throw error;
  const existing = (rows ?? []) as Array<{ id: string }>;
  if (existing.length) return existing[0].id;
  const { data: ins, error: insErr } = await supabase.from('sources').insert([{ tradition_id, name }] as any).select('id').limit(1);
  if (insErr) throw insErr;
  const inserted = (ins ?? []) as Array<{ id: string }>;
  return inserted[0].id;
}

async function ensureWork(supabase: any, source_id: string, name: string): Promise<string> {
  const { data: rows, error } = await supabase.from('works').select('id').eq('source_id', source_id).eq('name', name).limit(1);
  if (error) throw error;
  const existing = (rows ?? []) as Array<{ id: string }>;
  if (existing.length) return existing[0].id;
  const { data: ins, error: insErr } = await supabase.from('works').insert([{ source_id, name }] as any).select('id').limit(1);
  if (insErr) throw insErr;
  const inserted = (ins ?? []) as Array<{ id: string }>;
  return inserted[0].id;
}

async function ensureBook(supabase: any, work_id: string, seq: number, title: string): Promise<string> {
  const { data: rows, error } = await supabase.from('books').select('id').eq('work_id', work_id).eq('seq', seq).limit(1);
  if (error) throw error;
  const existing = (rows ?? []) as Array<{ id: string }>;
  if (existing.length) return existing[0].id;
  const { data: ins, error: insErr } = await supabase.from('books').insert([{ work_id, seq, title }] as any).select('id').limit(1);
  if (insErr) throw insErr;
  const inserted = (ins ?? []) as Array<{ id: string }>;
  return inserted[0].id;
}

async function ensureChapter(supabase: any, book_id: string, seq: number, title?: string): Promise<string> {
  const { data: rows, error } = await supabase.from('chapters').select('id').eq('book_id', book_id).eq('seq', seq).limit(1);
  if (error) throw error;
  const existing = (rows ?? []) as Array<{ id: string }>;
  if (existing.length) return existing[0].id;
  const { data: ins, error: insErr } = await supabase.from('chapters').insert([{ book_id, seq, title }] as any).select('id').limit(1);
  if (insErr) throw insErr;
  const inserted = (ins ?? []) as Array<{ id: string }>;
  return inserted[0].id;
}

async function upsertChunks(supabase: any, chunks: Chunk[]) {
  const rows = chunks.map((c) => {
    const refs = c.verse_ids.map((id) => {
      const parts = id.split(':');
      return { chapter: parseInt(parts[1], 10), verse: parseInt(parts[2], 10) };
    });
    const chapter_numbers = refs.map((r) => r.chapter);
    const verse_numbers = refs.map((r) => r.verse);
    const combined_text = c.text;
    const combined_hash = crypto
      .createHash('sha1')
      .update(`${c.book_id}|${chapter_numbers.join(',')}|${verse_numbers.join(',')}`)
      .digest('hex');
    return {
      book_id: c.book_id,
      start_chapter: c.start_chapter,
      end_chapter: c.end_chapter,
      verse_numbers,
      chapter_numbers,
      combined_text,
      embedding: c.embedding,
      combined_hash,
    };
  });
  const { data, error } = await supabase
    .from('embedding_chunks')
    .upsert(rows as any, { onConflict: 'combined_hash' })
    .select('id, combined_hash');
  if (error) throw error;
  return data as { id: string; combined_hash: string }[];
}

// Insert verses rows linked to chunks; ensure chapters exist
async function upsertVersesForChunks(supabase: any, chunks: Chunk[], books: BookFile[], chunkIdByHash: Map<string, string>) {
  // Precompute verse text lookup per book/chapter/verse
  const textByKey = new Map<string, string>();
  for (const b of books) {
    const bookName = b.book_name ?? b.book ?? 'Unknown Book';
    for (const v of b.verses ?? []) {
      textByKey.set(`${bookName}:${v.chapter}:${v.verse}`, v.text);
    }
  }
  // Ensure chapters exist per chunk range
  const chapterEnsures: Array<Promise<string>> = [];
  const seenChapters = new Set<string>();
  for (const c of chunks) {
    for (let ch = c.start_chapter; ch <= c.end_chapter; ch++) {
      const key = `${c.book_id}:${ch}`;
      if (seenChapters.has(key)) continue;
      seenChapters.add(key);
      // No chapter titles available from cache; pass undefined
      chapterEnsures.push(ensureChapter(supabase, c.book_id, ch));
    }
  }
  await Promise.all(chapterEnsures);

  // Build verse rows
  const verseRows: Array<{ book_id: string; chapter_seq: number; verse_seq: number; text: string; chunk_id: string }> = [];
  for (const c of chunks) {
    const refs = c.verse_ids.map((id) => {
      const parts = id.split(':');
      return { chapter: parseInt(parts[1], 10), verse: parseInt(parts[2], 10) };
    });
    // Compute combined_hash same way as upsertChunks to find the actual chunk UUID
    const chapter_numbers = refs.map((r) => r.chapter);
    const verse_numbers = refs.map((r) => r.verse);
    const combined_hash = (await import('node:crypto')).createHash('sha1').update(`${c.book_id}|${chapter_numbers.join(',')}|${verse_numbers.join(',')}`).digest('hex');
    const chunkUuid = chunkIdByHash.get(combined_hash);
    if (!chunkUuid) {
      console.warn(`[verses] Missing chunk UUID for hash ${combined_hash}; skipping verse linkage.`);
      continue;
    }
    for (const r of refs) {
      const text = textByKey.get(`${c.book_name}:${r.chapter}:${r.verse}`) ?? '';
      verseRows.push({ book_id: c.book_id, chapter_seq: r.chapter, verse_seq: r.verse, text, chunk_id: chunkUuid });
    }
  }
  if (verseRows.length) {
    const { error } = await supabase.from('verses').upsert(verseRows as any, { onConflict: 'book_id,chapter_seq,verse_seq' });
    if (error) throw error;
  }
}

async function main() {
  const args = process.argv.slice(2);
  let inputDir = 'data/pearl_json';
  let outFile = 'data/pearl_chunks.json';
  let outDir: string | undefined;
  let dryRun = false;
  let useCache = false;
  let embedFromCache = false;
  // Optional lineage overrides like other ingestion scripts
  let work_id: string | undefined;
  let work_name: string | undefined;
  let source_id: string | undefined;
  let source_name: string | undefined;
  let tradition_id: string | undefined;
  let tradition_name: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--inputDir') inputDir = args[++i];
    else if (args[i] === '--outFile') outFile = args[++i];
    else if (args[i] === '--outDir') outDir = args[++i];
    else if (args[i] === '--dryRun') dryRun = true;
    else if (args[i] === '--useCache') useCache = true;
    else if (args[i] === '--embedFromCache') embedFromCache = true;
    else if (args[i] === '--workId') work_id = args[++i];
    else if (args[i] === '--workName') work_name = args[++i];
    else if (args[i] === '--sourceId') source_id = args[++i];
    else if (args[i] === '--sourceName') source_name = args[++i];
    else if (args[i] === '--traditionId') tradition_id = args[++i];
    else if (args[i] === '--traditionName') tradition_name = args[++i];
  }

  let allChunks: Chunk[] = [];
  // Always read books to have lineage/context available regardless of cache usage
  const books = readPearlJsonFiles(inputDir).map((book) => ({
    ...book,
    verses: (book.verses ?? []).map((v) => ({
      ...v,
      work_id: work_id ?? v.work_id ?? book.work_id,
      work_name: work_name ?? v.work_name ?? book.work_name ?? 'Pearl of Great Price',
      source_id: source_id ?? v.source_id ?? book.source_id,
      source_name: source_name ?? v.source_name ?? book.source_name ?? 'Church of Jesus Christ of Latter-day Saints',
      tradition_id: tradition_id ?? v.tradition_id ?? book.tradition_id,
      tradition_name: tradition_name ?? v.tradition_name ?? book.tradition_name ?? 'Christian',
    })),
  }));
  if (useCache && fs.existsSync(outFile)) {
    const cached = JSON.parse(fs.readFileSync(outFile, 'utf-8')) as { count: number; chunks: Chunk[] };
    allChunks = cached.chunks;
    console.log(`Loaded ${cached.count} chunks from cache ${outFile}`);
  } else {

    const useAIChunking = (process.env.USE_AI_CHUNKING ?? 'true').toLowerCase() === 'true' || args.includes('--aiChunking');
    const openaiForChunking = useAIChunking ? (sharedOpenAI ?? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })) : undefined;
    if (embedFromCache) {
      const cacheRoot = 'data/chunks_cache_pearl';
      console.log(`[cache] Rebuilding from cache at ${cacheRoot}`);
      // Rehydrate chunks from per-chapter caches
      const out: Chunk[] = [];
      let chunkIndex = 0;
      for (const book of books) {
        const bookName = book.book_name ?? book.book ?? 'Unknown Book';
        const bookDir = path.join(cacheRoot, bookName);
        if (!fs.existsSync(bookDir)) continue;
        const files = fs.readdirSync(bookDir).filter((f) => f.endsWith('.json'));
        const versesByChapter = new Map<number, Verse[]>();
        for (const v of (book.verses ?? [])) {
          if (!versesByChapter.has(v.chapter)) versesByChapter.set(v.chapter, []);
          versesByChapter.get(v.chapter)!.push(v);
        }
        for (const f of files) {
          const m = /_ch(\d+)\.json$/.exec(f);
          const chNum = m ? parseInt(m[1], 10) : NaN;
          const chapterVerses = versesByChapter.get(chNum) ?? [];
          const aiChunks = JSON.parse(fs.readFileSync(path.join(bookDir, f), 'utf-8')) as AIPearlChunk[];
          for (const c of aiChunks) {
            const text = c.combined_text;
            const token_count = approxTokenCount(text);
            const refs = c.verses.length ? c.verses : c.verse_numbers.map((vn) => ({ chapter: chNum, verse: vn }));
            const firstRef = refs[0];
            const lastRef = refs[refs.length - 1];
            const firstVerse = chapterVerses.find((v) => v.chapter === firstRef.chapter && v.verse === firstRef.verse) ?? chapterVerses[0];
            const lastVerse = chapterVerses.find((v) => v.chapter === lastRef.chapter && v.verse === lastRef.verse) ?? (chapterVerses.length ? chapterVerses[chapterVerses.length - 1] : firstVerse);
            const id = `${firstVerse.book_id}:${firstRef.chapter}:${firstRef.verse}-${lastRef.chapter}:${lastRef.verse}:${chunkIndex}`;
            out.push({
              id,
              chunk_index: chunkIndex,
              text,
              token_count,
              book_id: firstVerse.book_id,
              work_id: firstVerse.work_id,
              source_id: firstVerse.source_id,
              tradition_id: firstVerse.tradition_id,
              book_name: firstVerse.book_name,
              work_name: firstVerse.work_name,
              source_name: firstVerse.source_name,
              tradition_name: firstVerse.tradition_name,
              start_chapter: firstRef.chapter,
              start_verse: firstRef.verse,
              end_chapter: lastRef.chapter,
              end_verse: lastRef.verse,
              verse_ids: refs.map((r) => `${firstVerse.book_id}:${r.chapter}:${r.verse}`),
            });
            chunkIndex++;
          }
        }
      }
      allChunks = out;
      console.log(`[cache] Rebuilt ${allChunks.length} chunks from cache.`);
    } else if (useAIChunking && openaiForChunking) {
      const cacheRoot = 'data/chunks_cache_pearl';
      const strictJson = (process.env.STRICT_JSON ?? 'false').toLowerCase() === 'true' || args.includes('--strictJson');
      console.log(`[chunk] AI chunking enabled. Processing ${books.length} books...`);
      allChunks = await aiMakeChunks(openaiForChunking, books, cacheRoot, strictJson);
    } else {
      console.log(`[chunk] Heuristic chunking for ${books.length} books...`);
      for (const book of books) {
        console.log(`[chunk] Starting book: ${book.book_name ?? book.book ?? 'Unknown Book'}`);
        const verses = (book.verses ?? []).sort((a, b) => a.chapter - b.chapter || a.verse - b.verse);
        const chunks = makeChunks(verses);
        allChunks.push(...chunks);
        console.log(`[chunk] Finished book with ${chunks.length} chunks`);
      }
    }
    // Per-book outputs if outDir provided, matching other ingest scripts style
    if (outDir) {
      if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
      const byBook = new Map<string, Chunk[]>();
      for (const c of allChunks) {
        const key = c.book_name ?? 'Unknown';
        if (!byBook.has(key)) byBook.set(key, []);
        byBook.get(key)!.push(c);
      }
      for (const [bookName, chunks] of byBook.entries()) {
        console.log(`[write] ${bookName}: ${chunks.length} chunks -> ${outDir}`);
        const payload = {
          book: bookName,
          chunks: chunks.map((c) => ({
            chapter_numbers: [c.start_chapter, c.end_chapter].filter((v, i, a) => a.indexOf(v) === i),
            verse_numbers: c.verse_ids.map((id) => parseInt(id.split(':')[2], 10)),
            combined_text: c.text,
            verses: c.verse_ids.map((id) => {
              const parts = id.split(':');
              return { chapter: parseInt(parts[1], 10), verse: parseInt(parts[2], 10) };
            }),
          })),
        };
        const filePath = path.join(outDir, `${bookName}.json`);
        fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
      }
      console.log(`Wrote per-book chunks to ${outDir}`);
    }
    // Combined output for convenience
    fs.writeFileSync(outFile, JSON.stringify({ count: allChunks.length, chunks: allChunks }, null, 2));
    console.log(`Wrote ${allChunks.length} chunks total to ${outFile}`);
  }

  if (dryRun) {
    console.log('Dry-run: Skipping embedding and Supabase upsert.');
    return;
  }

  const openai = new OpenAI({ apiKey: getEnv('OPENAI_API_KEY') });
  const supabase = createClient(getEnv('SUPABASE_URL'), getEnv('SUPABASE_SERVICE_ROLE_KEY'));

  // Resolve lineage ids so we can use proper UUID book_id values
  const traditionId = await ensureTradition(supabase, books[0]?.verses?.[0]?.tradition_name ?? 'Christian');
  const sourceId = await ensureSource(supabase, traditionId, books[0]?.verses?.[0]?.source_name ?? 'Church of Jesus Christ of Latter-day Saints');
  const workId = await ensureWork(supabase, sourceId, books[0]?.verses?.[0]?.work_name ?? 'Pearl of Great Price');
  // Map book names to UUIDs ensuring seq from original data (fallback to index)
  const bookIdByName = new Map<string, string>();
  const seqByName = new Map<string, number>();
  for (let i = 0; i < books.length; i++) {
    const b = books[i];
    const name = b.book_name ?? b.book ?? `Book_${i+1}`;
    const seq = (b as any).order ?? i + 1;
    seqByName.set(name, seq);
    const id = await ensureBook(supabase, workId, seq, name);
    bookIdByName.set(name, id);
  }

  // Replace string book_id with UUIDs before embedding
  allChunks = allChunks.map((c) => {
    const uuid = bookIdByName.get(c.book_name) ?? c.book_id;
    return { ...c, book_id: uuid };
  });

  const embedded = await embedChunks(openai, allChunks);
  const upserted = await upsertChunks(supabase, embedded);
  console.log(`Upserted ${upserted.length} chunks to Supabase.`);
  // Build map hash->uuid for linking verses
  const chunkIdByHash = new Map<string, string>();
  for (const row of upserted) chunkIdByHash.set(row.combined_hash, row.id);
  // Link verses to chunks (verses table) and ensure chapters
  await upsertVersesForChunks(supabase, embedded, books, chunkIdByHash);
  console.log(`Upserted verses and ensured chapters for ${embedded.length} chunks.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
