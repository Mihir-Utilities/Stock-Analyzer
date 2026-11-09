import { ApiError, apiRequest } from "@/lib/api/client";
import { z } from "zod";

// Logout and logout-all (docs/03 section 2, B02-7: both answer {ok:true} and clear the cookie).
// A 401 means the session is already gone, which is the state the owner asked for. Any other
// failure is reported, because pretending to be signed out would be wrong.

const okSchema = z.object({ ok: z.boolean() });

export interface SignOutDeps {
  request?: typeof apiRequest;
  clear: () => void;
  go: (url: string) => void;
}

export async function signOut(all: boolean, deps: SignOutDeps): Promise<void> {
  const request = deps.request ?? apiRequest;
  try {
    await request(all ? "/auth/logout-all" : "/auth/logout", {
      schema: okSchema,
      method: "POST",
      skipUnauthorizedHandler: true,
    });
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 401)) throw e;
  }
  deps.clear();
  deps.go("/login");
}

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 200;

/** Same rules as the API (docs/03 section 2): new 12..200 characters and different from current. */
export function validatePasswordChange(
  current: string,
  next: string,
  confirm: string,
): Record<"current" | "new" | "confirm", string | null> {
  return {
    current:
      current.length === 0
        ? "Enter your current password."
        : current.length > PASSWORD_MAX
          ? `At most ${PASSWORD_MAX} characters.`
          : null,
    new:
      next.length < PASSWORD_MIN
        ? `The new password needs at least ${PASSWORD_MIN} characters.`
        : next.length > PASSWORD_MAX
          ? `At most ${PASSWORD_MAX} characters.`
          : next === current
            ? "The new password must differ from the current one."
            : null,
    confirm: confirm !== next ? "The two new passwords do not match." : null,
  };
}
