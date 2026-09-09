// What the generator emits for the real contracts.json, per network, and what it rejects.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generate, loadContracts, run, tempContracts, CONTRACTS_JSON } from './helpers.mjs'
import { normalizeAddress, parseContractEntry } from '../scripts/lib/toml.mjs'

const contracts = loadContracts()
const networks = Object.keys(contracts)

test('contracts.json passes --check', () => {
  const r = run(['--check', '-c', CONTRACTS_JSON])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /OK\s*$/)
})

for (const network of networks) {
  const net = contracts[network]
  const enabled = [
    ...net.worlds.filter((w) => w.enabled).map((w) => ({ ...w, type: 'WORLD' })),
    ...net.contracts.filter((c) => c.enabled),
  ]

  test(`${network}: indexing.contracts is exactly the enabled entries, worlds first`, () => {
    const { config } = generate(network)
    const entries = config.indexing.contracts.map(parseContractEntry)
    assert.deepEqual(
      entries.map((e) => [e.type, e.address, e.block]),
      enabled.map((e) => [e.type.toUpperCase(), normalizeAddress(e.address), e.block]),
    )
    const worldIdx = entries.map((e) => e.type === 'WORLD')
    assert.ok(!worldIdx.includes(true) || worldIdx.lastIndexOf(true) < worldIdx.indexOf(false) || !worldIdx.includes(false), 'WORLD entries must come first')
    assert.equal(new Set(entries.map((e) => e.address)).size, entries.length, 'no duplicate addresses')
    for (const e of config.indexing.contracts) assert.match(e, /^(WORLD|ERC20|ERC721|ERC1155):0x[0-9a-f]+:\d+$/i)
  })

  test(`${network}: world_block is the oldest enabled block`, () => {
    const { config } = generate(network)
    assert.equal(config.indexing.world_block, Math.min(...enabled.map((e) => e.block)))
  })

  test(`${network}: indexing flags, events.raw and sql.historical mirror contracts.json`, () => {
    const { config } = generate(network)
    const idx = net.indexing
    assert.equal(config.rpc, net.rpc_url)
    assert.deepEqual(config.indexing.namespaces, idx.namespaces ?? [])
    assert.deepEqual(config.indexing.models, idx.models ?? [])
    assert.equal(config.indexing.controllers, idx.controllers === true)
    assert.equal(config.indexing.transactions, idx.transactions === true)
    assert.equal(config.indexing.preconfirmed, idx.preconfirmed === true)
    assert.equal(config.events.raw, idx.raw_events === true)
    assert.deepEqual(config.sql.historical, idx.historical ?? [])
    assert.equal('pending' in config.indexing, false, 'pending was renamed preconfirmed in torii 1.8')
    assert.equal('world_address' in config, false, 'top-level world_address is not emitted; WORLD: entries carry it')
  })

  test(`${network}: paths and ports — defaults`, () => {
    const { config } = generate(network)
    assert.equal(config.db_dir, '/data/torii-db')
    assert.equal(config.erc.artifacts_path, '/data/static')
    assert.equal(config.server.http_addr, '0.0.0.0')
    assert.equal(config.server.http_port, 8080)
    assert.deepEqual(config.server.http_cors_origins, ['*'])
    assert.equal(config.metrics.metrics, true)
    assert.equal(config.metrics.metrics_port, 9200)
  })

  test(`${network}: paths and ports — env overrides`, () => {
    const { config } = generate(network, { TORII_DB_DIR: '/mnt/vol/db', PORT: '3000', METRICS_PORT: '9999', CORS_ORIGINS: 'https://a.example, https://b.example', RPC_URL: 'https://rpc.example' })
    assert.equal(config.db_dir, '/mnt/vol/db')
    assert.equal(config.erc.artifacts_path, '/mnt/vol/static', 'artifacts default to <parent of db_dir>/static')
    assert.equal(config.server.http_port, 3000)
    assert.equal(config.metrics.metrics_port, 9999)
    assert.deepEqual(config.server.http_cors_origins, ['https://a.example', 'https://b.example'])
    assert.equal(config.rpc, 'https://rpc.example')
    const explicit = generate(network, { TORII_DB_DIR: '/mnt/vol/db', TORII_ARTIFACTS_DIR: '/elsewhere' })
    assert.equal(explicit.config.erc.artifacts_path, '/elsewhere')
  })
}

// --- validation ---------------------------------------------------------------

const first = networks[0]

test('rejects an unknown indexing key (e.g. the pre-1.8 "pending")', () => {
  const path = tempContracts((d) => { d[first].indexing.pending = true })
  const r = run(['--check', '-c', path])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /indexing\.pending: unknown key/)
})

test('rejects a missing or malformed torii pin', () => {
  let r = run(['--check', '-c', tempContracts((d) => { delete d[first].torii })])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /missing "torii"/)
  r = run(['--check', '-c', tempContracts((d) => { d[first].torii = { repo: 'torii', tag: '1.9.3' } })])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /torii\.repo: "torii" is not a GitHub owner\/name/)
  assert.match(r.stderr, /torii\.tag: "1\.9\.3" is not a release tag/)
})

test('rejects a historical entry that is not a namespace-Model tag', () => {
  const path = tempContracts((d) => { d[first].indexing.historical = ['PlayerActivityEvent'] })
  const r = run(['--check', '-c', path])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /historical: "PlayerActivityEvent" is not a namespace-Model tag/)
})

test('rejects a duplicate address across worlds and contracts', () => {
  const path = tempContracts((d) => {
    const w = d[first].worlds[0]
    d[first].contracts.push({ name: 'dupe', game: 'x', type: 'ERC20', address: w.address.toUpperCase(), block: 1, enabled: true })
  })
  const r = run(['--check', '-c', path])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /duplicate address/)
})

test('rejects a network with nothing enabled', () => {
  const path = tempContracts((d) => { for (const c of [...d[first].worlds, ...d[first].contracts]) c.enabled = false })
  const r = run(['--check', '-c', path])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /nothing enabled/)
})

test('rejects an unknown network name', () => {
  const r = run(['--print', '-n', 'SN_NOPE', '-c', CONTRACTS_JSON])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /network "SN_NOPE" not found/)
})
