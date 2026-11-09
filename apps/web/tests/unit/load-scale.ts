// Scales a wall-clock budget by how slow the machine currently is, so a timing test asserts the
// property (the work fits a frame on this machine) and not the speed of a loaded CI runner. The
// calibration is a fixed CPU workload that is independent of the code under test.

/** Duration in ms of the calibration workload on an idle development machine (rounded up; about 4 ms here). */
const REFERENCE_MS = 6;

function calibrationRun(): number {
  const t0 = performance.now();
  const words: string[] = [];
  let h = 7;
  for (let i = 0; i < 5000; i++) {
    h = (Math.imul(h, 31) + i) | 0;
    words.push(`w${(h >>> 0).toString(36)}`);
  }
  words.sort();
  let n = 0;
  for (const w of words) if (w.includes("a")) n++;
  if (n < 0) throw new Error("unreachable");
  return performance.now() - t0;
}

/** >= 1; 1 on an idle machine, larger while the machine is busy (best of five runs). */
export function loadScale(): number {
  let best = Infinity;
  for (let i = 0; i < 5; i++) best = Math.min(best, calibrationRun());
  return Math.min(50, Math.max(1, best / REFERENCE_MS));
}
