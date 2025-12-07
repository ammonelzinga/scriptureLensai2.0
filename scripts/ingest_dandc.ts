import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import { openai as sharedOpenAI, CHUNKING_PROMPT } from '../src/lib/openai.ts';
import crypto from 'node:crypto';

type Verse = { id: string; book_id: string; book_name: string; chapter: number; verse: number; text: string };
async function ensureChapter(supabase: any, book_id: string, seq: number, title?: string): Promise<string> {
  const { data: rows, error } = await supabase.from('chapters').select('id').eq('book_id', book_id).eq('seq', seq).limit(1);
  if (error) throw error;
  if (rows && rows.length) return rows[0].id as string;
  const { data: ins, error: insErr } = await supabase.from('chapters').insert([{ book_id, seq, title }] as any).select('id').limit(1);
  if (insErr) throw insErr;
  return ins![0].id as string;
}

async function upsertVersesForChunks(supabase: any, embedded: Chunk[], bookId: string, bookName: string, chunkIdByHash: Map<string, string>, verses: Verse[]) {
  // Build text lookup
  const textByKey = new Map<string, string>();
  for (const v of verses) textByKey.set(`${bookName}:${v.chapter}:${v.verse}`, v.text);
  // Ensure chapters
  const seen = new Set<string>();
  const promises: Promise<string>[] = [];
  for (const c of embedded) {
    for (let ch = c.start_chapter; ch <= c.end_chapter; ch++) {
      const key = `${bookId}:${ch}`;
      if (seen.has(key)) continue;
      seen.add(key);
      promises.push(ensureChapter(supabase, bookId, ch));
    }
  }
  await Promise.all(promises);
  // Build verse rows
  const verseRows: Array<{ book_id: string; chapter_seq: number; verse_seq: number; text: string; chunk_id: string }> = [];
  for (const c of embedded) {
    const refs = c.verse_ids.map((id) => {
      const parts = id.split(':');
      return { chapter: parseInt(parts[1], 10), verse: parseInt(parts[2], 10) };
    });
    const chapter_numbers = refs.map((r) => r.chapter);
    const verse_numbers = refs.map((r) => r.verse);
    const combined_hash = crypto.createHash('sha1').update(`${bookId}|${chapter_numbers.join(',')}|${verse_numbers.join(',')}`).digest('hex');
    const chunkUuid = chunkIdByHash.get(combined_hash);
    if (!chunkUuid) continue;
    for (const r of refs) {
      const text = textByKey.get(`${bookName}:${r.chapter}:${r.verse}`) ?? '';
      verseRows.push({ book_id: bookId, chapter_seq: r.chapter, verse_seq: r.verse, text, chunk_id: chunkUuid });
    }
  }
  if (verseRows.length) {
    const { error } = await supabase.from('verses').upsert(verseRows as any, { onConflict: 'book_id,chapter_seq,verse_seq' });
    if (error) throw error;
  }
}
type BookFile = { book?: string; order?: number; chapters?: Array<{ number: number; verses: Array<{ number: number; text: string }> }> };

type AIPearlChunk = {
  chapter_numbers: number[];
  verse_numbers: number[];
  combined_text: string;
  verses: { chapter: number; verse: number }[];
};

type Chunk = {
  id: string;
  chunk_index: number;
  text: string;
  token_count: number;
  book_id: string;
  book_name: string;
  start_chapter: number;
  start_verse: number;
  end_chapter: number;
  end_verse: number;
  verse_ids: string[];
  embedding?: number[];
};

function approxTokenCount(s: string): number {
  return Math.ceil(s.trim().split(/\s+/).length * 1.3);
}

function readDandCNormalized(filePath: string): Verse[] {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as BookFile;
  const book = raw.book ?? 'Doctrine & Covenants';
  const verses: Verse[] = [];
  for (const ch of raw.chapters ?? []) {
    for (const v of ch.verses ?? []) {
      verses.push({
        id: `${book}:${ch.number}:${v.number}`,
        book_id: book,
        book_name: book,
        chapter: ch.number,
        verse: v.number,
        text: v.text,
      });
    }
  }
  return verses;
}

async function aiChunkChapter(openaiClient: OpenAI, bookName: string, chapterNumber: number, verses: Verse[], cacheDir?: string, strictJson = false, maxRetries = 2): Promise<AIPearlChunk[]> {
  const cachePath = cacheDir ? path.join(cacheDir, `${bookName}_ch${chapterNumber}.json`) : undefined;
  const rawPath = cacheDir ? path.join(cacheDir, `${bookName}_ch${chapterNumber}_raw.txt`) : undefined;
  if (cachePath && fs.existsSync(cachePath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as AIPearlChunk[];
      return cached;
    } catch {}
  }
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
      parsed = { chunks: [] };
    }
    arr = Array.isArray(parsed) ? parsed : (parsed.chunks ?? []);
    if (Array.isArray(arr) && arr.length > 0) break;
    if (attempt >= maxRetries) break;
    await new Promise((r) => setTimeout(r, 300 + Math.floor(Math.random() * 250)));
  }
  if (cachePath) {
    const dir = path.dirname(cachePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(arr, null, 2));
  }
  return arr as AIPearlChunk[];
}

async function main() {
  const args = process.argv.slice(2);
  const normalizedPath = args.includes('--inputFile') ? args[args.indexOf('--inputFile') + 1] : 'data/dandc_normalized.json';
  const outDir = args.includes('--outDir') ? args[args.indexOf('--outDir') + 1] : 'data/chunks_dandc';
  const cacheRoot = 'data/chunks_cache_dandc';
  const strictJson = args.includes('--strictJson');
  const doEmbed = args.includes('--embed');

  const verses = readDandCNormalized(normalizedPath);
  const bookName = 'Doctrine & Covenants';
  const chapters = new Map<number, Verse[]>();
  for (const v of verses) {
    if (!chapters.has(v.chapter)) chapters.set(v.chapter, []);
    chapters.get(v.chapter)!.push(v);
  }

  const openaiClient = sharedOpenAI ?? new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const chunks: Chunk[] = [];
  let chunkIndex = 0;
  for (const [chNum, chVerses] of [...chapters.entries()].sort((a,b)=>a[0]-b[0])) {
    const aiChunks = await aiChunkChapter(openaiClient, bookName, chNum, chVerses, path.join(cacheRoot, bookName), strictJson, 2);
    for (const c of aiChunks) {
      const text = c.combined_text;
      const token_count = approxTokenCount(text);
      const refs = c.verses.length ? c.verses : c.verse_numbers.map((vn) => ({ chapter: chNum, verse: vn }));
      const firstRef = refs[0];
      const lastRef = refs[refs.length - 1];
      const firstVerse = chVerses.find((v) => v.chapter === firstRef.chapter && v.verse === firstRef.verse) ?? chVerses[0];
      const id = `${firstVerse.book_id}:${firstRef.chapter}:${firstRef.verse}-${lastRef.chapter}:${lastRef.verse}:${chunkIndex}`;
      chunks.push({
        id,
        chunk_index: chunkIndex,
        text,
        token_count,
        book_id: firstVerse.book_id,
        book_name: firstVerse.book_name,
        start_chapter: firstRef.chapter,
        start_verse: firstRef.verse,
        end_chapter: lastRef.chapter,
        end_verse: lastRef.verse,
        verse_ids: refs.map((r) => `${firstVerse.book_id}:${r.chapter}:${r.verse}`),
      });
      chunkIndex++;
    }
  }

  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
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
  const outPath = path.join(outDir, `${bookName}.json`);
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
  console.log(`Wrote D&C chunks to ${outPath} (${chunks.length} chunks).`);

  // Optional: embed and upsert to Supabase following pearl ingest style
  if (doEmbed) {
    const openai = sharedOpenAI ?? new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    // Embed
    const model = process.env.EMBEDDING_MODEL ?? 'text-embedding-3-small';
    const res = await openai.embeddings.create({ model, input: chunks.map((c) => c.text), dimensions: 512 });
    const vectors = res.data.map((d) => d.embedding as number[]);
    const embedded = chunks.map((c, i) => ({ ...c, embedding: vectors[i] }));

    // Supabase and lineage
    const supabase = createClient(process.env.SUPABASE_URL as string, process.env.SUPABASE_SERVICE_ROLE_KEY as string);
    // Ensure lineage minimal: traditions/sources/works/books — reuse single book
    const tName = 'Christian';
    const sName = 'Church of Jesus Christ of Latter-day Saints';
    const wName = 'Doctrine & Covenants';
    const { data: tRows } = await supabase.from('traditions').select('id').eq('name', tName).limit(1);
    const tId = (tRows && tRows[0]?.id) || (await supabase.from('traditions').insert([{ name: tName }] as any).select('id')).data?.[0]?.id;
    const { data: sRows } = await supabase.from('sources').select('id').eq('name', sName).eq('tradition_id', tId).limit(1);
    const sId = (sRows && sRows[0]?.id) || (await supabase.from('sources').insert([{ name: sName, tradition_id: tId }] as any).select('id')).data?.[0]?.id;
    const { data: wRows } = await supabase.from('works').select('id').eq('name', wName).eq('source_id', sId).limit(1);
    const wId = (wRows && wRows[0]?.id) || (await supabase.from('works').insert([{ name: wName, source_id: sId }] as any).select('id')).data?.[0]?.id;
    const { data: bRows } = await supabase.from('books').select('id').eq('work_id', wId).eq('seq', 1).limit(1);
    const bId = (bRows && bRows[0]?.id) || (await supabase.from('books').insert([{ title: wName, work_id: wId, seq: 1 }] as any).select('id')).data?.[0]?.id;

    const rows = embedded.map((c) => {
      const refs = c.verse_ids.map((id) => {
        const parts = id.split(':');
        return { chapter: parseInt(parts[1], 10), verse: parseInt(parts[2], 10) };
      });
      const chapter_numbers = refs.map((r) => r.chapter);
      const verse_numbers = refs.map((r) => r.verse);
      const combined_text = c.text;
      const combined_hash = crypto.createHash('sha1').update(`${bId}|${chapter_numbers.join(',')}|${verse_numbers.join(',')}`).digest('hex');
      return {
        book_id: bId,
        start_chapter: c.start_chapter,
        end_chapter: c.end_chapter,
        verse_numbers,
        chapter_numbers,
        combined_text,
        embedding: c.embedding,
        combined_hash,
      };
    });
    const { data, error } = await supabase.from('embedding_chunks').upsert(rows as any, { onConflict: 'combined_hash' }).select('id, combined_hash');
    if (error) throw error;
    console.log(`Upserted ${data?.length ?? 0} D&C chunks to Supabase.`);
    // Link verses and ensure chapters
    const map = new Map<string, string>();
    for (const r of data ?? []) map.set(r.combined_hash, r.id);
    await upsertVersesForChunks(supabase, embedded, bId, bookName, map, verses);
    console.log(`Upserted verses and ensured chapters for D&C.`);
  }
}

main();
