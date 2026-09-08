#!/usr/bin/env node
/**
 * Generates a Torii TOML config from the repo-root contracts.json.
 *
 * Usage:
 *   node generate-torii-config.mjs [--network SN_MAIN] [--out path] [--check]
 *
 * Env (all optional except NETWORK, which can also come from --network):
 *   NETWORK               SN_MAIN | SN_SEPOLIA — which section of contracts.json to use
 *   CONTRACTS_JSON_PATH   path to contracts.json      (default: /app/contracts.json)
 *   CONTRACTS_JSON        full contracts.json blob, overrides the file on disk
 *   GENERATED_TORII_TOML  output path                 (default: /app/torii.generated.toml)
 *   RPC_URL              overrides <NETWORK>.rpc_url
 *   TORII_DB_DIR         sqlite directory             (default: /data/torii-db)
 *   PORT                 http port, injected by Railway (default: 8080)
 *   METRICS_PORT         prometheus port              (default: 9200)
 *   CORS_ORIGINS         comma separated origins      (default: *)
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const VALID_TYPES = ['ERC20', 'ERC721', 'ERC1155']
const ADDRESS_RE = /^0x[0-9a-fA-F]{1,64}$/

const args = parseArgs(process.argv.slice(2))
const env = process.env

function parseArgs(argv) {
  const out = { flags: new Set() }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--check' || a === '--print') out.flags.add(a.slice(2))
    else if (a === '--network' || a === '-n') out.network = argv[++i]
    else if (a === '--out' || a === '-o') out.out = argv[++i]
    else if (a === '--contracts' || a === '-c') out.contracts = argv[++i]
    else die(`unknown argument: ${a}`)
  }
  return out
}

function die(msg) {
  console.error(`ERROR: ${msg}`)
  process.exit(1)
}

function loadContracts() {
  if (env.CONTRACTS_JSON) {
    try {
      return { source: '$CONTRACTS_JSON', data: JSON.parse(env.CONTRACTS_JSON) }
    } catch (e) {
      die(`$CONTRACTS_JSON is not valid JSON: ${e.message}`)
    }
  }
  const path = resolve(args.contracts ?? env.CONTRACTS_JSON_PATH ?? '/app/contracts.json')
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    die(`contracts file not found at ${path}`)
  }
  try {
    return { source: path, data: JSON.parse(raw) }
  } catch (e) {
    die(`${path} is not valid JSON: ${e.message}`)
  }
}

/** Validates one network section, returns its errors as a list of strings. */
function validateNetwork(name, net) {
  const errors = []
  if (!net || typeof net !== 'object') return [`${name}: not an object`]

  const worlds = net.worlds ?? []
  const contracts = net.contracts ?? []
  if (!Array.isArray(worlds)) return [`${name}: "worlds" must be an array`]
  if (!Array.isArray(contracts)) return [`${name}: "contracts" must be an array`]

  const seen = new Map()
  const seenNames = new Set()

  // worlds and contracts share one address space: both end up in
  // indexing.contracts, so the same checks apply to both.
  for (const [kind, list] of [
    ['worlds', worlds],
    ['contracts', contracts],
  ]) {
    for (const [i, c] of list.entries()) {
      const label = `${name}.${kind}[${i}]${c?.name ? ` (${c.name})` : ''}`
      if (!c?.name) errors.push(`${label}: missing "name"`)
      if (!c?.game) errors.push(`${label}: missing "game"`)
      if (typeof c?.enabled !== 'boolean') errors.push(`${label}: "enabled" must be true or false`)
      if (kind === 'contracts' && !VALID_TYPES.includes(String(c?.type ?? '').toUpperCase())) {
        errors.push(`${label}: invalid type "${c?.type ?? ''}" (want ${VALID_TYPES.join(', ')})`)
      }
      if (!ADDRESS_RE.test(c?.address ?? '')) errors.push(`${label}: invalid address "${c?.address ?? ''}"`)
      if (!Number.isInteger(c?.block) || c.block < 0) errors.push(`${label}: "block" must be a non-negative integer`)
      // Client-only fields (see README). Torii never sees them, but a typo here is a broken card
      // shape on the felt with nothing to say so — and this is the one place the file is validated.
      if (c?.aspect !== undefined && !(typeof c.aspect === 'number' && c.aspect > 0)) {
        errors.push(`${label}: "aspect" must be a positive number`)
      }

      // same address twice would make Torii index it twice
      const key = String(c?.address ?? '').toLowerCase().replace(/^0x0*/, '0x')
      if (seen.has(key)) errors.push(`${label}: duplicate address, already used by "${seen.get(key)}"`)
      else seen.set(key, `${c?.game}/${c?.name}`)

      const gameName = `${kind}:${c?.game}/${c?.name}`
      if (seenNames.has(gameName)) errors.push(`${label}: duplicate game/name "${c?.game}/${c?.name}"`)
      else seenNames.add(gameName)
    }
  }

  if (![...worlds, ...contracts].some((c) => c.enabled === true)) {
    errors.push(`${name}: nothing enabled — Torii would have nothing to index`)
  }
  if (!(env.RPC_URL || net.rpc_url)) errors.push(`${name}: missing "rpc_url" (or set the RPC_URL env var)`)

  return errors
}

function toToml(networkName, net, source) {
  // Torii accepts "contract_type:address:starting_block" and tracks a separate
  // head per entry, so each world/token backfills from its own deployment
  // block instead of from genesis. Multiple WORLD entries are supported —
  // verified against torii 1.8.16, which stores models per world_address.
  const entries = [
    ...(net.worlds ?? [])
      .filter((w) => w.enabled === true)
      .map((w) => ({ type: 'WORLD', address: w.address, block: w.block, label: `${w.game}/${w.name}` })),
    ...(net.contracts ?? [])
      .filter((c) => c.enabled === true)
      .map((c) => ({ type: c.type.toUpperCase(), address: c.address, block: c.block, label: `${c.game}/${c.name}` })),
  ]

  // The indexer starts scanning at the oldest enabled block.
  const startBlock = Math.min(...entries.map((e) => e.block))

  const idx = net.indexing ?? {}
  const corsOrigins = (env.CORS_ORIGINS ?? '*')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  const lines = [
    `# GENERATED by scripts/generate-torii-config.mjs — do not edit by hand.`,
    `# Source: ${source} [${networkName}]`,
    `rpc = "${env.RPC_URL || net.rpc_url}"`,
    `db_dir = "${env.TORII_DB_DIR ?? '/data/torii-db'}"`,
    ``,
    `[indexing]`,
    `contracts = [`,
    ...entries.map((e) => `  "${e.type}:${e.address}:${e.block}", # ${e.label}`),
    `]`,
    `world_block = ${startBlock}`,
    `namespaces = ${JSON.stringify(idx.namespaces ?? [])}`,
    `models = ${JSON.stringify(idx.models ?? [])}`,
    `controllers = ${idx.controllers === true}`,
    `transactions = ${idx.transactions === true}`,
    `preconfirmed = ${idx.preconfirmed === true}`,
    ``,
    `[events]`,
    `raw = ${idx.raw_events === true}`,
    ``,
    `[server]`,
    `http_addr = "0.0.0.0"`,
    `http_port = ${Number(env.PORT ?? 8080)}`,
    `http_cors_origins = ${JSON.stringify(corsOrigins)}`,
    ``,
    `[metrics]`,
    `metrics = true`,
    `metrics_addr = "0.0.0.0"`,
    `metrics_port = ${Number(env.METRICS_PORT ?? 9200)}`,
    ``,
  ]

  return { toml: lines.join('\n'), startBlock, count: entries.length }
}

// --- main -------------------------------------------------------------------

const { source, data } = loadContracts()
const networks = Object.keys(data)

if (args.flags.has('check')) {
  const errors = networks.flatMap((n) => validateNetwork(n, data[n]))
  if (errors.length) die(`${source} is invalid:\n  ${errors.join('\n  ')}`)
  for (const n of networks) {
    const worlds = (data[n].worlds ?? []).map((w) => ({ ...w, type: 'WORLD' }))
    const all = [...worlds, ...(data[n].contracts ?? [])]
    const on = all.filter((c) => c.enabled)
    console.log(`\n${n}: ${on.length}/${all.length} enabled (${worlds.filter((w) => w.enabled).length}/${worlds.length} worlds)`)
    for (const game of [...new Set(all.map((c) => c.game))]) {
      const inGame = all.filter((c) => c.game === game)
      console.log(`  ${game} (${inGame.filter((c) => c.enabled).length}/${inGame.length})`)
      for (const c of inGame) {
        console.log(`    ${c.enabled ? '[x]' : '[ ]'} ${c.type.padEnd(7)} ${c.name.padEnd(16)} block ${String(c.block).padStart(8)}`)
      }
    }
  }
  console.log(`\n${source} OK`)
  process.exit(0)
}

const network = args.network ?? env.NETWORK
if (!network) die(`NETWORK must be set (one of: ${networks.join(', ')})`)
if (!data[network]) die(`network "${network}" not found in ${source} (have: ${networks.join(', ')})`)

const errors = validateNetwork(network, data[network])
if (errors.length) die(`invalid config for ${network}:\n  ${errors.join('\n  ')}`)

const { toml, startBlock, count } = toToml(network, data[network], source)

if (args.flags.has('print')) {
  process.stdout.write(toml)
  process.exit(0)
}

const out = resolve(args.out ?? env.GENERATED_TORII_TOML ?? '/app/torii.generated.toml')
writeFileSync(out, toml)
console.log(`--- generated ${out} (${network}, ${count} contracts, from block ${startBlock}) ---`)
process.stdout.write(toml)
console.log(`--- end of config ---`)
