import fs from 'node:fs';
import path from 'node:path';

/*
Reads `data/doctrine-and-covenants.json` (sections-based) and outputs a normalized JSON
with a single book having chapters[] with verses[].

Output file: `data/dandc_normalized.json`
Schema:
{
  book: "Doctrine & Covenants",
  order: 1,
  chapters: [
    { number: 1, verses: [ { number: 1, text: "..." }, ... ] },
    ...
  ]
}
*/

function main() {
  const inputPath = path.join('data', 'doctrine-and-covenants.json');
  const outPath = path.join('data', 'dandc_normalized.json');
  const raw = JSON.parse(fs.readFileSync(inputPath, 'utf-8')) as {
    sections: Array<{ section: number; verses: Array<{ verse: number; text: string }> }>;
  };
  const chapters = (raw.sections ?? []).map((s) => ({
    number: s.section,
    verses: (s.verses ?? []).map((v) => ({ number: v.verse, text: v.text })),
  }));

  const normalized = {
    book: 'Doctrine & Covenants',
    order: 1,
    chapters,
  };
  fs.writeFileSync(outPath, JSON.stringify(normalized, null, 2));
  console.log(`Wrote normalized D&C to ${outPath} with ${chapters.length} chapters.`);
}

main();
