import { describe, expect, it } from "vitest";
import {
  buildEntries,
  jaroWinkler,
  normalizeQuery,
  searchEntries,
  type IndexItem,
} from "@/lib/search/rank";

export const SAMPLE: IndexItem[] = [
  [1, "TCS", "Tata Consultancy Services Ltd", 2],
  [2, "TATAMOTORS", "Tata Motors Ltd", 2],
  [3, "TATASTEEL", "Tata Steel Ltd", 2],
  [4, "M&M", "Mahindra & Mahindra Ltd", 2],
  [5, "M&MFIN", "Mahindra & Mahindra Financial Services Ltd", 2],
  [6, "BAJAJ-AUTO", "Bajaj Auto Ltd", 2],
  [7, "BAJFINANCE", "Bajaj Finance Ltd", 2],
  [8, "RELIANCE", "Reliance Industries Ltd", 2],
  [9, "INFY", "Infosys Ltd", 2],
  [10, "HDFCBANK", "HDFC Bank Ltd", 2],
  [11, "NIFTYBEES", "Nippon India ETF Nifty 50 BeES", 16],
  [12, "OLDCO", "Old Company Ltd", 8],
  [13, "HALTCO", "Halted Company Ltd", 4],
  [14, "MM", "Some Other MM Holdings", 0],
];

const entries = buildEntries(SAMPLE);
const symbols = (q: string) => searchEntries(entries, q).map((h) => h.entry.symbol);

describe("UI-25: normalizeQuery", () => {
  it("uppercases and removes spaces and punctuation except & and -", () => {
    expect(normalizeQuery(" m&m ")).toBe("M&M");
    expect(normalizeQuery("bajaj-auto")).toBe("BAJAJ-AUTO");
    expect(normalizeQuery("tata. motors!")).toBe("TATAMOTORS");
    expect(normalizeQuery("   ")).toBe("");
  });
});

describe("UI-25: ranking tiers", () => {
  it("exact symbol first, then symbol prefix, then name word-prefix, then substring", () => {
    const hits = searchEntries(entries, "TATA");
    // TATA: symbol prefix for TATAMOTORS, TATASTEEL; name word-prefix for TCS.
    expect(hits.map((h) => h.entry.symbol)).toEqual(["TATASTEEL", "TATAMOTORS", "TCS"]);
    expect(hits.map((h) => h.tier)).toEqual([1, 1, 2]);
    const sub = searchEntries(entries, "SULTANCY");
    expect(sub.map((h) => [h.entry.symbol, h.tier])).toEqual([["TCS", 3]]);
  });
  it("an exact symbol beats longer prefixes", () => {
    expect(symbols("TCS")[0]).toBe("TCS");
    expect(symbols("INFY")[0]).toBe("INFY");
  });
  it("multi-word queries match the condensed name", () => {
    expect(symbols("tata mot")[0]).toBe("TATAMOTORS");
    expect(symbols("hdfc bank")[0]).toBe("HDFCBANK");
  });
  it("fuzzy (Jaro-Winkler >= 0.85) catches a typo, only for 3+ characters", () => {
    expect(symbols("RELIANCEE")).toContain("RELIANCE");
    expect(symbols("INFOSIS")).toContain("INFY"); // via the name word INFOSYS
    expect(symbols("XQ")).toEqual([]);
    const h = searchEntries(entries, "RELIANCEE")[0];
    expect(h?.tier).toBe(4);
  });
  it("returns nothing for an empty or punctuation-only query", () => {
    expect(symbols("")).toEqual([]);
    expect(symbols("  .. ")).toEqual([]);
  });
  it("caps results at 12", () => {
    const many = buildEntries(
      Array.from({ length: 50 }, (_, i): IndexItem => [i, `AB${i}`, `Alpha Beta ${i}`, 0]),
    );
    expect(searchEntries(many, "AB")).toHaveLength(12);
  });
});

describe("UI-25: symbols with punctuation", () => {
  it("M&M is found by typing M&M", () => {
    const hits = symbols("M&M");
    expect(hits[0]).toBe("M&M");
    expect(hits).toContain("M&MFIN");
  });
  it("M&M is found by typing MM (exact on the loose symbol)", () => {
    const hits = symbols("MM");
    expect(hits).toContain("M&M");
    expect(hits.slice(0, 2).sort()).toEqual(["M&M", "MM"].sort());
  });
  it("BAJAJ-AUTO is found by BAJAJ-AUTO, BAJAJAUTO, 'bajaj auto' and BAJAJ", () => {
    expect(symbols("BAJAJ-AUTO")[0]).toBe("BAJAJ-AUTO");
    expect(symbols("BAJAJAUTO")[0]).toBe("BAJAJ-AUTO");
    expect(symbols("bajaj auto")[0]).toBe("BAJAJ-AUTO");
    expect(symbols("BAJAJ")).toEqual(expect.arrayContaining(["BAJAJ-AUTO", "BAJFINANCE"]));
  });
  it("delisted, suspended and ETF rows are returned with their flags for the badges", () => {
    const flags = (q: string) => searchEntries(entries, q)[0]?.entry.flags;
    expect(flags("OLDCO")).toBe(8);
    expect(flags("HALTCO")).toBe(4);
    expect(flags("NIFTYBEES")).toBe(16);
  });
});

describe("jaroWinkler", () => {
  it("known reference values", () => {
    expect(jaroWinkler("MARTHA", "MARHTA")).toBeCloseTo(0.9611, 3);
    expect(jaroWinkler("DWAYNE", "DUANE")).toBeCloseTo(0.84, 2);
    expect(jaroWinkler("ABC", "ABC")).toBe(1);
    expect(jaroWinkler("ABC", "XYZ")).toBe(0);
    expect(jaroWinkler("", "A")).toBe(0);
  });
});

describe("UI-05: 2,300 items, < 16 ms per keystroke", () => {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const word = (n: number, len: number) => {
    let s = "";
    let x = n * 2654435761;
    for (let i = 0; i < len; i++) {
      s += letters[Math.abs(x) % 26];
      x = Math.floor(x / 26) + n + i * 7919;
    }
    return s;
  };
  const items: IndexItem[] = Array.from({ length: 2300 }, (_, i) => [
    i + 1,
    word(i, 4 + (i % 7)),
    `${word(i + 5000, 6)} ${word(i + 9000, 5)} Industries Ltd`,
    0,
  ]);
  items.push([99999, "M&M", "Mahindra & Mahindra Ltd", 0], [100000, "BAJAJ-AUTO", "Bajaj Auto", 0]);
  const big = buildEntries(items);

  it("every keystroke of typical queries stays under 16 ms (median over runs)", () => {
    const queries = [
      "T",
      "TA",
      "TAT",
      "TATA",
      "M&M",
      "MM",
      "BAJAJ-AUTO",
      "zzzzzz",
      "INDUSTRIES",
      "q",
    ];
    const worst: number[] = [];
    for (const q of queries) {
      const times: number[] = [];
      for (let r = 0; r < 9; r++) {
        const t0 = performance.now();
        searchEntries(big, q);
        times.push(performance.now() - t0);
      }
      times.sort((a, b) => a - b);
      worst.push(times[4] ?? Infinity);
    }
    expect(Math.max(...worst)).toBeLessThan(16);
  });
  it("indexing 2,300 items takes well under 100 ms", () => {
    const t0 = performance.now();
    buildEntries(items);
    expect(performance.now() - t0).toBeLessThan(100);
  });
});
