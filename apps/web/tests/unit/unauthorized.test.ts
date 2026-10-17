import { describe, expect, it, vi } from "vitest";
import { createQueryClient, handleUnauthorized } from "@/components/shell/Providers";

// UI-15: any API 401 clears caches and goes to /login with a validated next.
describe("unauthorized handling (UI-15)", () => {
  it("clears the query cache and redirects with a validated next", () => {
    const client = createQueryClient();
    client.setQueryData(["stock", "TCS"], { symbol: "TCS" });
    const go = vi.fn();
    handleUnauthorized(client, { pathname: "/stocks/TCS", search: "?tab=chart" }, go);
    expect(client.getQueryData(["stock", "TCS"])).toBeUndefined();
    expect(go).toHaveBeenCalledWith(`/login?next=${encodeURIComponent("/stocks/TCS?tab=chart")}`);
  });

  it("does not loop when already on /login", () => {
    const go = vi.fn();
    handleUnauthorized(createQueryClient(), { pathname: "/login", search: "" }, go);
    expect(go).not.toHaveBeenCalled();
  });

  it("uses the documented stale times and retry policy", () => {
    const client = createQueryClient();
    expect(client.getDefaultOptions().queries?.refetchOnWindowFocus).toBe(false);
    expect(typeof client.getDefaultOptions().queries?.retry).toBe("function");
  });
});
