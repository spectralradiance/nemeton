import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Absolute (npm runs the server from apps/server) and outside test-results (Playwright empties it).
// One database per run: the runner sets the id, and test workers inherit it through the env.
process.env.NEMETON_E2E_RUN ??= String(Date.now());

export const E2E_DIR = join(tmpdir(), 'nemeton-e2e');
export const E2E_DB = join(E2E_DIR, `run-${process.env.NEMETON_E2E_RUN}.db`);
