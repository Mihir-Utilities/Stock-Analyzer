// Generates src/lib/definitions.ts from docs/05-analytics-spec.md (docs/06a section 5, rule 5).
// Each entry names the start of a spec line; the line's text becomes the tooltip. If the spec text
// moves or is reworded so the anchor no longer matches, generation fails instead of going stale.
//   node scripts/gen-definitions.mjs          write the file
//   node scripts/gen-definitions.mjs --check  exit 1 if the committed file is out of date
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const SPEC_PATH = resolve(here, "../../../docs/05-analytics-spec.md");
export const OUT_PATH = resolve(here, "../src/lib/definitions.ts");

// key, label, section, start of the spec line (after the leading "- ", markdown included).
export const ENTRIES = [
  ["sma", "SMA", "3", "**SMA(n)**"],
  ["ema", "EMA", "3", "**EMA(n)**"],
  ["rsi", "RSI (14)", "3", "**RSI(14), Wilder**"],
  ["macd", "MACD (12, 26, 9)", "3", "**MACD(12,26,9)**"],
  ["bollinger", "Bollinger bands (20, 2)", "3", "**Bollinger(20,2)**"],
  ["atr", "ATR (14)", "3", "**True range**"],
  ["adx", "ADX (14)", "3", "**ADX(14)**"],
  ["stochastic", "Stochastic (14, 3)", "3", "**Stochastic(14,3)**"],
  ["obv", "OBV", "3", "**OBV**"],
  ["volume_z", "Volume z-score", "3", "**Volume z-score**"],
  ["wk52", "52-week high / low", "3", "**52-week high/low**"],
  ["support_resistance", "Support / resistance", "3", "**Support/resistance**"],
  ["cross", "Golden / death cross", "3", "**Golden/death cross flags**"],
  ["ret_n", "Return (trading rows)", "4", "`ret_N` (trading-row)"],
  ["display_returns", "Return (calendar window)", "4", "Display returns by calendar window"],
  ["volatility", "Volatility", "4", "`vol_N ="],
  ["max_drawdown", "Max drawdown", "4", "Max drawdown over window W"],
  ["beta", "Beta (252)", "4", "Beta (252)"],
  ["sharpe", "Return per unit of risk", "4", "Sharpe-like"],
  ["liquidity", "Average daily traded value", "4", "Liquidity"],
  ["growth_yoy", "Growth (YoY / QoQ)", "5", "`growth_yoy ="],
  ["cagr", "CAGR", "5", "`cagr_Ny`"],
  ["margins", "Operating and net margin", "5", "`op_margin ="],
  ["roe", "ROE", "5", "**ROE**"],
  ["roce", "ROCE", "5", "**ROCE**"],
  ["debt_equity", "Debt / equity", "5", "`debt_equity ="],
  ["cfo_to_pat", "CFO / PAT", "5", "`cfo_to_pat ="],
  ["eps_ttm", "EPS (TTM)", "5", "**TTM EPS**"],
  ["pe", "P/E", "5", "`pe = close"],
  ["pb", "P/B", "5", "`bvps ="],
  ["div_yield", "Dividend yield", "5", "`div_yield ="],
  ["ev_ebitda", "EV / EBITDA", "5", "`ev_ebitda ="],
  ["peg", "PEG", "5", "`peg ="],
  ["pe_percentile", "P/E percentile (5Y)", "5", "**PE percentile (5Y)**"],
  ["trend_score", "Trend score", "6.1", "Points: close > SMA50"],
  ["risk_score", "Risk score", "6.2", "Percentile ranks (0-100)"],
  ["avg_cost", "Average cost", "8.1", "Average-cost basis for open holdings"],
  ["xirr", "XIRR", "8.3", "Cash flows: buy"],
  ["day_change", "Day change", "8.4", "Day change ="],
  // These three are shown to the owner as short plain-English text: the anchor is the marker line
  // "- **Owner text (key):** ..." of docs/05 8.5.6a and only the text after the marker is used.
  ["mf_total_return", "Mutual fund total return", "1", "**Owner text (mf_total_return):**"],
  ["xirr_pooled", "XIRR across stocks and mutual funds", "8.5.4", "**Owner text (xirr_pooled):**"],
  [
    "absolute_return",
    "Absolute return (under one year)",
    "8.5.6",
    "**Owner text (absolute_return):**",
  ],
  // Investment-context texts (INV, F17): plain English with no ids; the section is left empty so
  // the tooltip prints no spec number (docs/05 12.12).
  ["year_price_return", "Year (price return)", "", "**Owner text (year_price_return):**"],
  [
    "month_green_share",
    "Share of years this month ended higher",
    "",
    "**Owner text (month_green_share):**",
  ],
  ["price_position", "Price position", "", "**Owner text (price_position):**"],
  ["drawdown_profile", "Drawdown profile", "", "**Owner text (drawdown_profile):**"],
  ["holding_period", "Holding periods", "", "**Owner text (holding_period):**"],
  ["entry_study", "Entry-point study", "", "**Owner text (entry_study):**"],
  ["vol_regime", "Volatility regime", "", "**Owner text (vol_regime):**"],
  ["sip_vs_lump", "Monthly plan versus lump sum", "", "**Owner text (sip_vs_lump):**"],
  ["calmar", "Growth per unit of deepest fall", "", "**Owner text (calmar):**"],
  ["downside_risk", "Growth per unit of downside", "", "**Owner text (downside_risk):**"],
  // Portfolio risk (PRK, docs/05 8.6.5)
  ["pf_concentration", "Concentration", "8.6.1", "**Owner text (pf_concentration):**"],
  ["pf_hhi", "Effective number of holdings", "8.6.1", "**Owner text (pf_hhi):**"],
  ["pf_stress", "Position stress (what-if)", "8.6.2", "**Owner text (pf_stress):**"],
  ["pf_twr", "Portfolio return line", "8.6.3", "**Owner text (pf_twr):**"],
  ["pf_drawdown", "Portfolio drawdown", "8.6.3", "**Owner text (pf_drawdown):**"],
];

function strip(md) {
  return md.replace(/\*\*/g, "").replace(/`/g, "").replace(/\s+/g, " ").trim();
}

export function buildDefinitions(spec) {
  const lines = spec.split(/\r?\n/);
  const out = [];
  for (const [key, label, section, anchor] of ENTRIES) {
    const line = lines.find((l) => l.replace(/^- /, "").startsWith(anchor));
    if (!line) throw new Error(`definitions: anchor for "${key}" not found in docs/05: ${anchor}`);
    const body = line.replace(/^- /, "");
    const text = anchor.startsWith("**Owner text (") ? body.slice(anchor.length) : body;
    out.push({ key, label, section, text: strip(text) });
  }
  const body = out
    .map(
      (d) =>
        `  ${JSON.stringify(d.key)}: {\n    label: ${JSON.stringify(d.label)},\n    section: ${JSON.stringify(
          d.section,
        )},\n    text: ${JSON.stringify(d.text)},\n  },`,
    )
    .join("\n");
  return `// GENERATED by scripts/gen-definitions.mjs from docs/05-analytics-spec.md. Do not edit by hand.
// Run \`node scripts/gen-definitions.mjs\` after the spec changes (a unit test fails when stale).

export interface Definition {
  label: string;
  /** Section of docs/05-analytics-spec.md the text comes from. */
  section: string;
  /** Formula or definition, as written in the spec. */
  text: string;
}

export const definitions = {
${body}
} as const satisfies Record<string, Definition>;

export type DefinitionKey = keyof typeof definitions;

export function getDefinition(key: DefinitionKey): Definition {
  return definitions[key];
}
`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const next = buildDefinitions(readFileSync(SPEC_PATH, "utf8"));
  if (process.argv.includes("--check")) {
    const cur = readFileSync(OUT_PATH, "utf8").replace(/\r\n/g, "\n");
    if (cur !== next) {
      console.error("src/lib/definitions.ts is stale; run node scripts/gen-definitions.mjs");
      process.exit(1);
    }
  } else {
    writeFileSync(OUT_PATH, next);
    console.log(`wrote ${OUT_PATH}`);
  }
}
