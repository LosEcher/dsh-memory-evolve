/**
 * Cwd alias canonicalization tests (lib/path-alias.js + its wiring in
 * makeProjectDirResolver).
 *
 * The invariant under test: a session whose cwd is a moved-away path must
 * resolve to the *live* project directory, and must keep resolving there after
 * the alias table is edited. The negative controls matter as much as the
 * positive ones — a broken table must degrade to identity (never to a guess),
 * and an unmapped cwd must keep its exact hash.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { aliasCacheSize, canonicalizeCwd, parseAliasMap, resetAliasCache } from '../lib/path-alias.js'
import { makeProjectDirResolver, canonicalProjectCwd } from '../lib/sync/index.js'
import { projectHash } from '../lib/store.js'

/** Build a temp dir with an alias table; returns {dir, mapPath, write}. */
function fixture(declared, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-alias-'))
  const mapPath = join(dir, 'path-alias-map.json')
  const write = (value) => writeFileSync(mapPath, typeof value === 'string' ? value : JSON.stringify({ version: 1, declared: value }))
  if (options.skipWrite !== true) write(declared)
  return { dir, mapPath, write, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('parseAliasMap drops self-maps and unusable rows, longest prefix first', () => {
  const entries = parseAliasMap({
    declared: [
      { from: '/old/a/b', to: '/new/a/b' },
      { from: '/old/a', to: '/new/a' },
      { from: '/same', to: '/same' },
      { from: '/no-target' },
      { from: '', to: '/new/empty' },
      null,
      'nonsense',
    ],
  })
  assert.deepEqual(entries, [
    { from: '/old/a/b', to: '/new/a/b' },
    { from: '/old/a', to: '/new/a' },
  ])
})

test('parseAliasMap tolerates missing/odd documents', () => {
  assert.deepEqual(parseAliasMap(null), [])
  assert.deepEqual(parseAliasMap({}), [])
  assert.deepEqual(parseAliasMap({ declared: 'nope' }), [])
})

test('exact match and longest-prefix match both resolve', () => {
  const fx = fixture([
    { from: '/old/a', to: '/new/a' },
    { from: '/old/a/b', to: '/new/a/b' },
  ])
  try {
    assert.deepEqual(canonicalizeCwd('/old/a/b', fx.mapPath), { cwd: '/new/a/b', alias: '/old/a/b', reason: 'aliased' })
    // Longest match must win even though '/old/a' also matches this path.
    assert.equal(canonicalizeCwd('/old/a/b/deep/file.md', fx.mapPath).cwd, '/new/a/b/deep/file.md')
    assert.equal(canonicalizeCwd('/old/a/other', fx.mapPath).cwd, '/new/a/other')
  } finally {
    fx.cleanup()
  }
})

test('prefix match respects the "/" boundary (negative control)', () => {
  const fx = fixture([{ from: '/old/a/b', to: '/new/a/b' }])
  try {
    // '/old/a/bc' starts with '/old/a/b' as a string but is a different repo.
    const hit = canonicalizeCwd('/old/a/bc', fx.mapPath)
    assert.deepEqual({ cwd: hit.cwd, reason: hit.reason }, { cwd: '/old/a/bc', reason: 'unmapped' })
  } finally {
    fx.cleanup()
  }
})

test('aliases are applied at most one hop (no chain chasing)', () => {
  const fx = fixture([
    { from: '/gen1', to: '/gen2' },
    { from: '/gen2', to: '/gen3' },
  ])
  try {
    // '/gen1' → '/gen2', and it must stop there: re-scanning would land on
    // '/gen3' and a bad table would silently move data twice.
    assert.equal(canonicalizeCwd('/gen1', fx.mapPath).cwd, '/gen2')
  } finally {
    fx.cleanup()
  }
})

test('an aliased path is rewritten without a trailing slash, interior kept', () => {
  const fx = fixture([{ from: '/old/a', to: '/new/a' }])
  try {
    assert.equal(canonicalizeCwd('/old/a/', fx.mapPath).cwd, '/new/a')
    assert.equal(canonicalizeCwd('/old/a/sub/', fx.mapPath).cwd, '/new/a/sub')
  } finally {
    fx.cleanup()
  }
})

test('unmapped cwd keeps its exact original string (hash stability)', () => {
  const fx = fixture([{ from: '/old/a', to: '/new/a' }])
  try {
    // Trailing slash is preserved: projectHash() hashes the literal path, so
    // normalizing it here would silently relocate an existing project.
    assert.deepEqual(canonicalizeCwd('/somewhere/else/', fx.mapPath), {
      cwd: '/somewhere/else/', alias: null, reason: 'unmapped',
    })
  } finally {
    fx.cleanup()
  }
})

test('missing table / broken JSON / no path all degrade to identity with distinct reasons', () => {
  resetAliasCache()
  const missing = fixture([], { skipWrite: true })
  try {
    assert.deepEqual(canonicalizeCwd('/x/y', missing.mapPath), { cwd: '/x/y', alias: null, reason: 'no-map' })
    missing.write('{ this is not json')
    assert.deepEqual(canonicalizeCwd('/x/y', missing.mapPath), { cwd: '/x/y', alias: null, reason: 'unreadable' })
    assert.deepEqual(canonicalizeCwd('/x/y', undefined), { cwd: '/x/y', alias: null, reason: 'no-map-path' })
    assert.deepEqual(canonicalizeCwd('', missing.mapPath), { cwd: null, alias: null, reason: 'no-cwd' })
  } finally {
    missing.cleanup()
  }
})

test('editing the table is picked up without a restart', () => {
  const fx = fixture([{ from: '/old', to: '/first' }])
  try {
    assert.equal(canonicalizeCwd('/old', fx.mapPath).cwd, '/first')
    fx.write([{ from: '/old', to: '/second' }])
    // Different byte length guarantees a different size even if mtime is coarse.
    assert.ok(statSync(fx.mapPath).size > 0)
    assert.equal(canonicalizeCwd('/old', fx.mapPath).cwd, '/second')
    // Same-size rewrite: mtime bump must still invalidate the cache.
    const before = statSync(fx.mapPath).mtimeMs
    writeFileSync(fx.mapPath, JSON.stringify({ version: 1, declared: [{ from: '/old', to: '/third' }] }))
    utimesSync(fx.mapPath, new Date(), new Date(before + 5000))
    assert.equal(canonicalizeCwd('/old', fx.mapPath).cwd, '/third')
  } finally {
    fx.cleanup()
  }
})

test('cache is keyed per table path (two tables do not interfere)', () => {
  resetAliasCache()
  const a = fixture([{ from: '/p', to: '/a' }])
  const b = fixture([{ from: '/p', to: '/b' }])
  try {
    assert.equal(canonicalizeCwd('/p', a.mapPath).cwd, '/a')
    assert.equal(canonicalizeCwd('/p', b.mapPath).cwd, '/b')
    assert.equal(aliasCacheSize(), 2)
  } finally {
    a.cleanup()
    b.cleanup()
  }
})

test('makeProjectDirResolver sends a moved-away cwd to the live project dir', () => {
  const fx = fixture([{ from: '/old/dsfolder', to: '/live/dsfolder' }])
  const memoryDir = mkdtempSync(join(tmpdir(), 'dsh-mem-'))
  try {
    const config = { memoryDir, pathAliasMap: fx.mapPath, cwdCanonicalization: true }
    const resolveDir = makeProjectDirResolver(config)
    assert.equal(resolveDir('/old/dsfolder'), join(memoryDir, 'projects', projectHash('/live/dsfolder')))
    // The sub-directory case (a nested repo under the moved root) follows too.
    assert.equal(resolveDir('/old/dsfolder/unirun'), join(memoryDir, 'projects', projectHash('/live/dsfolder/unirun')))
    // Negative control: with canonicalization off, the old hash comes back —
    // i.e. the wiring (not the alias module) is what moves the directory.
    const off = makeProjectDirResolver({ ...config, cwdCanonicalization: false })
    assert.equal(off('/old/dsfolder'), join(memoryDir, 'projects', projectHash('/old/dsfolder')))
    // And with a live cwd both agree.
    assert.equal(resolveDir('/live/dsfolder'), join(memoryDir, 'projects', projectHash('/live/dsfolder')))
  } finally {
    fx.cleanup()
    rmSync(memoryDir, { recursive: true, force: true })
  }
})

test('canonicalProjectCwd falls back to the raw cwd on any table problem', () => {
  assert.equal(canonicalProjectCwd({ pathAliasMap: '/nope/missing.json' }, '/a/b'), '/a/b')
  assert.equal(canonicalProjectCwd({}, '/a/b'), '/a/b')
  assert.equal(canonicalProjectCwd({ cwdCanonicalization: false, pathAliasMap: '/nope' }, '/a/b'), '/a/b')
})

test('a PROVENANCE-initialised sync directory still wins over the hash', () => {
  // sync 项目（有 PROVENANCE）的目录由 projectId 决定；canonicalization 只影响
  // 回退分支。这里断言注入别名后仍优先 sync 目录，防止把它误改回 hash 目录。
  const fx = fixture([{ from: '/old/repo', to: '/live/repo' }])
  const memoryDir = mkdtempSync(join(tmpdir(), 'dsh-mem2-'))
  try {
    const syncDir = join(memoryDir, 'projects', projectHash('/live/repo'))
    mkdirSync(syncDir, { recursive: true })
    writeFileSync(join(syncDir, 'PROVENANCE'), JSON.stringify({ remoteUrl: 'git@example.com:x/y.git' }))
    const resolveDir = makeProjectDirResolver({ memoryDir, pathAliasMap: fx.mapPath, cwdCanonicalization: true })
    assert.equal(resolveDir('/old/repo'), syncDir)
  } finally {
    fx.cleanup()
    rmSync(memoryDir, { recursive: true, force: true })
  }
})
