#!/usr/bin/env node
/**
 * Side-by-side of what we generate vs the original pistols torii configs in reference/pistols/.
 * A report, not a gate — `pnpm test` holds the assertions. Deviations are expected: we index
 * more contracts, keep transactions off, and may have the world/LORDS disabled for now.
 *
 * Usage: node scripts/compare-reference.mjs [SN_MAIN|SN_SEPOLIA]
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeAddress, parseContractEntry, parseToml } from './lib/toml.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REFERENCE = { SN_MAIN: 'reference/pistols/torii_mainnet.toml', SN_SEPOLIA: 'reference/pistols/torii_sepolia.toml' }
const only = process.argv[2]
const networks = only ? [only] : Object.keys(REFERENCE)

const contractsJson = JSON.parse(readFileSync(join(ROOT, 'contracts.json'), 'utf8'))

for (const network of networks) {
  if (!REFERENCE[network]) { console.error(`no reference for ${network}`); process.exit(1) }
  const ref = parseToml(readFileSync(join(ROOT, REFERENCE[network]), 'utf8'))
  const ours = parseToml(execFileSync('node', [join(ROOT, 'template/scripts/generate-torii-config.mjs'), '--print', '-n', network, '-c', join(ROOT, 'contracts.json')], { encoding: 'utf8' }))
  const net = contractsJson[network]

  console.log(`\n=== ${network}  (${REFERENCE[network]} vs generated)\n`)
  const rows = [
    ['rpc', ref.rpc, ours.rpc],
    ['world_block', ref.indexing?.world_block, ours.indexing?.world_block],
    ['indexing.transactions', ref.indexing?.transactions, ours.indexing?.transactions],
    ['indexing.controllers', ref.indexing?.controllers, ours.indexing?.controllers],
    ['indexing.pending → preconfirmed', ref.indexing?.pending, ours.indexing?.preconfirmed],
    ['events.raw', ref.events?.raw, ours.events?.raw],
    ['sql.historical', (ref.sql?.historical ?? []).join(' '), (ours.sql?.historical ?? []).join(' ')],
    ['erc.artifacts_path', ref.erc?.artifacts_path, ours.erc?.artifacts_path],
  ]
  printTable(['setting', 'reference', 'generated', ''], rows.map(([k, a, b]) => [k, show(a), show(b), String(a) === String(b) ? 'same' : 'DIFF']))

  // contracts: the reference's world_address + indexing.contracts vs our indexing.contracts,
  // plus anything in contracts.json that is present but disabled.
  const refEntries = new Map()
  if (ref.world_address) refEntries.set(normalizeAddress(ref.world_address), 'WORLD')
  for (const e of ref.indexing?.contracts ?? []) { const c = parseContractEntry(e); refEntries.set(c.address, c.type) }
  const ourEntries = new Map((ours.indexing?.contracts ?? []).map((e) => { const c = parseContractEntry(e); return [c.address, c] }))
  const known = new Map()
  for (const w of net.worlds ?? []) known.set(normalizeAddress(w.address), { ...w, type: 'WORLD' })
  for (const c of net.contracts ?? []) known.set(normalizeAddress(c.address), c)

  const crows = []
  for (const addr of new Set([...refEntries.keys(), ...ourEntries.keys()])) {
    const inRef = refEntries.get(addr)
    const mine = ourEntries.get(addr)
    const meta = known.get(addr)
    const label = meta ? `${meta.game}/${meta.name}` : '?'
    let status
    if (inRef && mine) status = inRef === mine.type ? 'same' : `TYPE DIFF (${inRef} vs ${mine.type})`
    else if (inRef && meta) status = `in contracts.json, enabled: ${meta.enabled}`
    else if (inRef) status = 'MISSING from contracts.json'
    else status = 'ours only'
    crows.push([inRef ?? mine.type, addr.slice(0, 12) + '…', label, status])
  }
  console.log()
  printTable(['type', 'address', 'name', 'status'], crows.sort((a, b) => a[3].localeCompare(b[3]) || a[2].localeCompare(b[2])))
}

function show(v) { return v === undefined ? '—' : String(v) }
function printTable(head, rows, max = 64) {
  const cell = (c) => (String(c).length > max ? String(c).slice(0, max - 1) + '…' : String(c))
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => cell(r[i]).length)))
  const line = (r) => r.map((c, i) => cell(c).padEnd(w[i])).join('  ').trimEnd()
  console.log(line(head)); console.log(w.map((n) => '-'.repeat(n)).join('  ')); rows.forEach((r) => console.log(line(r)))
}
