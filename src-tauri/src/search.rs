//! Full-text search over the vault's notes (ARCHITECTURE §6.5, SRCH-01/02).
//! Character-level substring matching on NFC text; no index.

use std::borrow::Cow;
use std::fs;
use std::path::Path;
use std::sync::atomic::Ordering;

use serde::Serialize;
use tauri::{AppHandle, State};
use unicode_normalization::{is_nfc_quick, IsNormalized, UnicodeNormalization};

use crate::error::AppResult;
use crate::fs_ops::{self, Walked};
use crate::vault::{blocking, VaultState};

/// Notes larger than this are not read (SAVE-11); they can still match by name.
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_LINES_PER_FILE: usize = 20;
/// Longer lines are trimmed to this many characters around the first hit.
const SNIPPET_CHARS: usize = 240;
/// Characters kept before the first hit in a trimmed line.
const SNIPPET_LEAD: usize = 30;
const MAX_LIMIT: u32 = 1000;
const ELLIPSIS: char = '…';

/// `SearchMatch` in src/lib/types.ts.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SearchMatch {
    /// 0-based line number (lines end at `\n`, `\r\n` or `\r`, as in CodeMirror).
    pub line: u32,
    pub text: String,
    /// `[start, end)` UTF-16 offsets into `text`, sorted and non-overlapping.
    pub ranges: Vec<[u32; 2]>,
}

/// `SearchFileResult` in src/lib/types.ts.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchFileResult {
    pub path: String,
    pub name_match: bool,
    pub matches: Vec<SearchMatch>,
    /// Hits in the whole file (ranking only).
    #[serde(skip)]
    count: usize,
}

/// `SearchResponse` in src/lib/types.ts.
#[derive(Debug, Clone, Serialize)]
pub struct SearchResponse {
    pub results: Vec<SearchFileResult>,
    pub truncated: bool,
}

/// `search_text` (scoped). Every call bumps the search generation, which stops
/// older searches still running (they return `truncated: true`).
#[tauri::command]
pub async fn search_text(
    app: AppHandle,
    state: State<'_, VaultState>,
    epoch: u64,
    query: String,
    case_sensitive: bool,
    limit: u32,
) -> AppResult<SearchResponse> {
    let generation = state.search_gen.fetch_add(1, Ordering::SeqCst) + 1;
    blocking(app, move |state| {
        let root = state.check(epoch)?;
        let cancelled = || state.search_gen.load(Ordering::SeqCst) != generation;
        let limit = limit.clamp(1, MAX_LIMIT) as usize;
        Ok(search_vault(
            &root,
            &query,
            case_sensitive,
            limit,
            &cancelled,
        ))
    })
    .await
}

fn search_vault(
    root: &Path,
    query: &str,
    case_sensitive: bool,
    limit: usize,
    cancelled: &dyn Fn() -> bool,
) -> SearchResponse {
    let terms = prepare_terms(query, case_sensitive);
    let mut results: Vec<SearchFileResult> = Vec::new();
    let mut truncated = false;
    if terms.is_empty() {
        return SearchResponse { results, truncated };
    }
    let mut visited = 0usize;
    fs_ops::walk_vault(root, None, |entry| {
        if cancelled() || visited >= fs_ops::MAX_ENTRIES {
            truncated = true;
            return false;
        }
        visited += 1;
        if entry.is_dir {
            return true;
        }
        if let Some(result) = search_file(&entry, &terms, case_sensitive) {
            results.push(result);
            // Keep memory bounded on common terms; the best `limit` always survive.
            if results.len() >= limit.saturating_mul(2) {
                rank(&mut results);
                results.truncate(limit);
                truncated = true;
            }
        }
        true
    });
    rank(&mut results);
    if results.len() > limit {
        results.truncate(limit);
        truncated = true;
    }
    SearchResponse { results, truncated }
}

/// Files whose name matches the whole query first, then by number of hits, then by path.
fn rank(results: &mut [SearchFileResult]) {
    results.sort_by(|a, b| {
        b.name_match
            .cmp(&a.name_match)
            .then_with(|| b.count.cmp(&a.count))
            .then_with(|| a.path.cmp(&b.path))
    });
}

/// A file matches when every term occurs in its content or in its name (the
/// title without extension). Big files and cloud placeholders are not read and
/// can only match by name; files that are not UTF-8 never match.
fn search_file(entry: &Walked, terms: &[String], case_sensitive: bool) -> Option<SearchFileResult> {
    let name = entry.rel.rsplit('/').next().unwrap_or(&entry.rel);
    if !fs_ops::is_note_name(name) {
        return None;
    }
    let stem = name.rsplit_once('.').map_or(name, |(stem, _)| stem);
    let folded_name = fold_str(&to_nfc(stem.to_owned()), case_sensitive).into_owned();
    let in_name: Vec<bool> = terms
        .iter()
        .map(|t| folded_name.contains(t.as_str()))
        .collect();
    let name_match = in_name.iter().all(|&hit| hit);
    let name_only = |name_match: bool| {
        name_match.then(|| SearchFileResult {
            path: entry.rel.clone(),
            name_match,
            matches: Vec::new(),
            count: 0,
        })
    };
    if entry.meta.len() > MAX_FILE_BYTES || fs_ops::is_cloud_placeholder(&entry.meta) {
        return name_only(name_match);
    }
    let text = match read_text(&entry.path) {
        Ok(Some(text)) => text,
        Ok(None) => return None,
        Err(_) => return name_only(name_match),
    };
    let haystack = fold_str(&text, case_sensitive);
    if !terms
        .iter()
        .zip(&in_name)
        .all(|(term, &hit)| hit || haystack.contains(term.as_str()))
    {
        return None;
    }
    let (matches, count) = collect_matches(&text, terms, case_sensitive);
    Some(SearchFileResult {
        path: entry.rel.clone(),
        name_match,
        matches,
        count,
    })
}

/// The file as NFC text without a BOM; `None` when it is not UTF-8.
fn read_text(path: &Path) -> std::io::Result<Option<String>> {
    let mut bytes = fs::read(path)?;
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        bytes.drain(..3);
    }
    Ok(String::from_utf8(bytes).ok().map(to_nfc))
}

fn to_nfc(text: String) -> String {
    if is_nfc_quick(text.chars()) == IsNormalized::Yes {
        text
    } else {
        text.nfc().collect()
    }
}

/// Per-character lowercase (the same mapping as [`Folded`]), or the text itself
/// when matching is case-sensitive.
fn fold_str(text: &str, case_sensitive: bool) -> Cow<'_, str> {
    if case_sensitive {
        Cow::Borrowed(text)
    } else {
        Cow::Owned(text.chars().flat_map(char::to_lowercase).collect())
    }
}

/// Splits a query into whitespace-separated terms and `"quoted phrases"` (kept as
/// written, inner spaces included). NFC-normalized; empty and duplicate pieces
/// dropped; an unclosed quote runs to the end.
pub fn parse_terms(query: &str) -> Vec<String> {
    let query: String = query
        .nfc()
        .map(|c| if c == '\r' || c == '\n' { ' ' } else { c })
        .collect();
    let mut terms: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let flush = |current: &mut String, terms: &mut Vec<String>| {
        let term = std::mem::take(current);
        if !term.trim().is_empty() && !terms.contains(&term) {
            terms.push(term);
        }
    };
    for c in query.chars() {
        if c == '"' {
            flush(&mut current, &mut terms);
            quoted = !quoted;
        } else if c.is_whitespace() && !quoted {
            flush(&mut current, &mut terms);
        } else {
            current.push(c);
        }
    }
    flush(&mut current, &mut terms);
    terms
}

/// [`parse_terms`], folded for case-insensitive matching and deduplicated again.
fn prepare_terms(query: &str, case_sensitive: bool) -> Vec<String> {
    let mut terms: Vec<String> = Vec::new();
    for term in parse_terms(query) {
        let term = fold_str(&term, case_sensitive).into_owned();
        if !terms.contains(&term) {
            terms.push(term);
        }
    }
    terms
}

/// Lines of `text` split at `\n`, `\r\n` and `\r`, like CodeMirror counts them.
pub fn split_lines(text: &str) -> impl Iterator<Item = &str> {
    let mut rest = Some(text);
    std::iter::from_fn(move || {
        let s = rest?;
        match s.find(['\r', '\n']) {
            Some(i) => {
                let skip = if s[i..].starts_with("\r\n") { 2 } else { 1 };
                rest = Some(&s[i + skip..]);
                Some(&s[..i])
            }
            None => {
                rest = None;
                Some(s)
            }
        }
    })
}

/// A line lowercased one character at a time, remembering which original
/// character produced each byte. Tolerates case mappings that change length
/// (`İ` → `i̇`): a hit covering part of such a character maps to all of it.
pub struct Folded {
    pub text: String,
    owner: Vec<usize>,
}

impl Folded {
    pub fn new(line: &str, case_sensitive: bool) -> Self {
        let mut text = String::with_capacity(line.len());
        let mut owner = Vec::with_capacity(line.len());
        for (index, c) in line.chars().enumerate() {
            if case_sensitive {
                text.push(c);
            } else {
                text.extend(c.to_lowercase());
            }
            owner.resize(text.len(), index);
        }
        Self { text, owner }
    }

    /// Original character range `[start, end)` covered by the folded bytes `[from, to)`.
    pub fn char_range(&self, from: usize, to: usize) -> Option<(usize, usize)> {
        if from >= to {
            return None;
        }
        Some((*self.owner.get(from)?, *self.owner.get(to - 1)? + 1))
    }
}

/// Original character ranges of every term occurrence in `line`.
fn line_hits(line: &str, terms: &[String], case_sensitive: bool) -> Vec<(usize, usize)> {
    let folded = Folded::new(line, case_sensitive);
    let mut hits = Vec::new();
    for term in terms {
        for (at, found) in folded.text.match_indices(term.as_str()) {
            if let Some(range) = folded.char_range(at, at + found.len()) {
                hits.push(range);
            }
        }
    }
    hits
}

/// Up to [`MAX_LINES_PER_FILE`] snippets of lines containing any term, and the
/// number of hits in the whole file.
fn collect_matches(
    text: &str,
    terms: &[String],
    case_sensitive: bool,
) -> (Vec<SearchMatch>, usize) {
    let mut matches = Vec::new();
    let mut count = 0;
    for (index, line) in split_lines(text).enumerate() {
        let hits = line_hits(line, terms, case_sensitive);
        if hits.is_empty() {
            continue;
        }
        count += hits.len();
        if matches.len() < MAX_LINES_PER_FILE {
            matches.push(snippet(
                line,
                u32::try_from(index).unwrap_or(u32::MAX),
                hits,
            ));
        }
    }
    (matches, count)
}

/// Sorts ranges and merges overlapping or touching ones.
fn merge_ranges(mut ranges: Vec<(usize, usize)>) -> Vec<(usize, usize)> {
    ranges.sort_unstable();
    let mut merged: Vec<(usize, usize)> = Vec::with_capacity(ranges.len());
    for (start, end) in ranges {
        match merged.last_mut() {
            Some(last) if start <= last.1 => last.1 = last.1.max(end),
            _ => merged.push((start, end)),
        }
    }
    merged
}

/// Character window `[start, end)` shown for a line of `len` characters whose
/// first hit starts at `first`.
fn snippet_window(len: usize, first: usize) -> (usize, usize) {
    if len <= SNIPPET_CHARS {
        return (0, len);
    }
    let start = first.saturating_sub(SNIPPET_LEAD).min(len - SNIPPET_CHARS);
    (start, start + SNIPPET_CHARS)
}

/// The snippet for one matching line: trimmed around the first hit with `…` when
/// longer than [`SNIPPET_CHARS`], with hit ranges as UTF-16 offsets into it.
fn snippet(line: &str, line_number: u32, hits: Vec<(usize, usize)>) -> SearchMatch {
    let chars: Vec<char> = line.chars().collect();
    let ranges = merge_ranges(hits);
    let first = ranges.first().map_or(0, |r| r.0);
    let (start, end) = snippet_window(chars.len(), first);
    let mut text = String::new();
    let lead = usize::from(start > 0);
    if start > 0 {
        text.push(ELLIPSIS);
    }
    text.extend(&chars[start..end]);
    if end < chars.len() {
        text.push(ELLIPSIS);
    }
    // UTF-16 offset of each character boundary inside the window (U+2026 is one unit).
    let mut offsets = Vec::with_capacity(end - start + 1);
    let mut offset = lead;
    offsets.push(offset);
    for c in &chars[start..end] {
        offset += c.len_utf16();
        offsets.push(offset);
    }
    let to_u32 = |n: usize| u32::try_from(n).unwrap_or(u32::MAX);
    let ranges = ranges
        .into_iter()
        .filter_map(|(s, e)| {
            let (s, e) = (s.max(start), e.min(end));
            (s < e).then(|| [to_u32(offsets[s - start]), to_u32(offsets[e - start])])
        })
        .collect();
    SearchMatch {
        line: line_number,
        text,
        ranges,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terms_split_on_whitespace_and_keep_phrases() {
        assert_eq!(parse_terms("  foo   bar "), vec!["foo", "bar"]);
        assert_eq!(parse_terms(r#"a "b  c" d"#), vec!["a", "b  c", "d"]);
        assert_eq!(parse_terms(r#""unclosed phrase"#), vec!["unclosed phrase"]);
        assert_eq!(parse_terms(r#"x "" "   " x"#), vec!["x"]);
        assert_eq!(
            parse_terms("\u{B178}\u{D2B8}\u{3000}\u{BA54}\u{BAA8}"),
            vec!["\u{B178}\u{D2B8}", "\u{BA54}\u{BAA8}"]
        ); // ideographic space
        assert!(parse_terms("   ").is_empty());
    }

    #[test]
    fn terms_are_nfc_and_folded() {
        let nfd = "\u{1102}\u{1169}\u{1110}\u{1173}"; // Hangul for "note", decomposed
        assert_eq!(parse_terms(nfd), vec!["\u{B178}\u{D2B8}"]);
        assert_eq!(prepare_terms("Foo FOO foo", false), vec!["foo"]);
        assert_eq!(prepare_terms("Foo FOO", true), vec!["Foo", "FOO"]);
    }

    #[test]
    fn lines_split_like_codemirror() {
        let lines: Vec<&str> = split_lines("a\r\nb\rc\nd").collect();
        assert_eq!(lines, vec!["a", "b", "c", "d"]);
        assert_eq!(split_lines("x\n").collect::<Vec<_>>(), vec!["x", ""]);
        assert_eq!(split_lines("").collect::<Vec<_>>(), vec![""]);
    }

    #[test]
    fn folding_maps_back_through_length_changes() {
        // 'İ' (U+0130) lowercases to "i\u{307}" (two chars, three bytes).
        let folded = Folded::new("A\u{130}b", false);
        assert_eq!(folded.text, "ai\u{307}b");
        let at = folded.text.find('b').unwrap();
        assert_eq!(folded.char_range(at, at + 1), Some((2, 3)));
        // A hit on just the "i" of the expansion still covers the whole 'İ'.
        let i = folded.text.find('i').unwrap();
        assert_eq!(folded.char_range(i, i + 1), Some((1, 2)));
        assert_eq!(
            line_hits("A\u{130}b", &["i\u{307}b".to_string()], false),
            vec![(1, 3)]
        );
        assert_eq!(
            line_hits("\u{C0}B", &["\u{E0}b".to_string()], false),
            vec![(0, 2)]
        );
        assert!(line_hits("\u{C0}B", &["\u{E0}b".to_string()], true).is_empty());
    }

    #[test]
    fn ranges_are_utf16_offsets() {
        // Hangul is one UTF-16 unit per syllable; the emoji takes two.
        let m = snippet(
            "😀 \u{B178}\u{D2B8}\u{B97C} \u{C5F4}\u{AE30}",
            3,
            line_hits(
                "😀 \u{B178}\u{D2B8}\u{B97C} \u{C5F4}\u{AE30}",
                &["\u{B178}\u{D2B8}".into()],
                false,
            ),
        );
        assert_eq!(m.line, 3);
        assert_eq!(m.text, "😀 \u{B178}\u{D2B8}\u{B97C} \u{C5F4}\u{AE30}");
        assert_eq!(m.ranges, vec![[3, 5]]);
        let m = snippet(
            "abcabc",
            0,
            line_hits("abcabc", &["bc".into(), "c".into()], false),
        );
        assert_eq!(m.ranges, vec![[1, 3], [4, 6]]);
        let m = snippet("aXbX", 0, line_hits("aXbX", &["x".into()], false));
        assert_eq!(m.ranges, vec![[1, 2], [3, 4]]);
    }

    #[test]
    fn long_lines_are_trimmed_around_the_first_hit() {
        let line = format!("{}needle{}", "\u{AC00}".repeat(300), "\u{B098}".repeat(300));
        let hits = line_hits(&line, &["needle".into()], false);
        let m = snippet(&line, 0, hits);
        assert!(m.text.starts_with(ELLIPSIS) && m.text.ends_with(ELLIPSIS));
        assert_eq!(m.text.chars().count(), SNIPPET_CHARS + 2);
        let [s, e] = m.ranges[0];
        let units: Vec<u16> = m.text.encode_utf16().collect();
        assert_eq!(
            String::from_utf16(&units[s as usize..e as usize]).unwrap(),
            "needle"
        );
        assert_eq!(s as usize, 1 + SNIPPET_LEAD);
        // A hit near the end keeps the window inside the line.
        assert_eq!(snippet_window(500, 495), (260, 500));
        assert_eq!(snippet_window(100, 90), (0, 100));
    }

    #[test]
    fn matches_cap_lines_but_count_every_hit() {
        let text = "hit\n".repeat(25);
        let (matches, count) = collect_matches(&text, &["hit".into()], false);
        assert_eq!(matches.len(), MAX_LINES_PER_FILE);
        assert_eq!(count, 25);
        assert_eq!(matches[1].line, 1);
    }
}
