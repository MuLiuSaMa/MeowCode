#!/usr/bin/env python3
import argparse
import re
import math
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Set, Dict, List


EDGE_LINES = 5
TOP_K_PAGES = 3
MIN_TOKEN_HITS = 2
MIN_TOKEN_RATIO = 0.3
STOP_WORDS = {
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "by",
    "for",
    "from",
    "in",
    "into",
    "is",
    "it",
    "of",
    "on",
    "or",
    "that",
    "the",
    "their",
    "this",
    "to",
    "was",
    "were",
    "with",
    "we",
    "you",
    "your",
    "our",
    "can",
    "will",
    "should",
}


@dataclass
class FileEntry:
    path: Path
    lines: list[str]


@dataclass
class PageSource:
    query_idx: int
    query: str
    rank: int
    is_extension: bool = False
    source_page_idx: Optional[int] = None


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("extracted_dir")
    parser.add_argument("query", nargs="?")
    parser.add_argument("--query-file")
    parser.add_argument("--regex", action="store_true")
    args = parser.parse_args()
    if not args.query and not args.query_file:
        parser.error("query or --query-file is required")
    if args.query and args.query_file:
        parser.error("query and --query-file cannot be used together")
    return args


def read_lines(file_path: Path):
    with file_path.open("r", encoding="utf-8", errors="ignore") as f:
        return [line.rstrip("\n") for line in f]


def page_number(path: Path):
    m = re.search(r"page_(\d+)\.txt$", path.name)
    return int(m.group(1)) if m else 10**9


def collect_entries(extracted_dir: Path):
    pages_dir = extracted_dir / "pages"
    page_files = []
    if pages_dir.is_dir():
        page_files = sorted(
            [p for p in pages_dir.iterdir() if p.is_file() and p.name.startswith("page_") and p.suffix == ".txt"],
            key=page_number,
        )
    page_entries = [FileEntry(path=f, lines=read_lines(f)) for f in page_files]
    return page_entries


def tokenize_query(query: str):
    tokens = []
    seen = set()
    for token in re.findall(r"[A-Za-z0-9]+", query.lower()):
        if len(token) < 3:
            continue
        if token in STOP_WORDS:
            continue
        if token in seen:
            continue
        seen.add(token)
        tokens.append(token)
        if len(tokens) >= 8:
            break
    return tokens


def extract_phrases(tokens: list[str], min_n: int = 2, max_n: int = 4, max_phrases: int = 8):
    phrases = []
    for n in range(min_n, max_n + 1):
        if len(tokens) < n:
            continue
        for i in range(0, len(tokens) - n + 1):
            phrase = " ".join(tokens[i : i + n])
            phrases.append(phrase)
    phrases.sort(key=lambda s: len(s.split()), reverse=True)
    dedup = []
    seen = set()
    for phrase in phrases:
        if phrase in seen:
            continue
        seen.add(phrase)
        dedup.append(phrase)
        if len(dedup) >= max_phrases:
            break
    return dedup


def find_line_matches(lines: list[str], query: str, use_regex: bool):
    if use_regex:
        pattern = re.compile(query)
        return [idx for idx, line in enumerate(lines) if pattern.search(line)]
    q = query.lower()
    return [idx for idx, line in enumerate(lines) if q in line.lower()]


def find_token_line_matches(lines: list[str], tokens: list[str]):
    return [idx for idx, line in enumerate(lines) if any(token in line.lower() for token in tokens)]


def file_contains_all_tokens(lines: list[str], tokens: list[str]):
    text = "\n".join(lines).lower()
    return all(token in text for token in tokens)


def load_queries(query: Optional[str], query_file: Optional[str]):
    if query:
        print(f"[DEBUG] Using single query: {query}", file=sys.stderr)
        return [query]
    path = Path(query_file)
    print(f"[DEBUG] Loading queries from file: {path}", file=sys.stderr)
    if not path.exists():
        raise FileNotFoundError(f"query file not found: {query_file}")
    queries = []
    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        q = line.strip()
        if not q or q.startswith("#"):
            continue
        queries.append(q)
    print(f"[DEBUG] Loaded {len(queries)} queries", file=sys.stderr)
    return queries


def find_phrase_line_matches(lines: list[str], phrases: list[str]):
    matches = []
    for idx, line in enumerate(lines):
        lower = line.lower()
        if any(phrase in lower for phrase in phrases):
            matches.append(idx)
    return matches


def build_idf(entries: list[FileEntry], tokens: list[str]):
    n_docs = max(1, len(entries))
    idf = {}
    for token in tokens:
        df = 0
        for entry in entries:
            text = "\n".join(entry.lines).lower()
            if token in text:
                df += 1
        idf[token] = math.log((n_docs + 1) / (df + 1)) + 1.0
    return idf


def rank_entries(entries: list[FileEntry], tokens: list[str], phrases: list[str], top_k: int):
    ranked = []
    idf_map = build_idf(entries, tokens)
    for idx, entry in enumerate(entries):
        text = "\n".join(entry.lines).lower()
        token_hits = [token for token in tokens if token in text]
        phrase_hits = [phrase for phrase in phrases if phrase in text]
        token_count = len(token_hits)
        phrase_count = len(phrase_hits)
        token_ratio = (token_count / len(tokens)) if tokens else 0.0
        threshold = max(MIN_TOKEN_HITS, math.ceil(len(tokens) * MIN_TOKEN_RATIO)) if tokens else MIN_TOKEN_HITS
        candidate = phrase_count > 0 or token_count >= threshold
        if not candidate and token_count == 0:
            continue

        line_hits = set(find_phrase_line_matches(entry.lines, phrase_hits))
        if not line_hits:
            line_hits = set(find_token_line_matches(entry.lines, token_hits))
        if not line_hits and entry.lines:
            line_scores = []
            for line_idx, line in enumerate(entry.lines):
                lower = line.lower()
                score = sum(1 for token in token_hits if token in lower) + 2 * sum(1 for phrase in phrase_hits if phrase in lower)
                line_scores.append((score, line_idx))
            line_scores.sort(reverse=True)
            if line_scores and line_scores[0][0] > 0:
                line_hits.add(line_scores[0][1])

        token_idf_score = sum(idf_map.get(token, 1.0) for token in token_hits)
        phrase_idf_score = 0.0
        for phrase in phrase_hits:
            parts = phrase.split()
            if not parts:
                continue
            phrase_idf_score += sum(idf_map.get(part, 1.0) for part in parts) / len(parts)
        min_hit_line = min(line_hits) if line_hits else 10**9
        position_bonus = 0.4 if min_hit_line < 20 else 0.0
        density_bonus = 0.0
        if line_hits:
            span = max(1, max(line_hits) - min(line_hits) + 1)
            density_bonus = 0.8 * (len(line_hits) / span)
        low_idf_hits = sum(1 for token in token_hits if idf_map.get(token, 1.0) < 1.15)
        generic_penalty = 0.6 * low_idf_hits
        score = 3.0 * phrase_idf_score + 1.2 * token_idf_score + density_bonus + position_bonus - generic_penalty
        ranked.append((score, idx, line_hits))

    if not ranked and tokens:
        for idx, entry in enumerate(entries):
            text = "\n".join(entry.lines).lower()
            token_hits = [token for token in tokens if token in text]
            if not token_hits:
                continue
            line_hits = set(find_token_line_matches(entry.lines, token_hits))
            score = 1.0 * len(token_hits)
            ranked.append((score, idx, line_hits))

    ranked.sort(key=lambda x: x[0], reverse=True)
    return ranked[:top_k]


def print_full_entry(entry: FileEntry, hit_lines: Optional[Set[int]] = None):
    print("\n".join(entry.lines))


def expand_page_context(page_entries: list[FileEntry], page_idx: int, line_idx: int):
    out = [page_idx]
    if line_idx < EDGE_LINES and page_idx > 0:
        out.append(page_idx - 1)
    if line_idx >= len(page_entries[page_idx].lines) - EDGE_LINES and page_idx < len(page_entries) - 1:
        out.append(page_idx + 1)
    return out


def collect_matches_for_query(
    query: str,
    use_regex: bool,
    page_entries: list[FileEntry],
    query_idx: int,
    page_sources: Dict[int, List[PageSource]],
):
    page_matches = []
    found_pages = set()
    
    for i, entry in enumerate(page_entries):
        line_matches = find_line_matches(entry.lines, query, use_regex)
        for line_idx in line_matches:
            page_matches.append((i, line_idx))
            if i not in found_pages:
                found_pages.add(i)
                if i not in page_sources:
                    page_sources[i] = []
                page_sources[i].append(PageSource(
                    query_idx=query_idx,
                    query=query,
                    rank=1
                ))

    if not use_regex and not page_matches:
        tokens = tokenize_query(query)
        phrases = extract_phrases(tokens)
        if not tokens and not phrases:
            return page_matches
        ranked = rank_entries(page_entries, tokens, phrases, TOP_K_PAGES)
        for rank, (_, page_idx, line_hits) in enumerate(ranked, 1):
            if line_hits:
                for line_idx in sorted(line_hits):
                    page_matches.append((page_idx, line_idx))
            elif page_entries[page_idx].lines:
                page_matches.append((page_idx, 0))
            if page_idx not in page_sources:
                page_sources[page_idx] = []
            page_sources[page_idx].append(PageSource(
                query_idx=query_idx,
                query=query,
                rank=rank
            ))
    return page_matches


def print_debug_summary(page_entries: list[FileEntry], page_sources: Dict[int, List[PageSource]], emitted_pages: Set[int]):
    summary_lines = []
    summary_lines.append("\n" + "=" * 80)
    summary_lines.append("DEBUG SUMMARY: Selected Pages")
    summary_lines.append("=" * 80)
    
    page_info = []
    for page_idx in emitted_pages:
        page_num = page_number(page_entries[page_idx].path)
        sources = page_sources.get(page_idx, [])
        
        source_strs = []
        for src in sources:
            if src.is_extension:
                src_page_num = page_number(page_entries[src.source_page_idx].path)
                source_strs.append(f"extension from page {src_page_num}")
            else:
                query_preview = src.query[:50] + "..." if len(src.query) > 50 else src.query
                source_strs.append(f"query #{src.query_idx + 1} rank #{src.rank} ({query_preview})")
        
        page_info.append((page_num, page_idx, source_strs))
    
    page_info.sort(key=lambda x: x[0])
    
    for page_num, page_idx, source_strs in page_info:
        summary_lines.append(f"Page {page_num:4d} (index {page_idx:2d}):")
        for s in source_strs:
            summary_lines.append(f"  - {s}")
    summary_lines.append("=" * 80 + "\n")
    
    summary_text = "\n".join(summary_lines)
    print(summary_text)
    print(summary_text, file=sys.stderr)


def run():
    print("[DEBUG] search_extracted.py started", file=sys.stderr)
    args = parse_args()
    extracted_dir = Path(args.extracted_dir)
    print(f"[DEBUG] extracted_dir: {extracted_dir}", file=sys.stderr)
    print(f"[DEBUG] query: {args.query}", file=sys.stderr)
    print(f"[DEBUG] query_file: {args.query_file}", file=sys.stderr)
    if not extracted_dir.is_dir():
        print(f"Error: directory not found: {extracted_dir}")
        return 1
    page_entries = collect_entries(extracted_dir)
    print(f"[DEBUG] Found {len(page_entries)} pages", file=sys.stderr)
    if not page_entries:
        print(f"Error: no pages/ directory found under {extracted_dir}")
        return 1

    try:
        queries = load_queries(args.query, args.query_file)
    except FileNotFoundError as e:
        print(f"Error: {e}")
        return 1
    if not queries:
        print("No matches found")
        return 0

    page_sources: Dict[int, List[PageSource]] = {}
    page_matches = []
    for query_idx, query in enumerate(queries):
        q_page_matches = collect_matches_for_query(query, args.regex, page_entries, query_idx, page_sources)
        page_matches.extend(q_page_matches)

    if not page_matches:
        print("No matches found")
        return 0

    page_hit_lines: dict[int, set[int]] = {}
    for page_idx, line_idx in page_matches:
        if page_idx not in page_hit_lines:
            page_hit_lines[page_idx] = set()
        page_hit_lines[page_idx].add(line_idx)

    emitted_pages = set()
    extension_info: Dict[int, List[int]] = {}
    for page_idx, line_idx in page_matches:
        for context_idx in expand_page_context(page_entries, page_idx, line_idx):
            if context_idx not in emitted_pages:
                emitted_pages.add(context_idx)
                if context_idx != page_idx:
                    if context_idx not in page_sources:
                        page_sources[context_idx] = []
                    page_sources[context_idx].append(PageSource(
                        query_idx=-1,
                        query="",
                        rank=-1,
                        is_extension=True,
                        source_page_idx=page_idx
                    ))
                    if context_idx not in extension_info:
                        extension_info[context_idx] = []
                    extension_info[context_idx].append(page_idx)

    print_debug_summary(page_entries, page_sources, emitted_pages)

    for page_idx in sorted(emitted_pages):
        print_full_entry(page_entries[page_idx], page_hit_lines.get(page_idx, set()))

    return 0


if __name__ == "__main__":
    raise SystemExit(run())
