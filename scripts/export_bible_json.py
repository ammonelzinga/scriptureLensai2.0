"""Export per-book JSON files from KJV book .txt outputs or directly from master Bible file.

Usage (PowerShell):
  # From previously split book text files
  python scripts/export_bible_json.py --books-dir "C:\\Path\\To\\Books" --output-dir "C:\\Path\\To\\JSON"

  # From master file (will internally split like split_bible_kjv.py)
  python scripts/export_bible_json.py --input "C:\\Path\\BibleKJV.txt" --output-dir "C:\\Path\\To\\JSON"

  # Upload each book JSON via site API (requires UPLOAD_PASSWORD and API base)
  python scripts/export_bible_json.py --books-dir "C:\\Path\\Books" --upload --api-url "http://localhost:3000/api/upload" --password "searchponderpray"

Outputs per-book JSON files shaped as:
{
  "book": "Genesis",
  "order": 1,
  "chapters": [
    { "number": 1, "verses": [ { "number": 1, "text": "In the beginning..." }, ... ] },
    ...
  ]
}
If --upload is supplied, instead of writing JSON it posts each book structure to the upload API (which now accepts JSON) to trigger insertion + embeddings.
"""
from __future__ import annotations
import argparse
import json
import re
from pathlib import Path
from typing import List, Dict
import os
import sys
import requests

BOOKS = [
    "Genesis","Exodus","Leviticus","Numbers","Deuteronomy","Joshua","Judges","Ruth",
    "1 Samuel","2 Samuel","1 Kings","2 Kings","1 Chronicles","2 Chronicles","Ezra","Nehemiah","Esther","Job",
    "Psalms","Proverbs","Ecclesiastes","Song of Solomon","Isaiah","Jeremiah","Lamentations","Ezekiel","Daniel",
    "Hosea","Joel","Amos","Obadiah","Jonah","Micah","Nahum","Habakkuk","Zephaniah","Haggai","Zechariah","Malachi",
    "Matthew","Mark","Luke","John","Acts","Romans","1 Corinthians","2 Corinthians","Galatians","Ephesians","Philippians","Colossians",
    "1 Thessalonians","2 Thessalonians","1 Timothy","2 Timothy","Titus","Philemon","Hebrews","James","1 Peter","2 Peter","1 John","2 John","3 John","Jude","Revelation"
]
BOOK_INDEX = {b:i+1 for i,b in enumerate(BOOKS)}

CHAPTER_RE = re.compile(r"^Chapter\s+(\d+)$", re.IGNORECASE)
VERSE_RE = re.compile(r"^(\d+)\s+(.*)$")
# Numbered master format patterns
BOOK_HEADING_RE = re.compile(r"^BOOK\s+(\d{1,2})\s+(.+)$", re.IGNORECASE)
NUM_VERSE_RE = re.compile(r"^(\d{2}):(\d{3}):(\d{3})\s+(.*)$")

class Verse(Dict):
    number: int
    text: str
class Chapter(Dict):
    number: int
    verses: List[Verse]
class BookJSON(Dict):
    book: str
    order: int
    chapters: List[Chapter]


def parse_book_txt(path: Path) -> BookJSON:
    book_name = path.stem
    # Restore spaces for multi-word books (split script removed them); attempt match
    for b in BOOKS:
        if b.replace(' ', '') == book_name:
            book_name = b
            break
    lines = path.read_text(encoding='utf-8').splitlines()
    chapters: List[Chapter] = []
    current_chapter: Chapter | None = None
    last_verse: Verse | None = None
    for ln in lines:
        ln = ln.strip()
        if not ln:
            continue
        m_ch = CHAPTER_RE.match(ln)
        if m_ch:
            num = int(m_ch.group(1))
            current_chapter = { 'number': num, 'verses': [] }
            chapters.append(current_chapter)
            last_verse = None
            continue
        m_vs = VERSE_RE.match(ln)
        if m_vs and current_chapter:
            vnum = int(m_vs.group(1))
            vtext = m_vs.group(2).strip()
            verse = { 'number': vnum, 'text': vtext }
            current_chapter['verses'].append(verse)
            last_verse = verse
            continue
        # Continuation line for previous verse
        if last_verse:
            last_verse['text'] = last_verse['text'] + ' ' + ln
    return { 'book': book_name, 'order': BOOK_INDEX.get(book_name, 0), 'chapters': chapters }


def detect_numbered_format(lines: List[str]) -> bool:
    verses = sum(1 for ln in lines if NUM_VERSE_RE.match(ln))
    books = sum(1 for ln in lines if BOOK_HEADING_RE.match(ln))
    return verses > 200 and books > 30


def parse_master_numbered(lines: List[str]) -> Dict[str, BookJSON]:
    books: Dict[str, BookJSON] = { b: { 'book': b, 'order': BOOK_INDEX[b], 'chapters': [] } for b in BOOKS }
    current_book: str | None = None
    current_chapter_num: int | None = None
    last_verse: Verse | None = None
    for ln in lines:
        ln = ln.rstrip()
        if not ln.strip():
            continue
        bh = BOOK_HEADING_RE.match(ln.strip())
        if bh:
            num = int(bh.group(1))
            name_part = bh.group(2).strip()
            # Match by name else by ordinal
            match = None
            for b in BOOKS:
                if b.lower() == name_part.lower():
                    match = b
                    break
            if match is None and 1 <= num <= len(BOOKS):
                match = BOOKS[num-1]
            current_book = match
            current_chapter_num = None
            last_verse = None
            continue
        mv = NUM_VERSE_RE.match(ln)
        if mv:
            book_num = int(mv.group(1))
            ch_raw = mv.group(2)
            vs_raw = mv.group(3)
            text = mv.group(4).strip()
            chapter = int(ch_raw.lstrip('0') or '0')
            verse = int(vs_raw.lstrip('0') or '0')
            if current_book is None or current_book != BOOKS[book_num-1]:
                current_book = BOOKS[book_num-1]
                current_chapter_num = None
                last_verse = None
            bstruct = books[current_book]
            if current_chapter_num != chapter:
                current_chapter_num = chapter
                bstruct['chapters'].append({ 'number': chapter, 'verses': [] })
                last_verse = None
            ch_struct = bstruct['chapters'][-1]
            verse_obj: Verse = { 'number': verse, 'text': text }
            ch_struct['verses'].append(verse_obj)
            last_verse = verse_obj
            continue
        # Continuation line
        if last_verse:
            last_verse['text'] = last_verse['text'] + ' ' + ln.strip()
    # Trim empty chapters if any
    for b in BOOKS:
        chapters = books[b]['chapters']
        books[b]['chapters'] = [c for c in chapters if c['verses']]
    return books


def write_json(book: BookJSON, out_dir: Path):
    out_path = out_dir / f"{book['book'].replace(' ', '')}.json"
    out_path.write_text(json.dumps(book, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f"Wrote JSON {book['book']} -> {out_path}")


def upload_book(book: BookJSON, api_url: str, password: str, tradition: str, source: str, work: str):
    payload = {
        'tradition': tradition,
        'source': source,
        'work': work,
        'book': {
            'title': book['book'],
            'chapters': [
                {
                    'number': ch['number'],
                    'verses': [ {'number': v['number'], 'text': v['text']} for v in ch['verses'] ]
                } for ch in book['chapters']
            ]
        }
    }
    headers = { 'Content-Type': 'application/json', 'x-upload-password': password }
    r = requests.post(api_url, headers=headers, data=json.dumps(payload))
    if r.status_code >= 300:
        print(f"Upload failed {book['book']}: {r.status_code} {r.text}")
    else:
        print(f"Uploaded {book['book']}: {r.status_code}")


def main():
    p = argparse.ArgumentParser(description='Export Bible books to JSON and optionally upload.')
    p.add_argument('--input', help='Master Bible file (numbered or plain)')
    p.add_argument('--books-dir', help='Directory containing per-book .txt files (from split_bible_kjv.py)')
    p.add_argument('--output-dir', help='Directory to write JSON files', required=False)
    p.add_argument('--upload', action='store_true', help='Upload each book JSON via API instead of / in addition to writing files')
    p.add_argument('--api-url', default='http://localhost:3000/api/upload', help='Upload API endpoint URL')
    p.add_argument('--password', default=os.environ.get('UPLOAD_PASSWORD','searchponderpray'), help='Upload password header value')
    p.add_argument('--tradition', default='KJV', help='Tradition name')
    p.add_argument('--source', default='KJV Source', help='Source name')
    p.add_argument('--work', default='Holy Bible', help='Work name')
    args = p.parse_args()

    if not args.input and not args.books_dir:
        print('ERROR: Provide either --input or --books-dir.')
        sys.exit(1)

    books: Dict[str, BookJSON] = {}

    if args.input:
        master_path = Path(args.input)
        if not master_path.exists():
            print(f"Input file not found: {master_path}")
            sys.exit(1)
        lines = master_path.read_text(encoding='utf-8').splitlines()
        if detect_numbered_format(lines):
            books = parse_master_numbered(lines)
        else:
            print('Non-numbered master parsing not implemented; run split script first.')
            sys.exit(1)
    else:
        books_dir = Path(args.books_dir)
        if not books_dir.exists():
            print(f"Books dir not found: {books_dir}")
            sys.exit(1)
        for b in BOOKS:
            txt_path = books_dir / f"{b.replace(' ', '')}.txt"
            if not txt_path.exists():
                print(f"WARNING: Missing book txt {txt_path}")
                continue
            books[b] = parse_book_txt(txt_path)

    out_dir = Path(args.output_dir) if args.output_dir else None
    if out_dir:
        out_dir.mkdir(parents=True, exist_ok=True)

    for b in BOOKS:
        if b not in books:
            continue
        book_json = books[b]
        if out_dir:
            write_json(book_json, out_dir)
        if args.upload:
            upload_book(book_json, args.api_url, args.password, args.tradition, args.source, args.work)

    print('Done.')

if __name__ == '__main__':
    main()
