import { useRegisterSW } from 'virtual:pwa-register/react';

/**
 * Registers the service worker and asks before switching to a new version, so the app never
 * swaps its code mid-use. Also confirms once that the app is ready to work offline.
 */
export function UpdatePrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    offlineReady: [offlineReady, setOfflineReady],
    updateServiceWorker,
  } = useRegisterSW({
    // Register now: by the time this mounts, the window load event has usually fired already.
    immediate: true,
    onRegisterError(error) {
      // Without this a broken service worker fails silently and the app just isn't offline-capable.
      console.error('Service worker registration failed', error);
    },
    onRegisteredSW(_url, registration) {
      // Check for a new version hourly while the app stays open.
      if (registration) setInterval(() => void registration.update(), 60 * 60_000);
    },
  });

  if (!needRefresh && !offlineReady) return null;
  return (
    <div className="toast" role="status">
      {needRefresh ? (
        <>
          <span>A new version of the app is ready.</span>
          <button className="button button-primary" onClick={() => void updateServiceWorker(true)}>
            Reload
          </button>
          <button className="link-button" onClick={() => setNeedRefresh(false)}>
            Later
          </button>
        </>
      ) : (
        <>
          <span>Saved to this device. The schedule now works offline.</span>
          <button className="link-button" onClick={() => setOfflineReady(false)}>
            OK
          </button>
        </>
      )}
    </div>
  );
}
