import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../data/db';
import { useSchedule } from '../data/schedule';
import { requestSync, useSyncStatus } from '../data/sync';
import { useNow } from '../lib/clock';
import { promptInstall, useInstallState } from '../lib/install';
import { PHOTO_CACHE, countCachedPhotos, saveAllPhotos, type PhotoProgress } from '../lib/photos';

export function Settings() {
  return (
    <div className="settings">
      <h1 className="page-title">Settings</h1>
      <ScheduleData />
      <OfflinePhotos />
      <Install />
      <Storage />
      <Reset />
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="card">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
function ago(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return relative.format(-m, 'minute');
  const h = Math.round(m / 60);
  if (h < 24) return relative.format(-h, 'hour');
  return relative.format(-Math.round(h / 24), 'day');
}

function ScheduleData() {
  const meta = useLiveQuery(() => db.meta.get('sync'));
  const sync = useSyncStatus();
  // Real time on purpose: "last updated" is about this device, not the pretend festival clock.
  useNow(15_000);
  const now = Date.now();
  return (
    <Card title="Schedule">
      <p>
        {meta ? <>Last checked {ago(now - meta.syncedAt)}.</> : 'Not downloaded yet.'}{' '}
        {sync.syncing
          ? 'Checking for changes…'
          : !sync.online
            ? 'You are offline; showing the saved copy.'
            : sync.error
              ? `Couldn't check for changes (${sync.error}).`
              : 'Changes from the organizers download automatically.'}
      </p>
      <button
        className="button"
        disabled={sync.syncing || !sync.online}
        onClick={() => void requestSync(db).catch(() => {})}
      >
        Check now
      </button>
    </Card>
  );
}

function OfflinePhotos() {
  const { sessions } = useSchedule().snapshot;
  const urls = useMemo(
    () => [...new Set(sessions.flatMap((s) => (s.photo ? [s.photo] : [])))],
    [sessions],
  );
  const [cached, setCached] = useState<number | null>(null);
  const [progress, setProgress] = useState<PhotoProgress | null>(null);
  const abort = useRef<AbortController | null>(null);
  const sync = useSyncStatus();

  useEffect(() => {
    void countCachedPhotos(urls).then(setCached);
    return () => abort.current?.abort();
  }, [urls]);

  async function save() {
    abort.current = new AbortController();
    try {
      await saveAllPhotos(urls, setProgress, abort.current.signal);
    } finally {
      setProgress(null);
      setCached(await countCachedPhotos(urls));
    }
  }

  const all = cached !== null && cached >= urls.length;
  return (
    <Card title="Photos offline">
      <p>
        Photos are saved as you view them.{' '}
        {cached !== null && (
          <>
            {cached} of {urls.length} are on this device.
          </>
        )}
      </p>
      {progress ? (
        <div className="progress-row">
          <progress value={progress.saved} max={progress.total} />
          <span>
            {progress.saved} / {progress.total}
          </span>
          <button className="link-button" onClick={() => abort.current?.abort()}>
            Stop
          </button>
        </div>
      ) : (
        <button className="button" disabled={all || !sync.online} onClick={() => void save()}>
          {all ? 'All photos saved' : 'Save all photos now'}
        </button>
      )}
      {!all && !progress && <p className="hint">About 5 MB. Best done on Wi-Fi.</p>}
    </Card>
  );
}

function Install() {
  const state = useInstallState();
  return (
    <Card title="Install">
      {state === 'installed' && <p>Installed. Open Nemeton from your home screen or app list.</p>}
      {state === 'promptable' && (
        <>
          <p>Add Nemeton to your home screen for full-screen use and quicker access.</p>
          <button className="button button-primary" onClick={() => void promptInstall()}>
            Install app
          </button>
        </>
      )}
      {state === 'ios' && (
        <p>
          In Safari, tap <strong>Share</strong>, then <strong>Add to Home Screen</strong>. Installed
          apps keep their saved data; Safari may clear it from websites you haven't opened for a
          week.
        </p>
      )}
      {state === 'unavailable' && (
        <p>
          Use your browser's menu to install this site as an app (in Chrome or Edge: “Install
          Nemeton”). It works offline either way once loaded.
        </p>
      )}
    </Card>
  );
}

function Storage() {
  const [estimate, setEstimate] = useState<StorageEstimate | null>(null);
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const supported = typeof navigator !== 'undefined' && 'storage' in navigator;

  useEffect(() => {
    if (!supported) return;
    void navigator.storage.estimate().then(setEstimate);
    void navigator.storage.persisted().then(setPersisted);
  }, [supported]);

  if (!supported) return null;
  const mb = (bytes = 0) => `${(bytes / 1_048_576).toFixed(1)} MB`;
  return (
    <Card title="Storage">
      {estimate && <p>Using {mb(estimate.usage)} on this device.</p>}
      {persisted ? (
        <p>Protected: the browser won't clear this app's data to free up space.</p>
      ) : (
        <>
          <p>
            The browser may clear saved data when the device is low on space. You can ask it to keep
            Nemeton's data.
          </p>
          <button
            className="button"
            onClick={() => void navigator.storage.persist().then(setPersisted)}
          >
            Keep data on this device
          </button>
          {persisted === false && estimate && (
            <p className="hint">
              Some browsers only agree once the app is installed or used regularly.
            </p>
          )}
        </>
      )}
    </Card>
  );
}

function Reset() {
  async function reset() {
    if (!window.confirm('Delete the saved schedule and photos from this device?')) return;
    db.close();
    await db.delete();
    if ('caches' in window) await caches.delete(PHOTO_CACHE);
    window.location.assign('/');
  }
  return (
    <Card title="Reset">
      <p>
        Removes the downloaded schedule and photos. They download again next time you're online.
      </p>
      <button className="button button-danger" onClick={() => void reset()}>
        Clear saved data
      </button>
    </Card>
  );
}
