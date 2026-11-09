/**
 * Small fuzzy matcher for the quick switcher, command palette and [[ completion.
 * Case-insensitive, NFC-aware, with Hangul initial-consonant matching:
 * a query can use each syllable's initial consonant instead of its full spelling.
 */

export interface FuzzyResult {
  score: number;
  /** Indices into the target string of the matched characters. */
  positions: number[];
}

const HANGUL_BASE = 0xac00;
const HANGUL_LAST = 0xd7a3;
const CHOSEONG = "\u3131\u3132\u3134\u3137\u3138\u3139\u3141\u3142\u3143\u3145\u3146\u3147\u3148\u3149\u314A\u314B\u314C\u314D\u314E";

/** Maps each precomposed Hangul syllable to its initial consonant; other chars pass through. */
export function choseong(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    out += c >= HANGUL_BASE && c <= HANGUL_LAST ? CHOSEONG[Math.floor((c - HANGUL_BASE) / 588)] : ch;
  }
  return out;
}

/**
 * While a Hangul syllable is still being composed the query ends in a partial
 * syllable (U+D558 on the way to U+D55C) or a bare consonant (U+314E). Let that last
 * character match any target syllable it is a prefix of.
 */
function hangulPrefix(qc: string, tc: string | undefined): boolean {
  if (tc === undefined) return false;
  const t = tc.charCodeAt(0);
  if (t < HANGUL_BASE || t > HANGUL_LAST) return false;
  const ti = t - HANGUL_BASE;
  const cho = CHOSEONG.indexOf(qc);
  if (cho >= 0) return cho === Math.floor(ti / 588);
  const q = qc.charCodeAt(0);
  if (q < HANGUL_BASE || q > HANGUL_LAST) return false;
  const qi = q - HANGUL_BASE;
  return qi % 28 === 0 && Math.floor(qi / 28) === Math.floor(ti / 28);
}

function isJamoQuery(q: string): boolean {
  return q.length > 0 && [...q].every((ch) => CHOSEONG.includes(ch) || ch === " ");
}

function isBoundary(t: string, i: number): boolean {
  if (i === 0) return true;
  const prev = t[i - 1];
  if (" -_/.()[]".includes(prev)) return true;
  // camelCase boundary on the original-case string
  return prev === prev.toLowerCase() && t[i] !== t[i].toLowerCase();
}

function matchLowered(ql: string, tl: string, orig: string): FuzzyResult | null {
  if (ql.length === 0) return { score: 0, positions: [] };
  if (ql.length > tl.length) return null;

  let sub = tl.indexOf(ql);
  if (sub < 0) {
    // Composition-tolerant substring: everything but the last char exact, last char as a syllable prefix.
    const head = ql.slice(0, -1);
    const last = ql[ql.length - 1];
    // Bounded: indexOf("") never returns -1, so stop once no char can follow `head`.
    for (let i = tl.indexOf(head); i >= 0 && i + head.length < tl.length; i = tl.indexOf(head, i + 1)) {
      if (hangulPrefix(last, tl[i + head.length])) {
        sub = i;
        break;
      }
    }
  }
  if (sub >= 0) {
    const positions = Array.from({ length: ql.length }, (_, k) => sub + k);
    const score = 1000 + (isBoundary(orig, sub) ? 200 : 0) - sub * 3 - (tl.length - ql.length);
    return { score, positions };
  }

  const positions: number[] = [];
  let score = 0;
  let from = 0;
  let prev = -2;
  for (let qi = 0; qi < ql.length; qi++) {
    const qc = ql[qi];
    // Prefer the nearest boundary occurrence within a short window, else the nearest occurrence.
    let j = tl.indexOf(qc, from);
    if (j < 0 && qi === ql.length - 1) {
      for (let k = from; k < tl.length; k++) {
        if (hangulPrefix(qc, tl[k])) {
          j = k;
          break;
        }
      }
    }
    if (j < 0) return null;
    if (j !== prev + 1 && !isBoundary(orig, j)) {
      let k = tl.indexOf(qc, j + 1);
      while (k >= 0 && k - j <= 12) {
        if (isBoundary(orig, k)) {
          j = k;
          break;
        }
        k = tl.indexOf(qc, k + 1);
      }
    }
    if (j === prev + 1) score += 18;
    if (isBoundary(orig, j)) score += 12;
    score -= Math.min(j - from, 20);
    positions.push(j);
    prev = j;
    from = j + 1;
  }
  return { score: score + 100 - tl.length * 0.5, positions };
}

/** Matches `query` against `target`; returns null when not all query chars appear in order. */
export function fuzzyMatch(query: string, target: string): FuzzyResult | null {
  const q = query.normalize("NFC").trim();
  const t = target.normalize("NFC");
  const direct = matchLowered(q.toLowerCase(), t.toLowerCase(), t);
  if (direct || !isJamoQuery(q)) return direct;
  // choseong() maps code units 1:1 for the BMP Hangul block, so positions stay valid.
  const cho = choseong(t);
  const r = matchLowered(q.replace(/ /g, ""), cho, cho);
  return r ? { score: r.score - 50, positions: r.positions } : null;
}

export interface Ranked<T> extends FuzzyResult {
  item: T;
}

/** Scores and sorts `items` (best first), keeping at most `limit`. Empty query keeps input order. */
export function fuzzyRank<T>(query: string, items: readonly T[], text: (item: T) => string, limit: number): Ranked<T>[] {
  const out: Ranked<T>[] = [];
  if (query.trim() === "") {
    for (const item of items.slice(0, limit)) out.push({ item, score: 0, positions: [] });
    return out;
  }
  for (const item of items) {
    const r = fuzzyMatch(query, text(item));
    if (r) out.push({ item, ...r });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}
