import type { ChangeInput, Festival, Session, Snapshot, Stage } from '@nemeton/shared';

// Turns changes into lines an organizer can check before publishing:
//   ~ session hail-fri "Hail": start Fri 8:30 PM → Fri 8:50 PM, status scheduled → delayed

export function formatWhen(festival: Festival, instant: string | null | undefined): string {
  if (!instant) return 'all day';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: festival.timezone,
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(instant));
}

const clip = (v: unknown, max = 40) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  const flat = (s ?? '—').replace(/\s+/g, ' ');
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

function label(entity: ChangeInput['entity'], data: unknown): string {
  const d = data as { title?: string; name?: string } | undefined;
  return d?.title ?? d?.name ?? '';
}

/** Field-by-field differences, with times and stages shown the way people read them. */
function fieldChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  ctx: Ctx,
): string[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  return keys
    .filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
    .map((k) => {
      const show = (v: unknown) => {
        if (k === 'startsAt' || k === 'endsAt') return formatWhen(ctx.festival, v as string | null);
        if (k === 'stageId') return ctx.stageName(v as string);
        if (k === 'description' || k === 'bio') return v ? `${String(v).length} chars` : '—';
        return clip(v);
      };
      const name = { startsAt: 'start', endsAt: 'end', stageId: 'stage' }[k] ?? k;
      return `${name} ${show(before[k])} → ${show(after[k])}`;
    });
}

interface Ctx {
  festival: Festival;
  stageName: (id: string) => string;
}

/** One line per change, comparing against `before` (the schedule as it is now). */
export function describeChanges(before: Snapshot, changes: readonly ChangeInput[]): string[] {
  const stages = new Map<string, Stage>(before.stages.map((s) => [s.id, s]));
  for (const c of changes) {
    if (c.entity === 'stage' && c.op === 'upsert') stages.set(c.id, c.data as Stage);
  }
  const ctx: Ctx = {
    festival: before.festival,
    stageName: (id) => stages.get(id)?.name ?? id,
  };
  const existing = (c: ChangeInput): Record<string, unknown> | undefined => {
    if (c.entity === 'festival') return before.festival as unknown as Record<string, unknown>;
    const list = { stage: before.stages, session: before.sessions, vendor: before.vendors }[
      c.entity
    ];
    return list.find((x) => x.id === c.id) as Record<string, unknown> | undefined;
  };

  return changes.map((c) => {
    const old = existing(c);
    const name = label(c.entity, c.op === 'upsert' ? c.data : old);
    const head = `${c.entity} ${c.id}${name ? ` "${name}"` : ''}`;
    if (c.op === 'delete') return `- ${head}`;
    if (!old) {
      const s = c.data as Partial<Session>;
      const where =
        c.entity === 'session'
          ? ` (${formatWhen(ctx.festival, s.startsAt)}, ${ctx.stageName(s.stageId!)})`
          : '';
      return `+ ${head}${where}`;
    }
    return `~ ${head}: ${fieldChanges(old, c.data as Record<string, unknown>, ctx).join(', ')}`;
  });
}
