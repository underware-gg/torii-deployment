import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { CONTRACTS_JSON, ROOT, loadContracts } from './helpers.mjs'

const PRUNE = join(ROOT, 'template/scripts/prune-disabled-contracts.sh')
const NETWORK = 'SN_MAIN'
const hasSqlite = spawnSync('sqlite3', ['--version']).status === 0
const skip = hasSqlite ? false : 'sqlite3 not installed'

/** How torii stores an address: 0x + 64 hex, lowercase. */
const pad = (a) => '0x' + a.slice(2).toLowerCase().padStart(64, '0')
const sql = (db, query) => spawnSync('sqlite3', [db, query], { encoding: 'utf8' }).stdout.trim()
const prune = (db) => spawnSync(PRUNE, [db], { encoding: 'utf8', env: { ...process.env, NETWORK, CONTRACTS_JSON_PATH: CONTRACTS_JSON } })

const net = loadContracts()[NETWORK]
const all = [...net.worlds, ...net.contracts]
const disabled = all.filter((c) => !c.enabled).map((c) => pad(c.address))
const enabled = all.filter((c) => c.enabled).map((c) => pad(c.address))
const UNLISTED = pad('0xabc123') // e.g. an external contract torii registered by itself

function makeDb(rows) {
  const db = join(mkdtempSync(join(tmpdir(), 'torii-prune-')), 'torii.db')
  sql(db, 'CREATE TABLE contracts (id TEXT PRIMARY KEY, contract_address TEXT, contract_type TEXT, head BIGINT);')
  for (const [address, head] of rows) sql(db, `INSERT INTO contracts VALUES ('${address}', '${address}', 'ERC721', ${head ?? 'NULL'});`)
  return db
}
const remaining = (db) => sql(db, 'SELECT contract_address FROM contracts ORDER BY rowid').split('\n').filter(Boolean)

test('prune removes only disabled contracts that were never indexed', { skip }, () => {
  assert.ok(disabled.length >= 2 && enabled.length >= 1, 'fixture: contracts.json has disabled and enabled entries')
  const db = makeDb([
    [disabled[0], null], // disabled, never indexed → pruned
    [disabled[1], 123], // disabled but indexed → kept, it holds data
    [enabled[0], null], // enabled, not started yet → kept
    [UNLISTED, null], // not in contracts.json → kept
  ])
  const r = prune(db)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, new RegExp(disabled[0]))
  assert.deepEqual(remaining(db), [disabled[1], enabled[0], UNLISTED])
  // second run is a no-op
  assert.equal(prune(db).stdout, '')
  assert.deepEqual(remaining(db), [disabled[1], enabled[0], UNLISTED])
})

test('prune never fails the boot', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'torii-prune-'))
  assert.equal(prune(join(dir, 'missing.db')).status, 0, 'no db yet')
  const garbage = join(dir, 'torii.db')
  writeFileSync(garbage, 'not a database')
  const r = prune(garbage)
  assert.equal(r.status, 0)
  assert.match(r.stderr, /WARNING: prune skipped/)
})
