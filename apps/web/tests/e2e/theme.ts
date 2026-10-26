import type { Page } from "@playwright/test";

// Switch theme like the toggle does, then wait until every colour transition has finished.
// axe samples computed colours: a transition that has not yet advanced (even a 0.01 ms one under
// reduced motion needs a frame) reports the old theme's colour on a new-theme background, which
// showed up as a flaky "serious color-contrast" on the active nav item.
export async function setTheme(page: Page, theme: "dark" | "light"): Promise<void> {
  await page.evaluate(async (t) => {
    localStorage.setItem("analyzer-theme", t);
    document.documentElement.setAttribute("data-theme", t);
    const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
    await frame();
    await frame();
    await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)));
    await frame();
  }, theme);
}
