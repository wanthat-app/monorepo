import { UsersStats } from "@wanthat/contracts";
import type { Database } from "@wanthat/db";
import { type Kysely, sql } from "kysely";

const TZ = "Asia/Jerusalem"; // the operating market — day boundaries are local, not UTC (ADR-0017 spirit)

/** The last 30 calendar dates (oldest → today) as YYYY-MM-DD in the given IANA timezone. */
export function last30Dates(nowMs: number, timeZone = TZ): string[] {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone }); // en-CA → YYYY-MM-DD
  const dates: string[] = [];
  for (let i = 29; i >= 0; i--) dates.push(fmt.format(new Date(nowMs - i * 86_400_000)));
  return dates;
}

/** Raw shapes from the two SQL queries (Postgres returns bigints as strings). */
interface OverviewRow {
  total: string;
  active: string;
  suspended: string;
  new_today: string;
  new_7d: string;
  new_30d: string;
}

/**
 * PURE: assemble validated {@link UsersStats} from raw query results. Zero-fills the daily-signup
 * series onto a fixed 30-day axis so the chart always has the same shape, and coerces Postgres's
 * string counts to numbers. Kept separate from the SQL so it is unit-testable without a database.
 */
export function buildUsersStats(
  overview: OverviewRow | undefined,
  dailyRows: { date: string; count: string }[],
  axisDates: string[],
): UsersStats {
  const byDate = new Map(dailyRows.map((r) => [r.date, Number(r.count)]));
  const n = (v: string | undefined) => Number(v ?? 0);
  return UsersStats.parse({
    total: n(overview?.total),
    active: n(overview?.active),
    suspended: n(overview?.suspended),
    newToday: n(overview?.new_today),
    new7d: n(overview?.new_7d),
    new30d: n(overview?.new_30d),
    dailySignups: axisDates.map((date) => ({ date, count: byDate.get(date) ?? 0 })),
  });
}

/**
 * Compute the admin users stats from Aurora (read-only). One aggregate query for the totals/windows
 * (calendar day = Asia/Jerusalem; 7d/30d are rolling), one grouped query for the daily trend.
 */
export async function loadUsersStats(db: Kysely<Database>, nowMs: number): Promise<UsersStats> {
  const overview = await sql<OverviewRow>`
    SELECT
      count(*)                                                          AS total,
      count(*) FILTER (WHERE status = 'active')                         AS active,
      count(*) FILTER (WHERE status = 'suspended')                      AS suspended,
      count(*) FILTER (
        WHERE (created_at AT TIME ZONE ${TZ})::date = (now() AT TIME ZONE ${TZ})::date
      )                                                                 AS new_today,
      count(*) FILTER (WHERE created_at >= now() - interval '7 days')   AS new_7d,
      count(*) FILTER (WHERE created_at >= now() - interval '30 days')  AS new_30d
    FROM customer
  `.execute(db);

  const daily = await sql<{ date: string; count: string }>`
    SELECT to_char((created_at AT TIME ZONE ${TZ})::date, 'YYYY-MM-DD') AS date, count(*) AS count
    FROM customer
    WHERE created_at >= now() - interval '30 days'
    GROUP BY 1
    ORDER BY 1
  `.execute(db);

  return buildUsersStats(overview.rows[0], daily.rows, last30Dates(nowMs));
}
