import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseToml } from '../scripts/lib/toml.mjs'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const GENERATOR = join(ROOT, 'template/scripts/generate-torii-config.mjs')
export const CONTRACTS_JSON = join(ROOT, 'contracts.json')

export function loadContracts() {
  return JSON.parse(readFileSync(CONTRACTS_JSON, 'utf8'))
}

/** Runs the generator with --print and returns { toml, config } (config = parsed TOML). */
export function generate(network, env = {}, contractsPath = CONTRACTS_JSON) {
  const toml = execFileSync('node', [GENERATOR, '--print', '-n', network, '-c', contractsPath], {
    encoding: 'utf8',
    env: { ...cleanEnv(), ...env },
  })
  return { toml, config: parseToml(toml) }
}

/** Runs the generator and returns { status, stdout, stderr } without throwing. */
export function run(args, env = {}) {
  const r = spawnSync('node', [GENERATOR, ...args], { encoding: 'utf8', env: { ...cleanEnv(), ...env } })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

/** Writes a contracts.json variant to a temp dir and returns its path. */
export function tempContracts(mutate) {
  const data = loadContracts()
  mutate(data)
  const dir = mkdtempSync(join(tmpdir(), 'torii-contracts-'))
  const path = join(dir, 'contracts.json')
  writeFileSync(path, JSON.stringify(data, null, 2))
  return path
}

/** The generator reads several env vars; a developer's shell must not leak into tests. */
function cleanEnv() {
  const env = { ...process.env }
  for (const k of ['NETWORK', 'CONTRACTS_JSON', 'CONTRACTS_JSON_PATH', 'GENERATED_TORII_TOML', 'RPC_URL', 'TORII_DB_DIR', 'TORII_ARTIFACTS_DIR', 'PORT', 'METRICS_PORT', 'CORS_ORIGINS']) delete env[k]
  return env
}

/**
 * The torii release pinned for a network in contracts.json: { repo, tag, version }, where
 * `version` is what that build prints for `torii --version`. The Underware fork stamps
 * `uw-v1.9.3` as `1.9.3-uw (base torii v1.8.16, <sha>)`; upstream `v1.8.16` prints plain `1.8.16`.
 */
export function pinnedTorii(network) {
  const { repo, tag } = loadContracts()[network]?.torii ?? {}
  if (!repo || !tag) throw new Error(`contracts.json: ${network}.torii.{repo,tag} not found`)
  const version = tag.startsWith('uw-v') ? `${tag.slice(4)}-uw` : tag.replace(/^v/, '')
  return { repo, tag, version }
}
