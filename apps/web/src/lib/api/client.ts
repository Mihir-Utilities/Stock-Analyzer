import type { z } from "zod";
import {
  errorEnvelopeSchema,
  successEnvelopeSchema,
  type metaSchema,
  type warningSchema,
} from "./schemas";
import { wakingTracker, type WakingTracker } from "./waking";

// The only place the browser talks to the backend: same-origin `/api/v1/...` (the Next rewrite
// forwards to the Go API, so cookies are first-party and there is no CORS). docs/06 section 1.

export const API_PREFIX = "/api/v1";
/** Every request times out after 70 s (cold free-tier API; docs/06 section 1, UI-01). */
export const REQUEST_TIMEOUT_MS = 70_000;

export type ApiErrorCode =
  "TIMEOUT" | "NETWORK" | "BAD_RESPONSE" | "UNAUTHENTICATED" | "RATE_LIMITED" | (string & {});

export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly status: number,
    readonly details: Record<string, unknown> | undefined = undefined,
    readonly requestId: string | null = null,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiResult<T> {
  data: T;
  meta: z.infer<typeof metaSchema> | undefined;
  warnings: z.infer<typeof warningSchema>[];
}

export interface RequestOptions<S extends z.ZodType> {
  /** Zod schema for the envelope's `data`. */
  schema: S;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  signal?: AbortSignal;
  /** The login call answers 401 for a wrong password; that must not trigger the session redirect. */
  skipUnauthorizedHandler?: boolean;
}

type UnauthorizedHandler = () => void;
let unauthorizedHandler: UnauthorizedHandler | null = null;

/** The app shell registers: clear TanStack caches and go to /login with a validated `next`. */
export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  unauthorizedHandler = handler;
}

export interface ClientDeps {
  fetchImpl?: typeof fetch;
  tracker?: WakingTracker;
  timeoutMs?: number;
}

function buildUrl(path: string, query: RequestOptions<z.ZodType>["query"]): string {
  const url = `${API_PREFIX}${path.startsWith("/") ? path : `/${path}`}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined) params.set(k, String(v));
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

export function createApiClient(deps: ClientDeps = {}) {
  const tracker = deps.tracker ?? wakingTracker;
  const timeoutMs = deps.timeoutMs ?? REQUEST_TIMEOUT_MS;

  return async function apiRequest<S extends z.ZodType>(
    path: string,
    options: RequestOptions<S>,
  ): Promise<ApiResult<z.infer<S>>> {
    const fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
    const method = options.method ?? "GET";
    const headers: Record<string, string> = { Accept: "application/json" };
    if (method !== "GET") headers["X-Requested-With"] = "fetch"; // CSRF header, docs/03 section 1
    // A FormData body (file upload) gets its multipart boundary from the browser: no Content-Type.
    const isForm = typeof FormData !== "undefined" && options.body instanceof FormData;
    if (options.body !== undefined && !isForm) headers["Content-Type"] = "application/json";

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onCallerAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onCallerAbort, { once: true });
    const done = tracker.begin();

    try {
      let response: Response;
      try {
        response = await fetchImpl(buildUrl(path, options.query), {
          method,
          headers,
          body:
            options.body === undefined
              ? undefined
              : isForm
                ? (options.body as FormData)
                : JSON.stringify(options.body),
          credentials: "same-origin",
          signal: controller.signal,
        });
      } catch (cause) {
        if (timedOut) {
          throw new ApiError("TIMEOUT", "The server did not answer within 70 seconds.", 0);
        }
        if (options.signal?.aborted) throw cause;
        throw new ApiError("NETWORK", "Could not reach the server.", 0);
      }

      const requestId = response.headers.get("X-Request-Id");
      let json: unknown;
      try {
        json = await response.json();
      } catch {
        json = undefined;
      }

      if (!response.ok) {
        const parsed = errorEnvelopeSchema.safeParse(json);
        const retryHeader = Number(response.headers.get("Retry-After"));
        const retryAfter = Number.isFinite(retryHeader) && retryHeader > 0 ? retryHeader : null;
        const err = parsed.success
          ? new ApiError(
              parsed.data.error.code,
              parsed.data.error.message,
              response.status,
              parsed.data.error.details,
              requestId,
              retryAfter,
            )
          : new ApiError(
              "BAD_RESPONSE",
              "Unexpected response from the server.",
              response.status,
              undefined,
              requestId,
              retryAfter,
            );
        if (response.status === 401 && !options.skipUnauthorizedHandler) unauthorizedHandler?.();
        throw err;
      }

      const parsed = successEnvelopeSchema(options.schema).safeParse(json);
      if (!parsed.success) {
        throw new ApiError(
          "BAD_RESPONSE",
          "The server answer did not match the expected shape.",
          response.status,
          {
            issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`),
          },
          requestId,
        );
      }
      const envelope = parsed.data as {
        data: z.infer<S>;
        meta?: ApiResult<unknown>["meta"];
        warnings?: ApiResult<unknown>["warnings"];
      };
      return { data: envelope.data, meta: envelope.meta, warnings: envelope.warnings ?? [] };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onCallerAbort);
      done();
    }
  };
}

export const apiRequest = createApiClient();

/** TanStack Query retry policy: 2 retries, never for 4xx answers (docs/06 section 1). */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= 2) return false;
  if (error instanceof ApiError) {
    if (error.status >= 400 && error.status < 500) return false;
    if (error.code === "BAD_RESPONSE") return false;
  }
  return true;
}

export function retryDelay(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 8000);
}
