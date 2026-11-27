// B95.5: applying the analytical schema to a live ClickHouse. `arcod build`
// already writes the DDL next to the service; this module sends the same text
// over the HTTP interface, which is the one channel the generated adapter
// uses. Nothing here reads the model — the caller hands the tables from
// olapTablesFromTypes, so the server and the runtime keep one table shape.
//
// One request per CREATE TABLE: the HTTP interface executes a single statement
// per call, so a joined script would apply its first table only. Per table
// also names the one that failed instead of "the schema".
import { createTableSql, type OlapTable } from './emit/olap.ts';

export interface OlapTarget {
  url: string;
  user?: string;
  password?: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15000;

// The target is explicit (--olap-url) or the environment the generated service
// reads anyway (CLICKHOUSE_URL, then OLAP_URL). Credentials travel as headers,
// never in the URL, so a --json error cannot echo them.
export function olapTarget(
  env: Record<string, string | undefined> = process.env,
  explicitUrl?: string,
): OlapTarget | null {
  const url = String(explicitUrl || env.CLICKHOUSE_URL || env.OLAP_URL || '').replace(/\/+$/, '');
  if (url.length === 0) return null;
  return { url, user: env.CLICKHOUSE_USER || undefined, password: env.CLICKHOUSE_PASSWORD || undefined };
}

// CREATE TABLE IF NOT EXISTS is idempotent, so a re-run is the normal case: a
// fresh container and a schema that already exists both answer 200.
export async function applyClickhouseSchema(tables: OlapTable[], target: OlapTarget): Promise<string[]> {
  const applied: string[] = [];
  for (const table of tables) {
    await createTable(target, table);
    applied.push(table.name);
  }
  return applied;
}

async function createTable(target: OlapTarget, table: OlapTable): Promise<void> {
  const sql = createTableSql(table);
  const query = new URLSearchParams({ query: sql });
  const url = target.url + '/?' + query.toString();
  const headers: Record<string, string> = {};
  if (target.user) headers['x-clickhouse-user'] = target.user;
  if (target.password) headers['x-clickhouse-key'] = target.password;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), target.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(url, { method: 'POST', headers, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) {
      throw new Error('ClickHouse refused ' + table.name + ' (' + response.status + '): ' + text.trim().slice(0, 300));
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('ClickHouse did not answer within ' + (target.timeoutMs ?? DEFAULT_TIMEOUT_MS) + 'ms at ' + target.url);
    }
    if (error instanceof Error && error.message.startsWith('ClickHouse ')) throw error;
    throw new Error('cannot reach ClickHouse at ' + target.url + ': ' + (error instanceof Error ? error.message : String(error)));
  } finally {
    clearTimeout(timer);
  }
}
