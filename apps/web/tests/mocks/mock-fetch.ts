import type { MockReply } from "./imports-fixtures";

export interface RecordedCall {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  body: unknown;
}

export type Handler = MockReply | ((call: RecordedCall) => MockReply);

/**
 * A tiny fetch double with a route table keyed "METHOD /path" (path without the /api/v1 prefix).
 * An unknown route answers 501 so a missing mock is visible, never a silent success.
 */
export function createMockFetch(routes: Record<string, Handler>) {
  const calls: RecordedCall[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), "http://localhost");
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname.replace(/^\/api\/v1/, "");
    let body: unknown = init?.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        /* keep the raw string */
      }
    }
    const call: RecordedCall = {
      method,
      path,
      query: url.searchParams,
      headers: new Headers(init?.headers),
      body,
    };
    calls.push(call);
    const h = routes[`${method} ${path}`];
    const reply: MockReply = h
      ? typeof h === "function"
        ? h(call)
        : h
      : {
          status: 501,
          body: { error: { code: "NOT_IMPLEMENTED", message: `no mock for ${method} ${path}` } },
        };
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "Content-Type": "application/json", ...reply.headers },
    });
  };
  return { impl, calls };
}
