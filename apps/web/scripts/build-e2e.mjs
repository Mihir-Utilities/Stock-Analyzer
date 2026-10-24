// `next build` for the Playwright run: the /api rewrite is baked in at build time, so point it at a
// closed port. Otherwise whatever listens on localhost:8080 (a local Go API) answers e2e requests.
import { spawnSync } from "node:child_process";

const r = spawnSync("npx", ["next", "build"], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, API_BASE_URL: "http://127.0.0.1:9" },
});
process.exit(r.status ?? 1);
