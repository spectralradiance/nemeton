// Sends crashes to the server so organizers learn about them (`npm run admin -- errors`).
// No personal data: the message, stack, path (never the query string) and app version.
// Best effort only: reports made offline are dropped rather than queued.

declare const __APP_VERSION__: string;

const MAX_PER_PAGE = 10;
const sent = new Set<string>();

export function reportError(error: unknown, context?: string) {
  const err = error instanceof Error ? error : new Error(String(error));
  const message = `${context ? `${context}: ` : ''}${err.name}: ${err.message}`.slice(0, 500);
  if (sent.has(message) || sent.size >= MAX_PER_PAGE) return;
  sent.add(message);
  if (typeof navigator !== 'undefined' && !navigator.onLine) return;
  try {
    void fetch('/api/errors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // keepalive: the report still goes out if the page is closing.
      keepalive: true,
      body: JSON.stringify({
        message,
        stack: err.stack?.slice(0, 4000),
        path: location.pathname,
        version: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev',
      }),
    }).catch(() => {});
  } catch {
    // Never let error reporting cause an error.
  }
}

/** Catches what nothing else does: uncaught exceptions and unhandled promise rejections. */
export function captureGlobalErrors() {
  window.addEventListener('error', (e) => reportError(e.error ?? e.message, 'Uncaught'));
  window.addEventListener('unhandledrejection', (e) =>
    reportError(e.reason, 'Unhandled rejection'),
  );
}
