// Client-side stock ranking (docs/06 section 4.1): exact symbol > symbol prefix > name word-prefix
// > substring > fuzzy (Jaro-Winkler >= 0.85). Normalised fields are computed once per index load,
// so a keystroke is one pass over the array (UI-05: < 16 ms at 2,200 items).

/** `[id, symbol, name, flags]`, the compact row of GET /stocks/index (docs/03 section 3). */
export type IndexItem = readonly [id: number, symbol: string, name: string, flags: number];

export const FLAG = {
  brokerOk: 1,
  tracked: 2,
  suspended: 4,
  delisted: 8,
  nonEquity: 16,
  financial: 32,
  inNifty50: 64,
  inNifty100: 128,
} as const;

export const MAX_RESULTS = 12;
export const FUZZY_THRESHOLD = 0.85;
/** Fuzzy matching on 1-2 characters matches almost everything (assumption F03-4). */
export const FUZZY_MIN_QUERY = 3;

export interface IndexEntry {
  id: number;
  symbol: string;
  name: string;
  flags: number;
  /** Uppercased symbol with spaces/punctuation removed except `&` and `-`. */
  sym: string;
  /** `sym` without `&` and `-`, so `MM` finds `M&M` and `BAJAJAUTO` finds `BAJAJ-AUTO`. */
  symLoose: string;
  /** Name, same normalisation, spaces removed (so `TATAMOT` matches `Tata Motors`). */
  nameCond: string;
  nameLoose: string;
  words: string[];
}

export interface SearchHit {
  entry: IndexEntry;
  /** 0 exact symbol, 1 symbol prefix, 2 name word-prefix, 3 substring, 4 fuzzy. */
  tier: 0 | 1 | 2 | 3 | 4;
  score: number;
}

/** Uppercase; remove spaces and punctuation except `&` and `-`. */
export function normalizeQuery(q: string): string {
  return q.toUpperCase().replace(/[^A-Z0-9&-]/g, "");
}

function loose(s: string): string {
  return s.replace(/[&-]/g, "");
}

export function buildEntries(items: readonly IndexItem[]): IndexEntry[] {
  return items.map(([id, symbol, name, flags]) => {
    const sym = normalizeQuery(symbol);
    const nameCond = normalizeQuery(name);
    const words = name
      .toUpperCase()
      .split(/\s+/)
      .map((w) => w.replace(/[^A-Z0-9&-]/g, ""))
      .filter((w) => w.length > 0);
    return {
      id,
      symbol,
      name,
      flags,
      sym,
      symLoose: loose(sym),
      nameCond,
      nameLoose: loose(nameCond),
      words,
    };
  });
}

/** Jaro-Winkler similarity in [0, 1] (prefix scale 0.1, prefix cap 4). */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  const la = a.length;
  const lb = b.length;
  if (la === 0 || lb === 0) return 0;
  const window = Math.max(0, Math.floor(Math.max(la, lb) / 2) - 1);
  const aMatch = new Array<boolean>(la).fill(false);
  const bMatch = new Array<boolean>(lb).fill(false);
  let matches = 0;
  for (let i = 0; i < la; i++) {
    const lo = Math.max(0, i - window);
    const hi = Math.min(lb - 1, i + window);
    for (let j = lo; j <= hi; j++) {
      if (!bMatch[j] && a.charCodeAt(i) === b.charCodeAt(j)) {
        aMatch[i] = true;
        bMatch[j] = true;
        matches++;
        break;
      }
    }
  }
  if (matches === 0) return 0;
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < la; i++) {
    if (!aMatch[i]) continue;
    while (!bMatch[k]) k++;
    if (a.charCodeAt(i) !== b.charCodeAt(k)) transpositions++;
    k++;
  }
  const m = matches;
  const jaro = (m / la + m / lb + (m - transpositions / 2) / m) / 3;
  let prefix = 0;
  while (
    prefix < 4 &&
    prefix < la &&
    prefix < lb &&
    a.charCodeAt(prefix) === b.charCodeAt(prefix)
  ) {
    prefix++;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

function byTier(a: SearchHit, b: SearchHit): number {
  if (a.tier !== b.tier) return a.tier - b.tier;
  // Tier 4: closer fuzzy match first. Tiers 0-1: a literal match (M&M for M&M) beats a loose one.
  if (a.score !== b.score) return b.score - a.score;
  if (a.entry.sym.length !== b.entry.sym.length) return a.entry.sym.length - b.entry.sym.length;
  return a.entry.sym < b.entry.sym ? -1 : a.entry.sym > b.entry.sym ? 1 : 0;
}

/** Ranked hits for a raw query; empty array for an empty normalised query. */
export function searchEntries(
  entries: readonly IndexEntry[],
  rawQuery: string,
  limit: number = MAX_RESULTS,
): SearchHit[] {
  const q = normalizeQuery(rawQuery);
  if (q.length === 0) return [];
  const ql = loose(q);
  const hits: SearchHit[] = [];
  for (const e of entries) {
    let tier: SearchHit["tier"] | -1 = -1;
    let score = 1;
    if (e.sym === q) tier = 0;
    else if (ql.length > 0 && e.symLoose === ql) {
      tier = 0;
      score = 0;
    } else if (e.sym.startsWith(q)) tier = 1;
    else if (ql.length > 0 && e.symLoose.startsWith(ql)) {
      tier = 1;
      score = 0;
    } else if (
      e.nameCond.startsWith(q) ||
      (ql.length > 0 && e.nameLoose.startsWith(ql)) ||
      e.words.some((w) => w.startsWith(q))
    ) {
      tier = 2;
    } else if (
      e.sym.includes(q) ||
      e.nameCond.includes(q) ||
      (ql.length > 0 && (e.symLoose.includes(ql) || e.nameLoose.includes(ql)))
    ) {
      tier = 3;
    }
    if (tier >= 0) hits.push({ entry: e, tier: tier as SearchHit["tier"], score });
  }
  if (hits.length < limit && q.length >= FUZZY_MIN_QUERY) {
    const seen = new Set(hits.map((h) => h.entry.id));
    const fuzzy: SearchHit[] = [];
    for (const e of entries) {
      if (seen.has(e.id)) continue;
      let best = jaroWinkler(q, e.sym);
      for (const w of e.words) {
        const s = jaroWinkler(q, w);
        if (s > best) best = s;
      }
      if (best >= FUZZY_THRESHOLD) fuzzy.push({ entry: e, tier: 4, score: best });
    }
    hits.push(...fuzzy);
  }
  hits.sort(byTier);
  return hits.slice(0, limit);
}
