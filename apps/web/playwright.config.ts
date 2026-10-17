import { defineConfig } from "@playwright/test";

// Browser tests run against a production build (`npm run build` first) served by `next start`.
// They use a system-installed Chrome (CI: google-chrome on ubuntu-latest) or Edge locally, so no
// browser download is needed. Override with PW_CHANNEL=msedge|chrome.
const channel = process.env.PW_CHANNEL ?? (process.env.CI ? "chrome" : "msedge");
const port = 3100;

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  fullyParallel: true,
  workers: process.env.CI ? 2 : 3,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    channel,
  },
  webServer: {
    command: `npx next start -p ${port} -H 127.0.0.1`,
    url: `http://127.0.0.1:${port}/login`,
    reuseExistingServer: false,
    timeout: 60_000,
    // The API is not needed for the shell; point the rewrite at a closed port.
    env: { API_BASE_URL: "http://127.0.0.1:9" },
  },
});
