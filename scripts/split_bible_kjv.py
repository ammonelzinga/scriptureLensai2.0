"""Split a single UTF-8 KJV Bible text file into 66 book files.

Usage (PowerShell):
  python scripts/split_bible_kjv.py \
    --input "C:\\Users\\ammon\\Documents\\scripturelensAI\\BibleKJV.txt" \
    --output-dir "C:\\Users\\ammon\\Documents\\scripturelensAI"

Assumptions:
 - The source file contains uppercase heading lines marking the start of each book.
 - Headings may include descriptors (e.g., "THE FIRST BOOK OF MOSES: CALLED GENESIS", 
   "THE EPISTLE OF PAUL THE APOSTLE TO THE ROMANS", "THE REVELATION OF ST. JOHN THE DIVINE").
 - We detect a book start by an ALL-UPPERCASE line containing any canonical book name or alias.

This script attempts to be resilient to decorative heading lines. It strips the heading lines
from the output book content, preserving verses and chapter markers.

Output: 66 files (Genesis.txt ... Revelation.txt) encoded UTF-8 in the output directory.
"""

from __future__ import annotations
import re
import argparse
from pathlib import Path
from typing import List, Dict, Tuple

# Canonical KJV book order (66)
BOOKS = [
    "Genesis","Exodus","Leviticus","Numbers","Deuteronomy","Joshua","Judges","Ruth",
    "1 Samuel","2 Samuel","1 Kings","2 Kings","1 Chronicles","2 Chronicles","Ezra","Nehemiah","Esther","Job",
    "Psalms","Proverbs","Ecclesiastes","Song of Solomon","Isaiah","Jeremiah","Lamentations","Ezekiel","Daniel",
    "Hosea","Joel","Amos","Obadiah","Jonah","Micah","Nahum","Habakkuk","Zephaniah","Haggai","Zechariah","Malachi",
    "Matthew","Mark","Luke","John","Acts","Romans","1 Corinthians","2 Corinthians","Galatians","Ephesians","Philippians","Colossians",
    "1 Thessalonians","2 Thessalonians","1 Timothy","2 Timothy","Titus","Philemon","Hebrews","James","1 Peter","2 Peter","1 John","2 John","3 John","Jude","Revelation"
]

# Aliases present in heading lines (uppercase forms)
ALIASES: Dict[str, List[str]] = {
    "Genesis": ["GENESIS"],
    "Exodus": ["EXODUS"],
    "Leviticus": ["LEVITICUS"],
    "Numbers": ["NUMBERS"],
    "Deuteronomy": ["DEUTERONOMY"],
    "Joshua": ["JOSHUA"],
    "Judges": ["JUDGES"],
    "Ruth": ["RUTH"],
    "1 Samuel": ["1 SAMUEL", "FIRST BOOK OF SAMUEL"],
    "2 Samuel": ["2 SAMUEL", "SECOND BOOK OF SAMUEL"],
    "1 Kings": ["1 KINGS", "FIRST BOOK OF KINGS"],
    "2 Kings": ["2 KINGS", "SECOND BOOK OF KINGS"],
    "1 Chronicles": ["1 CHRONICLES", "FIRST BOOK OF CHRONICLES"],
    "2 Chronicles": ["2 CHRONICLES", "SECOND BOOK OF CHRONICLES"],
    "Ezra": ["EZRA"],
    "Nehemiah": ["NEHEMIAH"],
    "Esther": ["ESTHER"],
    "Job": ["JOB"],
    "Psalms": ["PSALM", "PSALMS"],
    "Proverbs": ["PROVERBS"],
    "Ecclesiastes": ["ECCLESIASTES"],
    "Song of Solomon": ["SONG OF SOLOMON", "CANTICLES"],
    "Isaiah": ["ISAIAH"],
    "Jeremiah": ["JEREMIAH"],
    "Lamentations": ["LAMENTATIONS"],
    "Ezekiel": ["EZEKIEL"],
    "Daniel": ["DANIEL"],
    "Hosea": ["HOSEA"],
    "Joel": ["JOEL"],
    "Amos": ["AMOS"],
    "Obadiah": ["OBADIAH"],
    "Jonah": ["JONAH"],
    "Micah": ["MICAH"],
    "Nahum": ["NAHUM"],
    "Habakkuk": ["HABAKKUK"],
    "Zephaniah": ["ZEPHANIAH"],
    "Haggai": ["HAGGAI"],
    "Zechariah": ["ZECHARIAH"],
    "Malachi": ["MALACHI"],
    "Matthew": ["MATTHEW"],
    "Mark": ["MARK"],
    "Luke": ["LUKE"],
    "John": ["JOHN"],
    "Acts": ["ACTS"],
    "Romans": ["ROMANS"],
    "1 Corinthians": ["1 CORINTHIANS", "FIRST EPISTLE OF PAUL THE APOSTLE TO THE CORINTHIANS"],
    "2 Corinthians": ["2 CORINTHIANS", "SECOND EPISTLE OF PAUL THE APOSTLE TO THE CORINTHIANS"],
    "Galatians": ["GALATIANS"],
    "Ephesians": ["EPHESIANS"],
    "Philippians": ["PHILIPPIANS"],
    "Colossians": ["COLOSSIANS"],
    "1 Thessalonians": ["1 THESSALONIANS", "FIRST EPISTLE TO THE THESSALONIANS"],
    "2 Thessalonians": ["2 THESSALONIANS", "SECOND EPISTLE TO THE THESSALONIANS"],
    "1 Timothy": ["1 TIMOTHY", "FIRST EPISTLE TO TIMOTHY"],
    "2 Timothy": ["2 TIMOTHY", "SECOND EPISTLE TO TIMOTHY"],
    "Titus": ["TITUS"],
    "Philemon": ["PHILEMON"],
    "Hebrews": ["HEBREWS"],
    "James": ["JAMES"],
    "1 Peter": ["1 PETER", "FIRST EPISTLE GENERAL OF PETER"],
    "2 Peter": ["2 PETER", "SECOND EPISTLE GENERAL OF PETER"],
    "1 John": ["1 JOHN", "FIRST EPISTLE GENERAL OF JOHN"],
    "2 John": ["2 JOHN", "SECOND EPISTLE OF JOHN"],
    "3 John": ["3 JOHN", "THIRD EPISTLE OF JOHN"],
    "Jude": ["JUDE"],
    "Revelation": ["REVELATION", "REVELATION OF ST. JOHN", "REVELATION OF ST. JOHN THE DIVINE"]
}

# Precompute a mapping from uppercase alias to canonical name
ALIAS_LOOKUP = {}
for canon, aliases in ALIASES.items():
    for a in aliases:
        ALIAS_LOOKUP[a] = canon

UPPER_RE = re.compile(r"^[^a-z]*$")  # line with no lowercase letters

# Additional patterns for numbered source format (BOOK 01 Genesis, 01:001:001 ...)
BOOK_HEADING_RE = re.compile(r"^BOOK\s+(\d{1,2})\s+(.+)$", re.IGNORECASE)
NUM_VERSE_RE = re.compile(r"^(\d{2}):(\d{3}):(\d{3})\s+(.*)$")

def is_heading(line: str) -> str | None:
    """Return canonical book name if this line appears to be a book heading.

    More permissive than the original implementation:
    - Accept mixed case lines (many sources use Title Case headings)
    - Match any alias substring case-insensitively
    - Ignore lines that look like ordinary verse lines (starting with digit or digit:digit)
    - Prefer lines with few lowercase letters (heuristic) but not required.
    """
    raw = line.strip()
    if not raw:
        return None

    # Ignore obvious verse lines
    if VERSE_COLON_RE.match(raw) or VERSE_SIMPLE_RE.match(raw):
        return None

    upper = raw.upper()
    # Clean punctuation for secondary matching
    cleaned = re.sub(r"[\-:,.;'\"()]+", " ", upper)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()

    # Try BOOK heading pattern fallback
    bh = BOOK_HEADING_RE.match(raw)
    if bh:
        name_part = bh.group(2).strip()
        # Match name_part to canonical list case-insensitively
        for b in BOOKS:
            if b.lower() == name_part.lower():
                return b
    for canon, aliases in ALIASES.items():
        for alias in aliases:
            if alias in upper or alias in cleaned:
                return canon
    return None

def detect_numbered_format(lines: List[str]) -> bool:
    """Heuristic: if >= 200 lines match numeric verse pattern and >= 40 BOOK headings, use numbered parser."""
    verse_matches = 0
    book_matches = 0
    for ln in lines:
        if NUM_VERSE_RE.match(ln):
            verse_matches += 1
        if BOOK_HEADING_RE.match(ln):
            book_matches += 1
        if verse_matches > 200 and book_matches > 30:
            return True
    return False

def parse_numbered_format(lines: List[str]) -> Dict[str, List[str]]:
    """Parse file where verses are like 01:001:001 and headings 'BOOK 01 Genesis'.
    Build per-book content with explicit Chapter and verse lines.
    """
    books_content: Dict[str, List[str]] = {b: [] for b in BOOKS}
    current_book: str | None = None
    current_chapter: int | None = None
    last_chapter: int | None = None
    last_verse_line_index: Tuple[str,int] | None = None  # (book, list_index)

    for ln in lines:
        ln_strip = ln.strip()
        if not ln_strip:
            continue
        # Heading
        bh = BOOK_HEADING_RE.match(ln_strip)
        if bh:
            book_num = int(bh.group(1))
            name_part = bh.group(2).strip()
            # Prefer canonical by name; fallback by ordinal
            matched_book = None
            for b in BOOKS:
                if b.lower() == name_part.lower():
                    matched_book = b
                    break
            if matched_book is None:
                # fallback by index: book_num 1-based
                if 1 <= book_num <= len(BOOKS):
                    matched_book = BOOKS[book_num - 1]
            current_book = matched_book
            current_chapter = None
            last_chapter = None
            last_verse_line_index = None
            continue
        # Verse line
        mv = NUM_VERSE_RE.match(ln_strip)
        if mv:
            book_num = int(mv.group(1))
            ch_raw = mv.group(2)
            vs_raw = mv.group(3)
            text = mv.group(4).strip()
            chapter = int(ch_raw.lstrip('0') or '0')
            verse = int(vs_raw.lstrip('0') or '0')
            # Ensure book alignment if heading missing
            if current_book is None or (1 <= book_num <= len(BOOKS) and current_book != BOOKS[book_num - 1]):
                # Start a new book implicitly
                current_book = BOOKS[book_num - 1]
                current_chapter = None
                last_chapter = None
                last_verse_line_index = None
            if current_book is None:
                continue  # cannot place verse
            if current_chapter != chapter:
                current_chapter = chapter
                last_chapter = chapter
                books_content[current_book].append(f"Chapter {chapter}")
            books_content[current_book].append(f"{verse} {text}")
            last_verse_line_index = (current_book, len(books_content[current_book]) - 1)
            continue
        # Continuation lines: append to last verse if present
        if last_verse_line_index:
            bname, idx = last_verse_line_index
            books_content[bname][idx] = books_content[bname][idx] + " " + ln_strip
        # else ignore (could be preface outside books)
    # Trim leading/trailing blanks in each book
    for b, lst in books_content.items():
        cleaned = []
        for item in lst:
            t = item.strip()
            if t:
                cleaned.append(t)
        books_content[b] = cleaned
    return books_content

def split_books(lines: List[str]) -> Dict[str, List[str]]:
    # If numbered format detected, delegate to specialized parser
    if detect_numbered_format(lines):
        return parse_numbered_format(lines)
    books_content: Dict[str, List[str]] = {}
    current: str | None = None
    heading_buffer: List[str] = []
    for line in lines:
        book = is_heading(line)
        if book and (current is None or book != current):
            current = book
            books_content.setdefault(current, [])
            heading_buffer = [line]
            continue
        if current is None:
            continue
        if heading_buffer and is_heading(line):
            heading_buffer.append(line)
            continue
        heading_buffer = []
        books_content[current].append(line.rstrip("\n"))
    return books_content

CHAPTER_HEADING_RE = re.compile(r"^(?:CHAPTER|PSALM)\s+(\d+)$", re.IGNORECASE)
VERSE_COLON_RE = re.compile(r"^(\d+):(\d+)\s+(.*)$")  # e.g. 1:1 In the beginning...
VERSE_SIMPLE_RE = re.compile(r"^(\d+)\s+(.*)$")        # e.g. 1 In the beginning...

def clean_book_lines(book: str, lines: List[str]) -> List[str]:
    """Normalize lines to standard format:
    Chapter headings: 'Chapter N'
    Verse lines: 'V Verse text'
    Detect chapters via explicit headings, colon pattern chapter:verse, or verse number reset.
    """
    filtered: List[str] = []
    for ln in lines:
        if is_heading(ln):
            continue  # strip book-level headings
        filtered.append(ln.rstrip())

    # Remove leading/trailing blanks
    while filtered and not filtered[0].strip():
        filtered.pop(0)
    while filtered and not filtered[-1].strip():
        filtered.pop()

    normalized: List[str] = []
    current_chapter: int | None = None
    last_verse_in_chapter: int | None = None

    def start_chapter(ch_num: int):
        nonlocal current_chapter, last_verse_in_chapter
        current_chapter = ch_num
        last_verse_in_chapter = None
        normalized.append(f"Chapter {ch_num}")

    for ln in filtered:
        raw = ln.strip()
        if not raw:
            continue
        # Explicit chapter heading
        m_head = CHAPTER_HEADING_RE.match(raw)
        if m_head:
            start_chapter(int(m_head.group(1)))
            continue

        # Colon pattern chapter:verse
        m_colon = VERSE_COLON_RE.match(raw)
        if m_colon:
            ch_num = int(m_colon.group(1))
            v_num = int(m_colon.group(2))
            text = m_colon.group(3).strip()
            if current_chapter != ch_num:
                start_chapter(ch_num)
            normalized.append(f"{v_num} {text}")
            last_verse_in_chapter = v_num
            continue

        # Simple verse pattern
        m_simple = VERSE_SIMPLE_RE.match(raw)
        if m_simple:
            v_num = int(m_simple.group(1))
            text = m_simple.group(2).strip()
            # Chapter inference on reset to 1
            if current_chapter is None:
                start_chapter(1)
            elif last_verse_in_chapter is not None and v_num == 1 and last_verse_in_chapter and last_verse_in_chapter > 1:
                # New chapter inferred
                inferred = (current_chapter or 0) + 1
                start_chapter(inferred)
            normalized.append(f"{v_num} {text}")
            last_verse_in_chapter = v_num
            continue

        # Non-matching line: treat as continuation of previous verse (append)
        if normalized and not normalized[-1].startswith("Chapter "):
            normalized[-1] = normalized[-1] + " " + raw
        else:
            # If we have no chapter yet, start chapter 1
            if current_chapter is None:
                start_chapter(1)
            normalized.append(raw)  # could be a preface; keep it

    return normalized

def main():
    parser = argparse.ArgumentParser(description="Split KJV Bible master file into per-book text files.")
    parser.add_argument("--input", required=True, help="Path to BibleKJV.txt master file (UTF-8)")
    parser.add_argument("--output-dir", required=True, help="Directory to write book .txt files")
    args = parser.parse_args()

    input_path = Path(args.input)
    out_dir = Path(args.output_dir)
    if not input_path.exists():
        raise SystemExit(f"Input file not found: {input_path}")
    out_dir.mkdir(parents=True, exist_ok=True)

    text = input_path.read_text(encoding="utf-8")
    lines = text.splitlines()
    books_content = split_books(lines)

    # Validate we have all 66 books; warn if missing
    found = set(books_content.keys())
    missing = [b for b in BOOKS if b not in found]
    extra = [b for b in found if b not in BOOKS]
    if missing:
        print(f"WARNING: Missing {len(missing)} book(s): {missing}")
    if extra:
        print(f"NOTE: Detected extra book-like sections: {extra}")

    for book in BOOKS:
        content_lines = books_content.get(book, [])
        cleaned = clean_book_lines(book, content_lines)
        output_file = out_dir / f"{book.replace(' ', '')}.txt"  # remove spaces for file name
        output_text = "\n".join(cleaned).strip() + "\n"
        output_file.write_text(output_text, encoding="utf-8")
        print(f"Wrote {book}: {len(cleaned)} lines -> {output_file}")

    print("Done.")

if __name__ == "__main__":
    main()
