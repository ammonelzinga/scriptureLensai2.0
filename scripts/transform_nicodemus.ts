import fs from 'node:fs';
import path from 'node:path';

/*
Parses `data/GospelOfNicodemus.txt` into normalized JSON suitable for AI chunking.

Input format characteristics:
- Chapter headers like: `CHAPTER I.` (Roman numerals)
- Optional guide lines: indented lines starting with numbers describing themes
- Verses: numbered lines like `2  And said, ...`; the first verse block may be unnumbered text

Output file: `data/nicodemus_normalized.json`
Schema:
{
  book: "Gospel of Nicodemus",
  order: 1,
  chapters: [
    { number: 1, verses: [ { number: 1, text: "..." }, { number: 2, text: "..." }, ... ] },
    ...
  ]
}
*/

function romanToInt(roman: string): number {
  const map: Record<string, number> = { I:1, V:5, X:10, L:50, C:100, D:500, M:1000 };
  let total = 0;
  let prev = 0;
  for (let i = roman.length - 1; i >= 0; i--) {
    const val = map[roman[i]] || 0;
    if (val < prev) total -= val; else total += val;
    prev = val;
  }
  return total;
}

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function parseFile(text: string) {
  const lines = text.split(/\r?\n/);
  const chapters: Array<{ number: number; verses: Array<{ number: number; text: string }> }> = [];
  let currentChapter: { number: number; verses: Array<{ number: number; text: string }> } | null = null;
  let pendingUnnumbered: string[] = [];

  const chapterHeaderRe = /^\s*CHAPTER\s+([IVXLCDM]+)\.?\s*$/i;
  const verseStartRe = /^\s*(\d{1,3})\s{2,}(.*)$/; // number then two+ spaces then text
  const headingLineRe = /^\s*\d+\s(?!\s)(.*)$/; // numeric heading lines with single space (chapter topical guide)

  for (let raw of lines) {
    const line = raw.replace(/\t/g, ' ').trimEnd();
    const chMatch = line.match(chapterHeaderRe);
    if (chMatch) {
      if (currentChapter) {
        if (pendingUnnumbered.length) {
          const textBlock = normalizeWhitespace(pendingUnnumbered.join(' '));
          if (textBlock) currentChapter.verses.push({ number: 1, text: textBlock });
          pendingUnnumbered = [];
        }
        chapters.push(currentChapter);
      }
      const num = romanToInt(chMatch[1].toUpperCase());
      currentChapter = { number: num, verses: [] };
      pendingUnnumbered = [];
      continue;
    }
    if (!currentChapter) continue; // ignore preface until first chapter

    // Skip topical guide heading lines (e.g., "1 Christ accused...", "9 Summoned...") before verses
    if (headingLineRe.test(line)) {
      // Ignore headings; they're not verse content
      continue;
    }

    const cleaned = line.trim();
    if (!cleaned) continue;

    // Fallback: original line-start verse detection
    const vMatch = cleaned.match(verseStartRe);
    if (vMatch) {
      const num = parseInt(vMatch[1], 10);
      const textPart = normalizeWhitespace(vMatch[2] ?? '');
      if (pendingUnnumbered.length) {
        const textBlock = normalizeWhitespace(pendingUnnumbered.join(' '));
        if (textBlock) currentChapter.verses.push({ number: 1, text: textBlock });
        pendingUnnumbered = [];
      }
      currentChapter.verses.push({ number: num, text: textPart });
    } else {
      // No verse number found; continuation behavior
      if (currentChapter.verses.length > 0) {
        const last = currentChapter.verses[currentChapter.verses.length - 1];
        last.text = normalizeWhitespace(`${last.text} ${cleaned}`);
      } else {
        // Accumulate as part of initial unnumbered verse until numbered verses start
        pendingUnnumbered.push(cleaned);
      }
    }
  }
  if (currentChapter) {
    if (pendingUnnumbered.length) {
      const textBlock = normalizeWhitespace(pendingUnnumbered.join(' '));
      if (textBlock) currentChapter.verses.push({ number: 1, text: textBlock });
      pendingUnnumbered = [];
    }
    chapters.push(currentChapter);
  }
  return { book: 'Gospel of Nicodemus', order: 1, chapters };
}

function main() {
  const inputPath = path.join('data', 'GospelOfNicodemus.txt');
  const outPath = path.join('data', 'nicodemus_normalized.json');
  const text = fs.readFileSync(inputPath, 'utf-8');
  const normalized = parseFile(text);
  fs.writeFileSync(outPath, JSON.stringify(normalized, null, 2));
  console.log(`Wrote normalized Nicodemus to ${outPath} with ${normalized.chapters.length} chapters.`);
}

main();
