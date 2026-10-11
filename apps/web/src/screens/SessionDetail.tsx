import { useState } from 'react';
import { Link, useParams } from 'wouter';
import type { Session } from '@nemeton/shared';
import { useSchedule } from '../data/schedule';
import { KIND_LABEL, formatDay, formatTimeRange, linkLabel, paragraphs } from '../lib/format';
import { SessionRow } from '../components/SessionRow';
import { StageName } from '../components/StageName';
import { StatusBadge } from '../components/StatusBadge';
import { NotFound } from './NotFound';

const ABOUT_HEADING: Record<Session['kind'], (s: Session) => string> = {
  music: () => 'About the artist',
  ritual: () => 'About',
  workshop: (s) => (s.people.length > 1 ? 'About the facilitators' : 'About the facilitator'),
};

export function SessionDetail() {
  const { id } = useParams<{ id: string }>();
  const { snapshot, sessionById, ends, lineup } = useSchedule();
  const { festival } = snapshot;
  const s = sessionById.get(id);
  if (!s) return <NotFound what="That session" />;

  const end = ends.get(s.id);
  const others =
    lineup
      .find((e) => e.sessions.some((x) => x.id === s.id))
      ?.sessions.filter((x) => x.id !== s.id) ?? [];

  return (
    <article className="detail" data-status={s.status}>
      <Link href={`/schedule/${s.day}`} className="back-link">
        ← {festival.days.find((d) => d.date === s.day)?.label ?? 'Schedule'}
      </Link>

      <div className="detail-layout">
        {s.photo && <Photo src={s.photo} alt={s.title} />}

        <div className="detail-body">
          <p className="eyebrow">
            {KIND_LABEL[s.kind]}
            {s.tags.map((t) => (
              <span key={t} className="tag">
                {t}
              </span>
            ))}
          </p>
          <h1 className="detail-title">{s.title}</h1>
          {s.subtitle && <p className="detail-subtitle">{s.subtitle}</p>}

          {s.status !== 'scheduled' && (
            <p className="status-banner">
              <StatusBadge session={s} /> {s.note}
            </p>
          )}

          <dl className="facts">
            <div>
              <dt>When</dt>
              <dd>
                {formatDay(s.day, 'long')}
                {s.startsAt && end
                  ? `, ${formatTimeRange(festival, s.startsAt, end.endsAt, end.estimated)}`
                  : ', all day'}
                {end?.estimated && <span className="muted"> (end time estimated)</span>}
              </dd>
            </div>
            <div>
              <dt>Where</dt>
              <dd>
                <StageName stageId={s.stageId} />
              </dd>
            </div>
            {s.people.length > 0 && (
              <div>
                <dt>With</dt>
                <dd>{s.people.join(' & ')}</dd>
              </div>
            )}
            {s.origin && (
              <div>
                <dt>From</dt>
                <dd>{s.origin}</dd>
              </div>
            )}
          </dl>

          {paragraphs(s.description).map((p, i) => (
            <p key={i} className="prose">
              {p}
            </p>
          ))}

          {s.bio && (
            <section className="detail-section">
              <h2>{ABOUT_HEADING[s.kind](s)}</h2>
              {paragraphs(s.bio).map((p, i) => (
                <p key={i} className="prose">
                  {p}
                </p>
              ))}
            </section>
          )}

          {s.links.length > 0 && (
            <ul className="links" aria-label="Links">
              {s.links.map((l) => (
                <li key={l.url}>
                  <a href={l.url} target="_blank" rel="noopener noreferrer" className="link-pill">
                    {linkLabel(l)}
                  </a>
                </li>
              ))}
            </ul>
          )}

          {others.length > 0 && (
            <section className="detail-section">
              <h2>Also on</h2>
              <div className="session-list">
                {others.map((o) => (
                  <SessionRow key={o.id} session={o} showDay />
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </article>
  );
}

/** Hides itself if the image can't load, e.g. offline before it was ever cached. */
function Photo({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <img
      className="detail-photo"
      src={src}
      alt={alt}
      decoding="async"
      crossOrigin="anonymous"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}
