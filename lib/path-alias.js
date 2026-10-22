/**
 * Cwd alias canonicalization — maps a historical working directory onto its
 * current location before the project directory hash is computed.
 *
 * Why: `projectHash()` is `sha1(<literal cwd>)`, so a repository that moved
 * (``~/syncthing/project/x`` → ``~/syncfolder/project/x``) lands in a *second*
 * project directory. 2026-10-22 the memory store carried 7 such dead
 * directories (329,655 chars of MEMORY+KEY, 58 pending todos) that no live
 * session could ever see again. The store merges those into the live
 * directories, and this module prevents them from being re-created: a session
 * whose cwd is the old path (a restored session, a COI dispatch passing an
 * explicit cwd, a stale config) writes into the live directory instead.
 *
 * The alias table is `~/.dsh/storages/path-alias-map.json` (schema v2),
 * produced by `dsfolder/scripts/path-split-report.mjs --write`. Only its
 * `declared[]` entries are consumed: they are the operator's intent, and a
 * declared mapping is usable even when the target has not been verified.
 *
 * Resolution rules (same as `dsh-workspace-board/lib/path-alias.mjs`):
 *   1. exact match first, then the longest declared prefix;
 *   2. a prefix only matches on a `/` boundary (`/a/b` never matches `/a/bc`);
 *   3. at most one hop — an alias whose target is itself an alias key stays put
 *      (chasing chains turns a bad table into silent data movement);
 *   4. self-mappings (`from === to`) are dropped.
 *
 * Failure policy: never guess. A missing or malformed table yields the
 * identity mapping plus a machine-readable reason, so callers can tell
 * "no table" / "table is broken" / "cwd is simply not mapped" apart — the
 * three cases have different remedies and must not collapse into one.
 */
import { readFileSync, statSync } from 'node:fs'

/** mapPath → {mtimeMs, size, value}; the table is re-read when it changes. */
const CACHE = new Map()

/**
 * Trim trailing slashes (keep the root `/`) so `/a/b/` and `/a/b` compare equal.
 * @param {unknown} path
 * @returns {string | null} the normalized path, or null when not a usable path.
 */
function normalizePath(path) {
  if (typeof path !== 'string' || path.length === 0) return null
  if (path === '/') return path
  return path.replace(/\/+$/, '')
}

/**
 * Parse a raw `path-alias-map.json` document into ordered `{from, to}` pairs.
 * Tolerates unknown/missing fields and skips unusable entries instead of
 * failing the whole table (one bad row must not disable canonicalization).
 * @param {unknown} raw - parsed JSON document.
 * @returns {Array<{from: string, to: string}>} longest `from` first.
 */
export function parseAliasMap(raw) {
  if (raw === null || typeof raw !== 'object') return []
  const declared = Array.isArray(raw.declared) ? raw.declared : []
  const entries = []
  for (const item of declared) {
    if (item === null || typeof item !== 'object') continue
    const from = normalizePath(item.from)
    const to = normalizePath(item.to)
    if (from === null || to === null || from === to) continue
    entries.push({ from, to })
  }
  // Longest prefix first: resolution must not depend on file order.
  entries.sort((a, b) => b.from.length - a.from.length)
  return entries
}

/**
 * Load (with mtime/size cache) the alias entries for one table path.
 * @param {string | null | undefined} mapPath
 * @returns {{entries: Array<{from: string, to: string}>, reason: string}}
 */
function loadEntries(mapPath) {
  if (typeof mapPath !== 'string' || mapPath.length === 0) {
    return { entries: [], reason: 'no-map-path' }
  }
  let stat
  try {
    stat = statSync(mapPath)
  } catch {
    CACHE.delete(mapPath)
    return { entries: [], reason: 'no-map' }
  }
  const cached = CACHE.get(mapPath)
  if (cached !== undefined && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.value
  }
  let value
  try {
    value = { entries: parseAliasMap(JSON.parse(readFileSync(mapPath, 'utf8'))), reason: 'ok' }
  } catch {
    // Malformed JSON / unreadable file: identity, and say so explicitly.
    value = { entries: [], reason: 'unreadable' }
  }
  CACHE.set(mapPath, { mtimeMs: stat.mtimeMs, size: stat.size, value })
  return value
}

/**
 * Canonicalize one cwd through the alias table.
 * @param {string | null | undefined} cwd - the session working directory.
 * @param {string | null | undefined} mapPath - absolute path to the alias table.
 * @returns {{cwd: string | null, alias: string | null, reason: string}}
 *   `reason` is one of: `aliased` | `unmapped` | `no-map` | `unreadable` |
 *   `no-map-path` | `no-cwd`. `cwd` is null only when the input is unusable.
 */
export function canonicalizeCwd(cwd, mapPath) {
  const normalized = normalizePath(cwd)
  if (normalized === null) return { cwd: null, alias: null, reason: 'no-cwd' }
  const { entries, reason } = loadEntries(mapPath)
  // Not aliased ⇒ return the caller's original string, not the normalized one:
  // projectHash() hashes the literal cwd, so normalizing an unmapped path (a
  // trailing slash, say) would silently move an existing project directory.
  if (reason !== 'ok') return { cwd, alias: null, reason }
  for (const { from, to } of entries) {
    if (normalized === from || normalized.startsWith(`${from}/`)) {
      // One hop only: the rewritten path is returned as-is, never re-scanned.
      return { cwd: to + normalized.slice(from.length), alias: from, reason: 'aliased' }
    }
  }
  return { cwd, alias: null, reason: 'unmapped' }
}

/** Drop the cached table (tests / diagnostics; mtime checks make it optional). */
export function resetAliasCache() {
  CACHE.clear()
}

/** Number of cached table paths (diagnostics). */
export function aliasCacheSize() {
  return CACHE.size
}
