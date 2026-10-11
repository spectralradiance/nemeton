// Shared by the page and the service worker, so both agree on where photos are cached.

export const PHOTO_CACHE = 'photos';
export const PHOTO_HOSTS = ['static.wixstatic.com'];
/** Photo responses vary by Accept (AVIF/WebP/JPEG); any stored variant is fine to show. */
export const PHOTO_MATCH: CacheQueryOptions = { ignoreVary: true };

export function isPhotoUrl(url: URL): boolean {
  return PHOTO_HOSTS.includes(url.hostname);
}

export interface PhotoProgress {
  saved: number;
  total: number;
}

/** How many of `urls` are already in the photo cache. */
export async function countCachedPhotos(urls: readonly string[]): Promise<number> {
  if (!('caches' in globalThis)) return 0;
  const cache = await caches.open(PHOTO_CACHE);
  const hits = await Promise.all(urls.map((u) => cache.match(u, PHOTO_MATCH)));
  return hits.filter(Boolean).length;
}

/**
 * Downloads every photo not yet cached, a few at a time. Uses CORS so responses are readable and
 * don't count against storage quota as padded opaque responses.
 */
export async function saveAllPhotos(
  urls: readonly string[],
  onProgress: (p: PhotoProgress) => void,
  signal?: AbortSignal,
): Promise<PhotoProgress> {
  const cache = await caches.open(PHOTO_CACHE);
  const queue = [...new Set(urls)];
  let saved = 0;
  const total = queue.length;

  async function worker() {
    for (let url = queue.shift(); url; url = queue.shift()) {
      signal?.throwIfAborted();
      if (!(await cache.match(url, PHOTO_MATCH))) {
        try {
          const res = await fetch(url, {
            mode: 'cors',
            credentials: 'omit',
            headers: { Accept: 'image/avif,image/webp,image/*;q=0.8' },
            signal,
          });
          if (res.ok) await cache.put(url, res);
        } catch (err) {
          if (signal?.aborted) throw err;
          continue; // one bad photo shouldn't stop the rest
        }
      }
      saved += 1;
      onProgress({ saved, total });
    }
  }

  await Promise.all(Array.from({ length: 4 }, worker));
  return { saved, total };
}
