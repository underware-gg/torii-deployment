// Parity with the original pistols torii configs in reference/pistols/. Intentional deviations
// (transactions off, extra contracts, world/LORDS possibly disabled) are asserted as such.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { generate, loadContracts, ROOT } from './helpers.mjs'
import { normalizeAddress, parseContractEntry, parseToml } from '../scripts/lib/toml.mjs'

const REFERENCE = { SN_MAIN: 'reference/pistols/torii_mainnet.toml', SN_SEPOLIA: 'reference/pistols/torii_sepolia.toml' }
const contracts = loadContracts()

for (const [network, refPath] of Object.entries(REFERENCE)) {
  const ref = parseToml(readFileSync(join(ROOT, refPath), 'utf8'))
  const net = contracts[network]
  const { config } = generate(network)
  const known = new Map([
    ...net.worlds.map((w) => [normalizeAddress(w.address), { ...w, type: 'WORLD' }]),
    ...net.contracts.map((c) => [normalizeAddress(c.address), c]),
  ])
  const ours = new Map(config.indexing.contracts.map((e) => { const c = parseContractEntry(e); return [c.address, c] }))

  test(`${network}: the reference world is in contracts.json and, if enabled, emitted as a WORLD entry`, () => {
    const addr = normalizeAddress(ref.world_address)
    const w = known.get(addr)
    assert.ok(w && w.type === 'WORLD', `world ${ref.world_address} missing from ${network}.worlds`)
    assert.equal(ours.has(addr), w.enabled === true)
    if (ours.has(addr)) assert.equal(ours.get(addr).type, 'WORLD')
  })

  test(`${network}: every reference token contract is in contracts.json with the same type`, () => {
    for (const entry of ref.indexing.contracts) {
      const r = parseContractEntry(entry)
      const c = known.get(r.address)
      assert.ok(c, `${entry} missing from ${network}.contracts`)
      assert.equal(c.type.toUpperCase(), r.type, `${entry}: type differs`)
      assert.equal(ours.has(r.address), c.enabled === true, `${c.game}/${c.name}: emitted iff enabled`)
    }
  })

  test(`${network}: rpc endpoint matches the reference`, () => {
    assert.equal(config.rpc, ref.rpc)
  })

  test(`${network}: sql.historical covers the reference list (index-time decision, must precede enabling the world)`, () => {
    for (const tag of ref.sql.historical) assert.ok(config.sql.historical.includes(tag), `${tag} missing from indexing.historical`)
  })

  test(`${network}: events.raw, controllers and pending→preconfirmed match the reference`, () => {
    assert.equal(config.events.raw, ref.events.raw)
    assert.equal(config.indexing.controllers, ref.indexing.controllers)
    assert.equal(config.indexing.preconfirmed, ref.indexing.pending)
  })

  test(`${network}: known deviation — transactions stay off (only a status-page count reads them)`, () => {
    assert.equal(ref.indexing.transactions, true)
    assert.equal(config.indexing.transactions, false)
  })

  test(`${network}: when the reference set is fully enabled, we start no later than the reference world_block`, (t) => {
    const refAddrs = [normalizeAddress(ref.world_address), ...ref.indexing.contracts.map((e) => parseContractEntry(e).address)]
    const disabled = refAddrs.filter((a) => !known.get(a)?.enabled)
    if (disabled.length) return t.skip(`not enabled: ${disabled.map((a) => (known.has(a) ? `${known.get(a).game}/${known.get(a).name}` : a)).join(', ')}`)
    assert.ok(config.indexing.world_block <= ref.indexing.world_block, `world_block ${config.indexing.world_block} > reference ${ref.indexing.world_block}`)
  })
}
