import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MfStatementImport } from "@/components/imports/MfStatementImport";
import { PortfolioPage } from "@/components/portfolio/PortfolioPage";
import { rowCountText, rowsToImport } from "@/lib/imports/mf";
import { useViewParam } from "@/lib/portfolio/view";
import ImportsRoute from "../../src/app/(app)/imports/page";
import PortfolioRoute from "../../src/app/(app)/portfolio/page";
import { createMockFetch, type Handler } from "../mocks/mock-fetch";
import * as pf from "../mocks/portfolio-fixtures";
import * as fx from "../mocks/mf-portfolio-fixtures";
import { preloadBeforeAll } from "./preload";
import "./dom-matchers";

// F16 review follow-ups (MFHW-*), part 2: the view parameter, Suspense fallbacks, the statement
// import review rules and the n/m reason. Synthetic data only.

vi.setConfig({ testTimeout: 30_000 });

const nav = vi.hoisted(() => ({ search: "", suspend: false }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => {
    if (nav.suspend) throw new Promise(() => undefined);
    return new URLSearchParams(nav.search);
  },
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

beforeEach(() => {
  vi.unstubAllGlobals();
  nav.search = "";
  nav.suspend = false;
  window.history.replaceState(null, "", "/portfolio");
});
afterEach(() => vi.unstubAllGlobals());

preloadBeforeAll("portfolio");

describe("MFHW-19 the view parameter follows the owner, not a late report of the URL", () => {
  it("N12: rapid arrows (equity then mf) are not reverted when Next reports the older URL late", () => {
    const { result, rerender } = renderHook(() => useViewParam());
    expect(result.current[0]).toBe("all");
    act(() => result.current[1]("equity"));
    act(() => result.current[1]("mf"));
    expect(result.current[0]).toBe("mf");
    expect(window.location.search).toContain("view=mf");
    nav.search = "view=equity"; // Next reports the first write after the second one happened
    rerender();
    expect(result.current[0]).toBe("mf");
    nav.search = "view=mf";
    rerender();
    expect(result.current[0]).toBe("mf");
  });

  it("back/forward (a URL we did not write) is still followed", () => {
    nav.search = "view=mf";
    const { result, rerender } = renderHook(() => useViewParam());
    expect(result.current[0]).toBe("mf");
    nav.search = "view=equity";
    rerender();
    expect(result.current[0]).toBe("equity");
    act(() => result.current[1]("all"));
    nav.search = "view=all";
    rerender();
    expect(result.current[0]).toBe("all");
    nav.search = "view=mf"; // a later change of the URL by the browser
    rerender();
    expect(result.current[0]).toBe("mf");
  });
});

describe("MFHW-20 route fallbacks are skeletons, not nothing", () => {
  it("N14: /portfolio and /imports show a loading skeleton while the search params resolve", () => {
    nav.suspend = true;
    const a = render(<PortfolioRoute />);
    expect(
      within(a.container).getByRole("status", { name: "Loading portfolio" }),
    ).toBeInTheDocument();
    a.unmount();
    const b = render(<ImportsRoute />);
    expect(
      within(b.container).getByRole("status", { name: "Loading import center" }),
    ).toBeInTheDocument();
  });
});

function mountPortfolio(routes: Record<string, Handler> = {}) {
  const mock = createMockFetch({
    "GET /portfolio/summary": fx.byView(),
    "GET /portfolio/txns": pf.envelope(pf.txns),
    "GET /portfolio/mf/txns": pf.envelope({ items: [], next_cursor: null }),
    "GET /portfolio/adjustments": pf.envelope(pf.adjustments),
    ...routes,
  });
  vi.stubGlobal("fetch", mock.impl);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <PortfolioPage />
    </QueryClientProvider>,
  );
  return mock;
}

describe("MFHW-21 MFH-U80: unrealised % n/m shows a dash with its reason on holdings and totals", () => {
  it("a zero cost base is 'not meaningful', never 0.00% or an empty cell", async () => {
    nav.search = "view=mf";
    const nm = {
      ...fx.alphaGrowth,
      invested: "0.0000",
      avg_cost: null,
      unrealized_pct: null,
      unrealized_pct_reason: "n/m",
    };
    mountPortfolio({
      "GET /portfolio/summary": pf.envelope(
        fx.viewSummary(
          "mf",
          {
            totals: {
              ...fx.viewSummary("mf").totals,
              unrealized_pct: null,
              unrealized_pct_reason: "n/m",
            },
          },
          [nm],
        ),
      ),
    });
    const row = await screen.findByTestId("pf-mf-row-100001");
    const reasons = within(row)
      .getAllByTestId("cell-reason")
      .map((n) => n.textContent ?? "");
    expect(reasons.some((t) => t.includes("not meaningful: the cost base is zero"))).toBe(true);
    expect(row.textContent).not.toMatch(/(?<![\d.])[+-]?0\.00%/);
    // totals: the card shows its dash and the reason line
    expect(await screen.findByTestId("pf-unrealized-pct-reason")).toHaveTextContent(
      "not meaningful: the cost base is zero",
    );
    expect(document.body.textContent).not.toMatch(/NaN|Infinity/);
  });
});

// ---- statement import ----------------------------------------------------------------------

function mountImport(routes: Record<string, Handler>) {
  const mock = createMockFetch({ "GET /mf/schemes": pf.envelope(fx.mfSchemeSearch), ...routes });
  vi.stubGlobal("fetch", mock.impl);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MfStatementImport />
    </QueryClientProvider>,
  );
  return mock;
}

async function upload(user: ReturnType<typeof userEvent.setup>) {
  await user.upload(
    screen.getByTestId("mf-import-file"),
    new File(["Date,Fund Name\n"], "statement.csv", { type: "text/csv" }),
  );
  await user.click(screen.getByTestId("wizard-next"));
  await screen.findByTestId("mf-import-summary");
}

const ok = (data: unknown) => pf.envelope(data);

describe("MFHW-22 MFH-U76: the preview shows the first 20 normalised rows", () => {
  it("S7: a response with 25 preview rows is cut to 20", async () => {
    const user = userEvent.setup();
    const v = fx.mfValidate({ unmapped: false });
    const first = v.preview[0]!;
    v.preview = Array.from({ length: 25 }, (_, i) => ({ ...first, row: i + 3 }));
    v.rows = 25;
    mountImport({ "POST /imports/mf_statement/validate": ok(v) });
    await upload(user);
    const table = screen.getByTestId("mf-import-preview-table");
    expect(within(table).getAllByRole("row")).toHaveLength(21); // header + 20
    expect(screen.getByTestId("mf-import-row-22")).toBeInTheDocument(); // line 3 + 19
    expect(screen.queryByTestId("mf-import-row-23")).toBeNull();
    expect(screen.getByText("Preview (first 20 rows)")).toBeInTheDocument();
    expect(screen.getByTestId("mf-import-summary")).toHaveTextContent("25 rows read");
  });

  it("exactly 20 and fewer rows are all shown", async () => {
    const user = userEvent.setup();
    const v = fx.mfValidate({ unmapped: false });
    const first = v.preview[0]!;
    v.preview = Array.from({ length: 20 }, (_, i) => ({ ...first, row: i + 3 }));
    mountImport({ "POST /imports/mf_statement/validate": ok(v) });
    await upload(user);
    expect(within(screen.getByTestId("mf-import-preview-table")).getAllByRole("row")).toHaveLength(
      21,
    );
  });
});

describe("MFHW-23 the commit count is an estimate and does not count a row twice", () => {
  it("N10: unticked rows may already be stored: a range, worded as an estimate", async () => {
    const user = userEvent.setup();
    const v = fx.mfValidate({ unmapped: false, inDb: 3 });
    const first = v.preview[0]!;
    v.preview = Array.from({ length: 10 }, (_, i) => ({ ...first, row: i + 3 }));
    v.rows = 10;
    mountImport({ "POST /imports/mf_statement/validate": ok(v) });
    await upload(user);
    await user.click(screen.getByTestId("mf-row-include-3"));
    await user.click(screen.getByTestId("mf-row-include-4"));
    await user.click(screen.getByTestId("wizard-next"));
    const note = screen.getByTestId("mf-import-commit-note");
    expect(note).toHaveTextContent("between 5 and 7 rows");
    expect(note).toHaveTextContent("This is an estimate");
    await user.click(screen.getByTestId("wizard-commit"));
    expect(screen.getByText("Commit between 5 and 7 rows?")).toBeInTheDocument();
  });

  it("exact when only one kind of skip applies", () => {
    expect(rowCountText(rowsToImport(10, 0, 3))).toBe("about 7 rows");
    expect(rowCountText(rowsToImport(10, 2, 3))).toBe("between 5 and 7 rows");
    expect(rowCountText(null)).toContain("—");
  });
});

describe("MFHW-24 the .xlsx sentence comes from the server's 422 only", () => {
  it("S10: no sentence before an upload; after a 422 'xlsx not enabled' the plain copy; another 422 shows its own text", async () => {
    const user = userEvent.setup();
    let n = 0;
    mountImport({
      "POST /imports/mf_statement/validate": () => {
        n += 1;
        return n === 1
          ? {
              status: 422,
              body: {
                error: { code: "VALIDATION_FAILED", message: "xlsx not enabled: save as CSV" },
              },
            }
          : {
              status: 422,
              body: { error: { code: "VALIDATION_FAILED", message: "The file has too many rows" } },
            };
      },
    });
    expect(document.body.textContent).not.toMatch(/not enabled/);
    await user.upload(screen.getByTestId("mf-import-file"), new File(["x"], "s.xlsx"));
    await user.click(screen.getByTestId("wizard-next"));
    expect(await screen.findByTestId("mf-import-validate-error")).toHaveTextContent(
      "Excel files are not enabled yet; save the statement as CSV.",
    );
    await user.upload(screen.getByTestId("mf-import-file"), new File(["x"], "t.csv"));
    await user.click(screen.getByTestId("wizard-next"));
    await waitFor(() =>
      expect(screen.getByTestId("mf-import-validate-error")).toHaveTextContent(
        "The file has too many rows",
      ),
    );
    expect(screen.getByTestId("mf-import-validate-error").textContent).not.toMatch(/Excel/);
  });
});

describe("MFHW-25 a failed mapping save says which mappings were saved", () => {
  it("N9: the first is saved, the second fails: named in the message, the upload is re-read", async () => {
    const user = userEvent.setup();
    const v = fx.mfValidate();
    const second = {
      ...v.mf.unmapped_funds[0]!,
      fund_name: "Example Beta Fund",
      fund_name_key: "example beta fund",
    };
    v.mf.unmapped_funds = [v.mf.unmapped_funds[0]!, second];
    const after = fx.mfValidate();
    after.mf.unmapped_funds = [second];
    let puts = 0;
    const mock = mountImport({
      "POST /imports/mf_statement/validate": ok(v),
      "PUT /portfolio/mf/fund-mappings": () => {
        puts += 1;
        return puts === 1
          ? ok(fx.mfMapping)
          : {
              status: 422,
              body: { error: { code: "VALIDATION_FAILED", message: "scheme has no NAV" } },
            };
      },
      "POST /imports/mf_statement/revalidate": ok(after),
    });
    await upload(user);
    await user.click(screen.getByTestId("mf-candidate-0-100001"));
    await user.click(screen.getByTestId("mf-candidate-1-100001"));
    await user.click(screen.getByTestId("mf-map-save"));
    const err = await screen.findByTestId("mf-map-error");
    expect(err).toHaveTextContent("Example Beta Fund was not saved");
    expect(err).toHaveTextContent("scheme has no NAV");
    expect(err).toHaveTextContent("Saved before the failure: Example Alpha Fund");
    await waitFor(() =>
      expect(mock.calls.some((c) => c.path === "/imports/mf_statement/revalidate")).toBe(true),
    );
    await waitFor(() =>
      expect(screen.getByTestId("mf-map-fund-0")).toHaveTextContent("Example Beta Fund"),
    );
  });
});
