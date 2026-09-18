/** SQLite understands relative words such as 'now'; those are not stored event
 * timestamps. Guard the date shape before conversion so malformed legacy rows
 * sort at zero and cannot make an expression index nondeterministic.
 */
import type Database from 'better-sqlite3';

function feedTimeExpression(column: string): string {
  return `(CASE WHEN ${column} GLOB '????-??-??[ T]??:??:??*' THEN COALESCE(julianday(${column}), 0) ELSE 0 END)`;
}

export function feedTimeSql(column: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(column)) throw new Error('Unsafe timestamp column.');
  return feedTimeExpression(column);
}

/** Produces the exact numeric key used by feedTimeSql without interpolating input. */
export function normalizedFeedTime(db: Database.Database, value: unknown): number {
  const row = db.prepare(`SELECT ${feedTimeExpression('?')} AS value`).get(value, value) as { value: number };
  return Number(row.value);
}
