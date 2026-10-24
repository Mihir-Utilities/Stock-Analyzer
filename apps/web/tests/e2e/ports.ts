// Fixed local ports for the Playwright web servers; override with PW_PORT / PW_STORY_PORT when
// another process already uses them (docs/RUNBOOK.md section 40).
export const WEB_PORT = Number(process.env.PW_PORT ?? 3100);
export const STORY_PORT = Number(process.env.PW_STORY_PORT ?? 6100);
export const WEB_ORIGIN = `http://127.0.0.1:${WEB_PORT}`;
export const STORY_ORIGIN = `http://127.0.0.1:${STORY_PORT}`;
