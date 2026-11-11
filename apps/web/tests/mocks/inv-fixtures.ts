// Contract-shaped investment-context blocks (docs/03 section 4a) built from the golden vectors of
// docs/05 section 12 (VM1, VS1/VS2/VS3, VP1, VD1, VH1, VE1, VV1, VL1, VR1). Illustrative; no network.

import * as cx from "./chart-fixtures";
import { ok, type MockReply } from "./imports-fixtures";

const AS_OF = "2024-02-15";

/** SIP variants: the default (first trading day) and day 1..28, each internally consistent. */
function sipVariants() {
  const mk = (day: number | null, k: number) => ({
    day,
    installments: 14 - (k % 3),
    skipped: k % 3,
    first_date: "2023-01-02",
    last_date: AS_OF,
    span_days: 410,
    invested_inr: 1000 * (14 - (k % 3)),
    sip_value_inr: 15500 + k * 37.5,
    lump_value_inr: 14250.5,
    value_ratio: 1.05 + k * 0.01,
    sip_absolute_return_pct: 10.71 + k,
    lump_absolute_return_pct: 1.8,
    sip_xirr_pct: 9.2 + k / 10,
    lump_xirr_pct: 1.6,
    sip_worst_unrealised_pct: -12.5,
    lump_worst_unrealised_pct: -22.4,
  });
  return [mk(null, 0), ...Array.from({ length: 28 }, (_, i) => mk(i + 1, i + 1))];
}

const emptyMonth = (month: number) => ({
  month,
  n_years: 0,
  n_green: 0,
  green_pct: null,
  green_pct_reason: "too_few_years",
  avg_pct: null,
  median_pct: null,
  best: null,
  worst: null,
  small_sample: true,
});

/** The nine INV blocks plus the month grid, as `data.analysis` would carry them. */
export function invAnalysis(): Record<string, unknown> {
  const months = Array.from({ length: 12 }, (_, i) => {
    const month = i + 1;
    if (month === 1) {
      return {
        month,
        n_years: 4,
        n_green: 2,
        green_pct: 50,
        green_pct_reason: null,
        avg_pct: 1.5,
        median_pct: 1.5,
        best: { pct: 5, year: 2019 },
        worst: { pct: -2, year: 2020 },
        small_sample: true,
      };
    }
    if (month === 3) {
      return {
        month,
        n_years: 3,
        n_green: 2,
        green_pct: 66.67,
        green_pct_reason: null,
        avg_pct: 1.67,
        median_pct: 2,
        best: { pct: 4, year: 2021 },
        worst: { pct: -1, year: 2022 },
        small_sample: true,
      };
    }
    if (month === 2) {
      return {
        month,
        n_years: 2,
        n_green: 2,
        green_pct: null,
        green_pct_reason: "too_few_years",
        avg_pct: 1.75,
        median_pct: 1.75,
        best: { pct: 2.5, year: 2023 },
        worst: { pct: 1, year: 2022 },
        small_sample: true,
      };
    }
    return emptyMonth(month);
  });
  return {
    month_year: [
      [2022, 11, 1.2],
      [2022, 12, 10],
      [2023, 1, -10],
      [2023, 2, 2.5],
      [2023, 3, null],
      [2023, 4, null],
      [2023, 12, 3.2],
      [2024, 1, 10],
      [2024, 2, -10],
    ],
    month_year_reasons: [
      [2023, 3, "gap_before"],
      [2023, 4, "incomplete_month_data"],
    ],
    year_returns: [
      {
        year: 2022,
        return_pct: 10,
        return_pct_reason: null,
        kind: "partial_first",
        months_covered: 1,
        base_date: "2022-11-30",
        end_date: "2022-12-30",
      },
      {
        year: 2023,
        return_pct: -1.99,
        return_pct_reason: null,
        kind: "full",
        months_covered: 12,
        base_date: "2022-12-30",
        end_date: "2023-12-29",
      },
      {
        year: 2024,
        return_pct: -1,
        return_pct_reason: null,
        kind: "ytd",
        months_covered: 2,
        base_date: "2023-12-29",
        end_date: AS_OF,
      },
    ],
    seasonality: {
      as_of: AS_OF,
      bars: 330,
      first_bar: "2019-03-04",
      last_bar: AS_OF,
      years_of_history: 4.9,
      min_years: 3,
      small_sample_years: 5,
      running: {
        year: 2024,
        month: 2,
        mtd_return_pct: -10,
        mtd_reason: null,
        base_date: "2024-01-31",
        as_of: AS_OF,
      },
      months,
      best_month: { month: 3, median_pct: 2, n_years: 3 },
      worst_month: { month: 1, median_pct: 1.5, n_years: 4 },
      best_worst_reason: null,
      years: {
        n: 4,
        n_green: 3,
        green_pct: 75,
        green_pct_reason: null,
        avg_pct: 7,
        median_pct: 8,
        best: { pct: 20, year: 2021 },
        worst: { pct: -8, year: 2020 },
        small_sample: true,
      },
    },
    position: {
      as_of: AS_OF,
      bars: 700,
      close: 14,
      high_52w_close: 15,
      low_52w_close: 10,
      range_pos_52w_pct: 80,
      range_pos_52w_reason: null,
      range_band: "upper",
      dist_high_52w_pct: -6.6667,
      dist_high_all_pct: -30,
      high_all_date: "2021-10-18",
      history_first_date: "2019-03-04",
      pctile_52w: 70,
      pctile_52w_reason: null,
      pctile_all: 50,
      pctile_all_reason: null,
      pctile_all_n: 700,
      sma200: 13.3333,
      ext_sma200_pct: 5,
      ext_sma200_reason: null,
    },
    drawdown_profile: {
      as_of: AS_OF,
      bars: 13,
      first_date: "2024-01-01",
      current_dd_pct: -4.5455,
      days_since_high: 1,
      max_dd: {
        depth_pct: -20,
        peak_date: "2024-01-01",
        trough_date: "2024-01-03",
        recovery_date: "2024-01-05",
        recovered: true,
      },
      underwater_rows: 8,
      time_under_water_pct: 61.5385,
      avg_underwater_depth_pct: -11.8182,
      episodes_total: 4,
      recovery: [
        {
          threshold_pct: 10,
          episodes: 2,
          recovered: 2,
          open: 0,
          median_days: null,
          median_days_reason: "too_few_episodes",
          small_sample: true,
        },
        {
          threshold_pct: 20,
          episodes: 2,
          recovered: 2,
          open: 0,
          median_days: null,
          median_days_reason: "too_few_episodes",
          small_sample: true,
        },
      ],
    },
    holding_periods: {
      as_of: AS_OF,
      bars: 700,
      windows: [
        ["1m", 21, 679, 33, 55, 1.2, 20, "2021-05-03", -10, "2020-03-23", false],
        ["3m", 63, 637, 11, 58, 3.1, 40, "2021-06-01", -25, "2020-03-23", false],
        ["6m", 126, 574, 5, 61, 6, 55, "2021-08-02", -30, "2020-04-01", false],
        ["1y", 252, 448, 2, 66, 12, 90, "2021-09-01", -20, "2020-04-01", true],
      ]
        .map(([key, rows, windows, ind, share, med, best, bestEnd, worst, worstEnd, small]) => ({
          key,
          rows,
          windows,
          independent_periods: ind,
          share_positive_pct: share,
          median_pct: med,
          best_pct: best,
          best_end_date: bestEnd,
          worst_pct: worst,
          worst_end_date: worstEnd,
          reason: null,
          small_sample: small,
        }))
        .concat([
          {
            key: "3y",
            rows: 756,
            windows: null as never,
            independent_periods: null as never,
            share_positive_pct: null as never,
            median_pct: null as never,
            best_pct: null as never,
            best_end_date: null as never,
            worst_pct: null as never,
            worst_end_date: null as never,
            reason: "insufficient_history" as never,
            small_sample: true,
          },
        ]),
    },
    entry_study: {
      as_of: AS_OF,
      bars: 700,
      w52_rows: 252,
      rows: [
        {
          drawdown_pct: 10,
          horizon: "3m",
          horizon_rows: 63,
          episodes: 3,
          pending: 1,
          median_pct: 10,
          worst_pct: -10,
          best_pct: 12.5,
          share_positive_pct: 66.67,
          all_windows_median_pct: -5,
          last_event_date: "2023-10-02",
          reason: null,
          small_sample: true,
        },
        {
          drawdown_pct: 10,
          horizon: "6m",
          horizon_rows: 126,
          episodes: 1,
          pending: 0,
          median_pct: null,
          worst_pct: null,
          best_pct: null,
          share_positive_pct: null,
          all_windows_median_pct: 2.5,
          last_event_date: "2022-05-02",
          reason: "too_few_episodes",
          small_sample: true,
        },
        {
          drawdown_pct: 20,
          horizon: "3m",
          horizon_rows: 63,
          episodes: 1,
          pending: 0,
          median_pct: null,
          worst_pct: null,
          best_pct: null,
          share_positive_pct: null,
          all_windows_median_pct: -5,
          last_event_date: "2020-03-12",
          reason: "too_few_episodes",
          small_sample: true,
        },
        {
          drawdown_pct: 20,
          horizon: "6m",
          horizon_rows: 126,
          episodes: 12,
          pending: 0,
          median_pct: 8,
          worst_pct: -4,
          best_pct: 30,
          share_positive_pct: 83.33,
          all_windows_median_pct: 2.5,
          last_event_date: "2020-03-12",
          reason: null,
          small_sample: false,
        },
      ],
    },
    vol_regime: {
      as_of: AS_OF,
      window_rows: 21,
      current_vol_pct: 18,
      percentile: 58.3333,
      sample: 6,
      band: "typical",
      reason: null,
      first_date: "2019-04-02",
    },
    sip_backtest: {
      as_of: AS_OF,
      amount_per_month_inr: 1000,
      price_basis: "adj_close",
      variants: sipVariants(),
    },
    risk_adjusted: {
      as_of: AS_OF,
      window: "3y",
      cagr_3y_pct: 15,
      maxdd_3y_window_pct: -30,
      calmar_3y: 0.5,
      calmar_3y_reason: null,
      downside_dev_3y_pct: 35.4965,
      return_per_downside_3y: 0.4226,
      downside_reason: null,
    },
  };
}

/** `GET /stocks/TCS/indicators` with the INV blocks merged into the existing analysis arrays. */
export function indicatorsWithInv(
  patch: (a: Record<string, unknown>) => Record<string, unknown> = (a) => a,
): MockReply {
  const base = cx.indicatorsWithSeries(70);
  const data = (base.body as { data: Record<string, unknown> }).data;
  const analysis = { ...(data["analysis"] as Record<string, unknown>), ...invAnalysis() };
  return ok({ ...data, as_of: AS_OF, analysis: patch(analysis) });
}

const sea = (over: Record<string, unknown>) => ({
  month: 11,
  month_name: "November",
  as_of: "2026-11-10",
  data_since: "2019-03-01",
  years_of_history: 7.7,
  n_years: 6,
  n_green: 4,
  green_pct: 66.67,
  green_pct_reason: null,
  small_sample: false,
  min_years: 3,
  avg_pct: 1.2,
  median_pct: 1.5,
  mtd_return_pct: 1.23,
  mtd_reason: null,
  mtd_as_of: "2026-11-10",
  ...over,
});

/** Rows of `GET /stocks/seasonality`: ranked, small sample, short, and absent; AAA and CCC are watchlisted. */
const seasonRows = () => {
  const stock = (symbol: string, onWatchlist: boolean, extra: Record<string, unknown>) => ({
    symbol,
    name: `${symbol} Limited`,
    on_watchlist: onWatchlist,
    ...extra,
  });
  return [
    stock("AAA", true, { seasonality: sea({}) }),
    stock("BBB", false, {
      seasonality: sea({ n_years: 9, n_green: 8, green_pct: 88.89, mtd_return_pct: -2.5 }),
    }),
    stock("CCC", true, {
      seasonality: sea({
        n_years: 4,
        n_green: 3,
        green_pct: 75,
        small_sample: true,
        mtd_return_pct: null,
        mtd_reason: "no_bar_this_month",
      }),
    }),
    stock("DDD", false, {
      seasonality: sea({
        n_years: 2,
        n_green: 1,
        green_pct: null,
        green_pct_reason: "too_few_years",
        small_sample: true,
      }),
    }),
    stock("EEE", false, { seasonality: null, seasonality_reason: "no_prices_imported" }),
  ];
};

/** `GET /stocks/seasonality` (docs/03 4b): `scope=watchlist` keeps only the watchlisted rows. */
export function seasonalityList(scope: "all" | "watchlist" = "all") {
  const rows = seasonRows().filter((r) => scope === "all" || r.on_watchlist);
  return ok({
    month: 11,
    month_name: "November",
    as_of: "2026-11-10",
    scope,
    stocks: rows,
  });
}

/** A route handler that answers by the `scope` query, like the API. */
export const seasonalityRoute = (call: { query: URLSearchParams }) =>
  seasonalityList(call.query.get("scope") === "watchlist" ? "watchlist" : "all");

/** `n` tracked stocks (every third one watchlisted) for the long-list checks. */
export function seasonalityMany(n: number) {
  const stocks = Array.from({ length: n }, (_, i) => ({
    symbol: `S${String(i).padStart(3, "0")}`,
    name: `Stock ${i} Limited`,
    on_watchlist: i % 3 === 0,
    seasonality: sea({ n_years: 3 + (i % 8), n_green: 2 + (i % 3), green_pct: 40 + (i % 50) }),
  }));
  return ok({ month: 11, month_name: "November", as_of: "2026-11-10", scope: "all", stocks });
}
