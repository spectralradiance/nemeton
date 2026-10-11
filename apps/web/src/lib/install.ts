import { useSyncExternalStore } from 'react';

// beforeinstallprompt fires once, early, and only in Chromium. Capture it at startup so the
// Settings screen can offer an Install button later. iOS has no prompt; we show instructions.

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: BeforeInstallPromptEvent | null = null;
let installed = false;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

export function captureInstallPrompt() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    installed = true;
    notify();
  });
}

export type InstallState = 'installed' | 'promptable' | 'ios' | 'unavailable';

function getState(): InstallState {
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  if (installed || standalone) return 'installed';
  if (deferred) return 'promptable';
  const iOS =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return iOS ? 'ios' : 'unavailable';
}

export function useInstallState(): InstallState {
  return useSyncExternalStore((l) => {
    listeners.add(l);
    return () => listeners.delete(l);
  }, getState);
}

export async function promptInstall(): Promise<boolean> {
  if (!deferred) return false;
  await deferred.prompt();
  const { outcome } = await deferred.userChoice;
  deferred = null;
  notify();
  return outcome === 'accepted';
}
