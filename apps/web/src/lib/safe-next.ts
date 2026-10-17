// Validated post-login redirect target (SEC-06; docs/06-frontend-spec.md section 5 "Unauthorized").
// Only same-origin relative paths survive; everything else becomes "/".

const DEFAULT_NEXT = "/";
const MAX_LENGTH = 2048;

function hasControl(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function safeNext(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return DEFAULT_NEXT;
  if (raw.length === 0 || raw.length > MAX_LENGTH) return DEFAULT_NEXT;

  // Control characters and whitespace anywhere (tabs/newlines are stripped by URL parsers).
  if (hasControl(raw) || /\s/.test(raw)) return DEFAULT_NEXT;
  // Must be a path: one leading slash, not "//host" and not "/\host".
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return DEFAULT_NEXT;

  // Decode once more so "/%2F%2Fevil.com" and "/%5Cevil.com" are rejected too.
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return DEFAULT_NEXT;
  }
  if (decoded.startsWith("//") || decoded.includes("\\") || hasControl(decoded)) {
    return DEFAULT_NEXT;
  }

  // Final check with the URL parser: the origin must not change.
  try {
    const base = "http://app.invalid";
    const url = new URL(raw, base);
    if (url.origin !== base) return DEFAULT_NEXT;
  } catch {
    return DEFAULT_NEXT;
  }

  // Never bounce back into the login page.
  if (raw === "/login" || raw.startsWith("/login?") || raw.startsWith("/login/")) {
    return DEFAULT_NEXT;
  }
  return raw;
}

/** Login URL that remembers where the owner was going (path and query only). */
export function loginUrlFor(pathWithQuery: string): string {
  const next = safeNext(pathWithQuery);
  return next === DEFAULT_NEXT ? "/login" : `/login?next=${encodeURIComponent(next)}`;
}
