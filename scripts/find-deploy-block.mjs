#!/usr/bin/env node
/**
 * Finds the deployment block of Starknet contracts by binary searching
 * starknet_getClassHashAt over block history (~21 RPC calls per contract).
 *
 * Usage:
 *   node find-deploy-block.mjs -n SN_MAIN 0xaddr [0xaddr…]   # look up addresses
 *   node find-deploy-block.mjs -n SN_MAIN --update           # fill in contracts.json
 *   node find-deploy-block.mjs --update                      # every network
 *
 * --update rewrites the "block" of any contract whose current value is 0 or
 * wrong, in place, preserving everything else in contracts.json.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const args = process.argv.slice(2)
const opts = { addresses: [], flags: new Set() }
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--network' || a === '-n') opts.network = args[++i]
  else if (a === '--contracts' || a === '-c') opts.contracts = args[++i]
  else if (a === '--update' || a === '--force') opts.flags.add(a.slice(2))
  else if (a.startsWith('0x')) opts.addresses.push(a)
  else die(`unknown argument: ${a}`)
}

function die(msg) {
  console.error(`ERROR: ${msg}`)
  process.exit(1)
}

const contractsPath = resolve(opts.contracts ?? process.env.CONTRACTS_JSON_PATH ?? './contracts.json')
const raw = readFileSync(contractsPath, 'utf8')
const data = JSON.parse(raw)

let rpcId = 0
async function rpc(url, method, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  })
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`)
  return res.json()
}

/** true if the contract exists at `block` (deployed at or before it). */
async function existsAt(url, address, block) {
  const out = await rpc(url, 'starknet_getClassHashAt', [{ block_number: block }, address])
  if (out.result) return true
  // 20 = CONTRACT_NOT_FOUND, 24 = BLOCK_NOT_FOUND
  if (out.error?.code === 20) return false
  throw new Error(`${address} @ ${block}: ${out.error?.message ?? JSON.stringify(out)}`)
}

async function findDeployBlock(url, address) {
  const head = (await rpc(url, 'starknet_blockNumber', [])).result
  if (typeof head !== 'number') throw new Error('could not read chain head')
  if (!(await existsAt(url, address, head))) return { block: null, head, calls: 1 }

  // invariant: lo is not deployed (or -1), hi is deployed
  let lo = -1
  let hi = head
  let calls = 1
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2)
    if (await existsAt(url, address, mid)) hi = mid
    else lo = mid
    calls++
  }
  return { block: hi, head, calls }
}

const networks = opts.network ? [opts.network] : Object.keys(data)
for (const name of networks) {
  const net = data[name]
  if (!net) die(`network "${name}" not found in ${contractsPath}`)
  const url = process.env.RPC_URL || net.rpc_url
  console.log(`\n=== ${name} (${url}) ===`)

  const all = [...(net.worlds ?? []), ...(net.contracts ?? [])]
  const targets = opts.addresses.length
    ? opts.addresses.map((address) => ({ name: '(cli)', address }))
    : all.filter((c) => opts.flags.has('force') || !c.block)

  if (!targets.length) {
    console.log('nothing to look up (every contract already has a block — pass --force to recheck)')
    continue
  }

  const results = await Promise.all(
    targets.map(async (c) => {
      try {
        const { block, calls } = await findDeployBlock(url, c.address)
        return { ...c, block, calls }
      } catch (e) {
        return { ...c, error: e.message }
      }
    }),
  )

  for (const r of results) {
    if (r.error) console.log(`  ${r.name.padEnd(18)} ERROR ${r.error}`)
    else if (r.block === null) console.log(`  ${r.name.padEnd(18)} NOT DEPLOYED on this network`)
    else console.log(`  ${r.name.padEnd(18)} block ${r.block}  (${r.calls} rpc calls)`)
  }

  if (opts.flags.has('update') && !opts.addresses.length) {
    for (const r of results) {
      if (r.error || r.block === null) continue
      const entry = all.find((c) => c.address === r.address)
      if (entry) entry.block = r.block
    }
  }
}

if (opts.flags.has('update') && !opts.addresses.length) {
  writeFileSync(contractsPath, `${JSON.stringify(data, null, 2)}\n`)
  console.log(`\nupdated ${contractsPath}`)
}
