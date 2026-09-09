// Boots the pinned torii with the generated config and checks it accepts every section.
// Skipped when the local torii is not the pinned build: TORII_BIN, or `torii` on PATH.
// Needs network access for the RPC spec-version handshake.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { generate, loadContracts, pinnedTorii, ROOT } from './helpers.mjs'

const pinned = pinnedTorii()
const TORII_BIN = process.env.TORII_BIN || 'torii'
const local = spawnSync(TORII_BIN, ['--version'], { encoding: 'utf8', cwd: ROOT })
const localVersion = local.status === 0 ? /torii (\S+)/.exec(local.stdout)?.[1] : undefined
const skip = localVersion !== pinned.version ? `torii ${pinned.version} (${pinned.tag}) not at ${TORII_BIN} (found ${localVersion ?? 'none'})` : false

for (const network of Object.keys(loadContracts())) {
  test(`${network}: torii ${pinned.version} boots with the generated config`, { skip, timeout: 90_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), `torii-smoke-${network}-`))
    const { toml } = generate(network, { TORII_DB_DIR: join(dir, 'torii-db'), PORT: '0', METRICS_PORT: '0' })
    const configPath = join(dir, 'torii.toml')
    writeFileSync(configPath, toml)

    // relay/gRPC ports are fixed defaults; a second torii on this machine would collide.
    const child = spawn(TORII_BIN, ['--config', configPath, '--relay.port', '0', '--relay.webrtc_port', '0', '--relay.websocket_port', '0', '--grpc.addr', '127.0.0.1', '--grpc.port', '0'], { cwd: ROOT })
    let log = ''
    child.stdout.on('data', (d) => (log += d))
    child.stderr.on('data', (d) => (log += d))

    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`torii did not reach "Serving" within 60s:\n${log}`)), 60_000)
        const check = () => {
          if (/Serving ERC artifacts at path/.test(log)) { clearTimeout(timer); resolve() }
        }
        child.stdout.on('data', check)
        child.stderr.on('data', check)
        child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`torii exited early (${code}):\n${log}`)) })
      })
    } finally {
      child.kill('SIGTERM')
    }

    assert.doesNotMatch(log, /unknown field|invalid type|Address already in use/i, log)
    assert.match(log, new RegExp(`Serving ERC artifacts at path.*${join(dir, 'static').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  })
}
