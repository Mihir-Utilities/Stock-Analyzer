import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOGIN_ERROR, LoginForm } from "@/components/login/LoginForm";
import { createMockFetch, type Handler } from "../mocks/mock-fetch";

const assign = vi.fn();

function setup(login: Handler, search = "") {
  const mock = createMockFetch({ "POST /auth/login": login });
  vi.stubGlobal("fetch", mock.impl);
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { search, assign },
  });
  render(<LoginForm />);
  return mock;
}

async function submit(password = "secret") {
  fireEvent.change(screen.getByTestId("login-password"), { target: { value: password } });
  fireEvent.click(screen.getByTestId("login-submit"));
}

beforeEach(() => assign.mockReset());
afterEach(() => vi.unstubAllGlobals());

// SEC-01 (UI side): wrong password and lockout are indistinguishable; 429 shows Retry-After.
describe("login form (docs/06 section 6.1, SEC-01)", () => {
  it("has the right input attributes, a show/hide toggle and no recovery or register link", () => {
    setup({ status: 200, body: {} });
    const input = screen.getByTestId("login-password") as HTMLInputElement;
    expect(input.getAttribute("autocomplete")).toBe("current-password");
    expect(input.type).toBe("password");
    fireEvent.click(screen.getByTestId("login-toggle"));
    expect(input.type).toBe("text");
    expect(screen.queryByText(/forgot|register|sign up|reset/i)).toBeNull();
  });

  it("shows the identical generic message for a 401 whether wrong or locked", async () => {
    for (const message of ["bad password", "account locked until 12:00"]) {
      setup({ status: 401, body: { error: { code: "UNAUTHENTICATED", message } } });
      await submit();
      await waitFor(() => expect(screen.getByRole("alert").textContent).toContain(LOGIN_ERROR));
      expect(document.body.textContent).not.toContain(message);
      document.body.innerHTML = "";
    }
    expect(LOGIN_ERROR).toBe("Invalid credentials or temporarily locked.");
  });

  it("clears the field and refocuses it after a failure", async () => {
    setup({ status: 401, body: { error: { code: "UNAUTHENTICATED", message: "x" } } });
    await submit();
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    const input = screen.getByTestId("login-password") as HTMLInputElement;
    expect(input.value).toBe("");
    expect(document.activeElement).toBe(input);
  });

  it("shows the Retry-After wait on a 429", async () => {
    setup({
      status: 429,
      body: { error: { code: "RATE_LIMITED", message: "slow" } },
      headers: { "Retry-After": "42" },
    });
    await submit();
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("Try again in 42 s"),
    );
  });

  it("sends the CSRF header and goes to a safe next path", async () => {
    const mock = setup(
      { status: 200, body: { data: { authenticated: true, expires_at: "2026-11-01T00:00:00Z" } } },
      "?next=%2Fportfolio",
    );
    await submit("pw");
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/portfolio"));
    expect(mock.calls[0]?.headers.get("X-Requested-With")).toBe("fetch");
    expect(mock.calls[0]?.body).toEqual({ password: "pw" });
  });

  it("ignores an open-redirect next and falls back to /", async () => {
    setup(
      { status: 200, body: { data: { authenticated: true } } },
      "?next=https%3A%2F%2Fevil.example",
    );
    await submit();
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/"));
  });

  it("does not call the API for an empty password", async () => {
    const mock = setup({ status: 200, body: {} });
    fireEvent.click(screen.getByTestId("login-submit"));
    expect(screen.getByRole("alert").textContent).toContain("Enter your password");
    expect(mock.calls).toHaveLength(0);
  });
});
