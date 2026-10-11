import { Change, SnapshotResponse, type ChangeInput, type Snapshot } from '@nemeton/shared';

// Thin client for the organizer API. Configure with NEMETON_API and NEMETON_TOKEN.

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface ApiConfig {
  base: string;
  token?: string;
}

export function apiConfig(token?: string): ApiConfig {
  return {
    base: (process.env.NEMETON_API ?? 'http://localhost:8787').replace(/\/$/, ''),
    token: token ?? process.env.NEMETON_TOKEN,
  };
}

async function request(config: ApiConfig, path: string, init: RequestInit = {}): Promise<unknown> {
  const headers = new Headers(init.headers);
  if (config.token) headers.set('Authorization', `Bearer ${config.token}`);
  if (init.body) headers.set('Content-Type', 'application/json');
  let res: Response;
  try {
    res = await fetch(`${config.base}/api${path}`, { ...init, headers });
  } catch {
    throw new ApiError(`Can't reach the server at ${config.base}. Is it running?`, 0);
  }
  const body = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) {
    const message = (body as { error?: string } | null)?.error ?? `HTTP ${res.status}`;
    if (res.status === 401) {
      throw new ApiError(`${message}. Set NEMETON_TOKEN (see \`admin organizer add\`).`, 401);
    }
    throw new ApiError(message, res.status);
  }
  return body;
}

export async function fetchSnapshot(config: ApiConfig): Promise<Snapshot> {
  const { epoch: _epoch, ...snapshot } = SnapshotResponse.parse(
    await request(config, '/schedule/snapshot'),
  );
  return snapshot;
}

export async function whoami(config: ApiConfig): Promise<{ id: string; name: string }> {
  return (await request(config, '/admin/whoami')) as { id: string; name: string };
}

export async function publish(
  config: ApiConfig,
  changes: ChangeInput[],
  baseSeq: number,
): Promise<{ from: number; to: number; count: number }> {
  return (await request(config, '/admin/changes', {
    method: 'POST',
    body: JSON.stringify({ changes, baseSeq }),
  })) as { from: number; to: number; count: number };
}

export async function fetchLog(config: ApiConfig, limit: number): Promise<Change[]> {
  const body = (await request(config, `/admin/log?limit=${limit}`)) as { changes: unknown };
  return Change.array().parse(body.changes);
}
