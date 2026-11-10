import { pool } from "../../../db/pool";
import { ApiError } from "../../../common/ApiError";

/**
 * Keyset pagination shared by every admin list. Rows are ordered by (created_at DESC, id DESC); the cursor is the last
 * row's raw timestamp text + id, base64url-encoded and treated as opaque by clients. OFFSET would slow down and skip or
 * repeat rows as new ones arrive; a keyset seek stays O(log n) however deep the page.
 */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

const encode = (t: string, id: string) => Buffer.from(JSON.stringify({ t, id })).toString("base64url");

export function decodeCursor(c?: string): { t: string; id: string } | undefined {
  if (!c) return undefined;
  try {
    const v = JSON.parse(Buffer.from(c, "base64url").toString("utf8"));
    if (typeof v.t === "string" && typeof v.id === "string" && !Number.isNaN(Date.parse(v.t))) return v;
  } catch { /* fall through */ }
  throw ApiError.badRequest("Invalid cursor");
}

/** Collects WHERE fragments with correctly numbered placeholders. */
export class Where {
  readonly params: unknown[] = [];
  private readonly parts: string[] = [];
  add(sql: (ph: (v: unknown) => string) => string): this {
    this.parts.push(sql((v) => { this.params.push(v); return `$${this.params.length}`; }));
    return this;
  }
  get sql(): string { return this.parts.length ? `WHERE ${this.parts.join(" AND ")}` : ""; }
}

/**
 * `select` must expose columns `created_at` and `id` under the alias `a`, e.g. `FROM rides a`. Runs `limit + 1` rows to
 * learn whether another page exists.
 */
export async function keysetPage<T>(
  select: string, from: string, where: Where, limit: number, cursor?: string, map: (row: any) => T = (r) => r
): Promise<Page<T>> {
  const c = decodeCursor(cursor);
  if (c) where.add((p) => `(a.created_at, a.id) < (${p(c.t)}::timestamptz, ${p(c.id)}::uuid)`);
  const sql = `SELECT ${select}, a.created_at::text AS _cursor_t, a.id AS _cursor_id ${from} ${where.sql}
               ORDER BY a.created_at DESC, a.id DESC LIMIT ${Number(limit) + 1}`;
  const { rows } = await pool.query(sql, where.params);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { items: page.map(map), nextCursor: rows.length > limit && last ? encode(last._cursor_t, last._cursor_id) : null };
}

/** Escapes % and _ so user input is matched literally by ILIKE. */
export const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
