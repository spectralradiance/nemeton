import { Link } from 'wouter';

export function NotFound({ what = 'That page' }: { what?: string }) {
  return (
    <div className="page-message">
      <h1 className="page-title">Not found</h1>
      <p>{what} isn't in the schedule.</p>
      <Link href="/schedule" className="button">
        Back to the schedule
      </Link>
    </div>
  );
}
