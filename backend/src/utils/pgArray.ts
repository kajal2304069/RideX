/**
 * node-pg auto-parses arrays of BUILT-IN types (text[], int4[], etc.)
 * into real JS arrays, but returns arrays of CUSTOM types (like our
 * `user_role[]` enum column) as raw Postgres array literal text, e.g.
 * "{RIDER,DRIVER}". This parses that literal back into a string array.
 *
 * Deliberately simple (no quote/escape handling) because it's only ever
 * used for our fixed, simple enum values (no commas/braces/quotes
 * possible inside a role name) - a general-purpose parser would be
 * overkill here.
 */
export function parsePgEnumArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw; // already parsed (e.g. in tests with mocked data)
  if (typeof raw !== "string") return [];
  const trimmed = raw.trim();
  if (trimmed === "{}" || trimmed.length < 2) return [];
  return trimmed.slice(1, -1).split(",").filter(Boolean);
}
