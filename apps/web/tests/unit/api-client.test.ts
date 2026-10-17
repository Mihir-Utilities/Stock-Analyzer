import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  ApiError,
  createApiClient,
  REQUEST_TIMEOUT_MS,
  retryDelay,
  setUnauthorizedHandler,
  shouldRetry,
} from "@/lib/api/client";
import { WAKING_AFTER_MS, WakingTracker } from "@/lib/api/waking";

const profile = z.object({ symbol: z.string(), name: z.string().nullable() });

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    ...init,
  });
}

/** A fetch that never answers but honours abort, like a cold free-tier API. */
function hangingFetch(): typeof fetch {
  return (_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new DOMException("aborted", "AbortError")),
      );
    });
}

describe("api client envelopes", () => {
  afterEach(() => setUnauthorizedHandler(null));

  it("parses a success envelope and validates data with zod", async () => {
    const fetchImpl = vi.fn(async () =>
      json({
        data: { symbol: "TCS", name: "Tata Consultancy Services" },
        meta: { as_of: "2026-10-09T13:05:00Z", source: "import", stale: false },
        warnings: [{ code: "UNCONFIRMED_ACTION", message: "Possible split" }],
      }),
    );
    const api = createApiClient({ fetchImpl, tracker: new WakingTracker() });
    const res = await api("/stocks/TCS", { schema: profile });
    expect(res.data.symbol).toBe("TCS");
    expect(res.meta?.source).toBe("import");
    expect(res.warnings).toEqual([{ code: "UNCONFIRMED_ACTION", message: "Possible split" }]);
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/v1/stocks/TCS",
      expect.objectContaining({ method: "GET", credentials: "same-origin" }),
    );
  });

  it("rejects data that does not match the schema as BAD_RESPONSE", async () => {
    const api = createApiClient({
      fetchImpl: async () => json({ data: { symbol: 5 } }),
      tracker: new WakingTracker(),
    });
    await expect(api("/stocks/X", { schema: profile })).rejects.toMatchObject({
      code: "BAD_RESPONSE",
    });
  });

  it("maps the error envelope and keeps the request id", async () => {
    const api = createApiClient({
      fetchImpl: async () =>
        json(
          {
            error: {
              code: "NOT_FOUND",
              message: "Instrument not found",
              details: { symbol: "XYZ" },
            },
          },
          { status: 404, headers: { "X-Request-Id": "req-123" } },
        ),
      tracker: new WakingTracker(),
    });
    const err = await api("/stocks/XYZ", { schema: profile }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      code: "NOT_FOUND",
      status: 404,
      requestId: "req-123",
      details: { symbol: "XYZ" },
    });
  });

  it("reads Retry-After on 429", async () => {
    const api = createApiClient({
      fetchImpl: async () =>
        json(
          { error: { code: "RATE_LIMITED", message: "slow down" } },
          { status: 429, headers: { "Retry-After": "120" } },
        ),
      tracker: new WakingTracker(),
    });
    await expect(api("/x", { schema: profile })).rejects.toMatchObject({ retryAfterSeconds: 120 });
  });

  it("turns a non-JSON error page into BAD_RESPONSE, not a crash", async () => {
    const api = createApiClient({
      fetchImpl: async () => new Response("<html>bad gateway</html>", { status: 502 }),
      tracker: new WakingTracker(),
    });
    await expect(api("/x", { schema: profile })).rejects.toMatchObject({
      code: "BAD_RESPONSE",
      status: 502,
    });
  });

  it("sends the CSRF header on non-GET requests only", async () => {
    const fetchImpl = vi.fn(async () => json({ data: { symbol: "A", name: null } }));
    const api = createApiClient({ fetchImpl, tracker: new WakingTracker() });
    await api("/watchlist", { schema: profile, method: "POST", body: { symbol: "A" } });
    await api("/watchlist", { schema: profile });
    const calls = fetchImpl.mock.calls as unknown as [string, RequestInit][];
    expect((calls[0]?.[1].headers as Record<string, string>)["X-Requested-With"]).toBe("fetch");
    expect((calls[1]?.[1].headers as Record<string, string>)["X-Requested-With"]).toBeUndefined();
  });

  it("calls the unauthorized handler on 401 except for the login call", async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    const api = createApiClient({
      fetchImpl: async () =>
        json({ error: { code: "UNAUTHENTICATED", message: "no" } }, { status: 401 }),
      tracker: new WakingTracker(),
    });
    await expect(api("/auth/me", { schema: profile })).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
    expect(handler).toHaveBeenCalledTimes(1);
    await expect(
      api("/auth/login", { schema: profile, method: "POST", skipUnauthorizedHandler: true }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("builds query strings and skips undefined values", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => json({ data: { symbol: "A", name: null } }));
    const api = createApiClient({ fetchImpl, tracker: new WakingTracker() });
    await api("/stocks", { schema: profile, query: { limit: 50, q: "M&M", cursor: undefined } });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("/api/v1/stocks?limit=50&q=M%26M");
  });
});

describe("retry policy (docs/06 section 1: retry 2, backoff)", () => {
  it("retries network and 5xx twice, never 4xx", () => {
    const net = new ApiError("NETWORK", "x", 0);
    const down = new ApiError("SOURCE_DOWN", "x", 503);
    const nf = new ApiError("NOT_FOUND", "x", 404);
    expect(shouldRetry(0, net)).toBe(true);
    expect(shouldRetry(1, down)).toBe(true);
    expect(shouldRetry(2, down)).toBe(false);
    expect(shouldRetry(0, nf)).toBe(false);
    expect(retryDelay(0)).toBeLessThan(retryDelay(1));
  });
});

// UI-01: API cold start (<= 70 s): waking state after 3 s; no error before 70 s.
describe("cold start (UI-01)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("shows the waking state after 3 s with elapsed seconds and no error before 70 s", async () => {
    const tracker = new WakingTracker();
    const api = createApiClient({ fetchImpl: hangingFetch(), tracker });
    let settled: unknown = "pending";
    void api("/stocks/TCS", { schema: profile }).then(
      (v) => (settled = v),
      (e: unknown) => (settled = e),
    );

    await vi.advanceTimersByTimeAsync(WAKING_AFTER_MS - 500);
    expect(tracker.getSnapshot().waking).toBe(false);

    await vi.advanceTimersByTimeAsync(1000);
    expect(tracker.getSnapshot().waking).toBe(true);
    expect(tracker.getSnapshot().elapsedSeconds).toBeGreaterThanOrEqual(3);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(tracker.getSnapshot().elapsedSeconds).toBeGreaterThanOrEqual(33);
    expect(settled).toBe("pending");

    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 33_500 - 1_000);
    expect(settled).toBe("pending"); // still no error just before 70 s

    await vi.advanceTimersByTimeAsync(2_000);
    expect(settled).toBeInstanceOf(ApiError);
    expect(settled).toMatchObject({ code: "TIMEOUT" });
    expect(tracker.getSnapshot().waking).toBe(false);
  });

  it("clears the waking state as soon as the server answers", async () => {
    const tracker = new WakingTracker();
    let release: (r: Response) => void = () => undefined;
    const fetchImpl: typeof fetch = () => new Promise<Response>((resolve) => (release = resolve));
    const api = createApiClient({ fetchImpl, tracker });
    const p = api("/stocks/TCS", { schema: profile });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tracker.getSnapshot().waking).toBe(true);
    release(json({ data: { symbol: "TCS", name: null } }));
    await p;
    expect(tracker.getSnapshot().waking).toBe(false);
  });

  it("uses the oldest in-flight request when several overlap", async () => {
    const tracker = new WakingTracker();
    const first = tracker.begin();
    await vi.advanceTimersByTimeAsync(2_000);
    const second = tracker.begin();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(tracker.getSnapshot().waking).toBe(true); // first is 3.5 s old
    first();
    expect(tracker.getSnapshot().waking).toBe(false); // second is only 1.5 s old
    second();
  });
});
