/** SQLite understands relative words such as 'now'; those are not stored event
 * timestamps. Guard the date shape before conversion so malformed legacy rows
 * sort at zero and cannot make an expression index nondeterministic.
 */
export function feedTimeSql(column: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(column)) throw new Error('Unsafe timestamp column.');
  return `(CASE WHEN ${column} GLOB '????-??-??[ T]??:??:??*' THEN COALESCE(julianday(${column}), 0) ELSE 0 END)`;
}
