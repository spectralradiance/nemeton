import { useSchedule } from '../data/schedule';
import { linkLabel } from '../lib/format';

export function Vendors() {
  const { vendors } = useSchedule().snapshot;
  const sorted = [...vendors].sort((a, b) =>
    a.name.replace(/^the\s+/i, '').localeCompare(b.name.replace(/^the\s+/i, '')),
  );
  return (
    <div className="vendors">
      <h1 className="page-title">Vendors</h1>
      <p className="muted">{vendors.length} vendors at the market.</p>
      <ul className="vendor-list">
        {sorted.map((v) => (
          <li key={v.id} className="vendor">
            <span>{v.name}</span>
            {v.links.map((l) => (
              <a
                key={l.url}
                href={l.url}
                target="_blank"
                rel="noopener noreferrer"
                className="link-pill"
              >
                {linkLabel(l)}
              </a>
            ))}
          </li>
        ))}
      </ul>
    </div>
  );
}
