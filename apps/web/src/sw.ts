/// <reference lib="webworker" />
import { clientsClaim } from 'workbox-core';
import { CacheableResponsePlugin } from 'workbox-cacheable-response';
import { ExpirationPlugin } from 'workbox-expiration';
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { CacheFirst } from 'workbox-strategies';
import { PHOTO_CACHE, PHOTO_MATCH, isPhotoUrl } from './lib/photos';
import { db } from './data/db';
import { flushOutbox } from './data/itinerary';

declare let self: ServiceWorkerGlobalScope;

// App shell: everything Vite built is precached at install and served cache-first.
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// Every in-app navigation gets the cached index.html, so deep links like /session/x work offline.
// /api is left to the network: schedule data lives in IndexedDB, refreshed by the page.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('index.html'), { denylist: [/^\/api\//] }),
);

// Photos: cache-first once seen (or saved from Settings). CORS responses only, so no opaque
// responses inflating storage quota.
registerRoute(
  ({ request, url }) => request.destination === 'image' && isPhotoUrl(url),
  new CacheFirst({
    cacheName: PHOTO_CACHE,
    matchOptions: PHOTO_MATCH,
    plugins: [
      new CacheableResponsePlugin({ statuses: [200] }),
      new ExpirationPlugin({
        maxEntries: 300,
        maxAgeSeconds: 120 * 24 * 60 * 60,
        purgeOnQuotaError: true,
      }),
    ],
  }),
);

// Take control of the page on first install, so photos viewed in the first visit get cached.
// Updates still wait for the user to accept them (see UpdatePrompt), via SKIP_WAITING below.
clientsClaim();

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') void self.skipWaiting();
});

// Background Sync (Chromium): send queued itinerary edits once the OS sees a connection, even if
// the app was closed. A rejected promise tells the browser to retry later. Other browsers flush
// from the page instead (on open, reconnect and return to the app).
interface SyncEvent extends ExtendableEvent {
  readonly tag: string;
}

self.addEventListener('sync' as keyof ServiceWorkerGlobalScopeEventMap, (event) => {
  const e = event as SyncEvent;
  if (e.tag === 'outbox') e.waitUntil(flushOutbox(db).then(() => undefined));
});
