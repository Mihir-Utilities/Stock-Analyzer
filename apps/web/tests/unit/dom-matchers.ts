import { expect } from "vitest";

// The repo has no jest-dom; these four matchers are all the stock page tests need.
interface DomMatchers<R = unknown> {
  toHaveTextContent(expected: string | RegExp): R;
  toHaveAttribute(name: string, expected?: string | ReturnType<typeof expect.stringContaining>): R;
  toBeDisabled(): R;
  toBeInTheDocument(): R;
}
declare module "vitest" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-empty-object-type
  interface Assertion<T = any> extends DomMatchers<T> {}
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface AsymmetricMatchersContaining extends DomMatchers {}
}

expect.extend({
  toHaveTextContent(received: Element, expected: string | RegExp) {
    const text = (received.textContent ?? "").replace(/\s+/g, " ").trim();
    const pass = typeof expected === "string" ? text.includes(expected) : expected.test(text);
    return {
      pass,
      message: () => `expected text ${JSON.stringify(text)} to match ${String(expected)}`,
    };
  },
  toHaveAttribute(received: Element, name: string, expected?: unknown) {
    const v = received.getAttribute(name);
    const pass =
      expected === undefined
        ? v !== null
        : typeof expected === "string"
          ? v === expected
          : (expected as { asymmetricMatch: (x: unknown) => boolean }).asymmetricMatch(v);
    return { pass, message: () => `attribute ${name} was ${String(v)}` };
  },
  toBeDisabled(received: HTMLButtonElement) {
    return { pass: received.disabled === true, message: () => "expected element to be disabled" };
  },
  toBeInTheDocument(received: Element | null) {
    return {
      pass: !!received && received.ownerDocument.contains(received),
      message: () => "not in document",
    };
  },
});
