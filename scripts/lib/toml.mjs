/**
 * Minimal TOML reader — enough for the subset torii configs use: `[table]` headers, bare keys,
 * strings, integers, booleans and (multi-line) arrays of those, `#` comments. Dotted keys,
 * inline tables and arrays of tables are rejected loudly rather than misread. Not a general
 * parser; it exists so tests and scripts/compare-reference.mjs have no npm dependency.
 */
export function parseToml(text) {
  const root = {}
  let table = root
  const lines = stripComments(text).split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue

    const header = /^\[([^\]]+)\]$/.exec(line)
    if (header) {
      if (line.startsWith('[[')) throw new Error(`toml: arrays of tables not supported (${line})`)
      table = root
      for (const part of header[1].split('.')) table = table[part.trim()] ??= {}
      continue
    }

    const eq = line.indexOf('=')
    if (eq < 0) throw new Error(`toml: cannot parse line ${i + 1}: ${line}`)
    const key = line.slice(0, eq).trim()
    if (!/^[A-Za-z0-9_-]+$/.test(key)) throw new Error(`toml: unsupported key "${key}"`)
    let raw = line.slice(eq + 1).trim()

    // multi-line array: keep appending lines until brackets balance
    while (depth(raw) > 0) {
      if (++i >= lines.length) throw new Error(`toml: unterminated array for "${key}"`)
      raw += '\n' + lines[i]
    }
    table[key] = parseValue(raw.trim(), key)
  }
  return root
}

function parseValue(raw, key) {
  if (raw.startsWith('"')) {
    if (!raw.endsWith('"') || raw.length < 2) throw new Error(`toml: bad string for "${key}"`)
    return JSON.parse(raw)
  }
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (/^-?\d[\d_]*$/.test(raw)) return Number(raw.replace(/_/g, ''))
  if (raw.startsWith('[')) {
    if (!raw.endsWith(']')) throw new Error(`toml: bad array for "${key}"`)
    return splitTopLevel(raw.slice(1, -1)).map((item) => parseValue(item, key))
  }
  throw new Error(`toml: unsupported value for "${key}": ${raw}`)
}

/** Splits array body on commas outside strings/nested brackets; ignores a trailing comma. */
function splitTopLevel(body) {
  const items = []
  let cur = '', d = 0, inStr = false
  for (const ch of body) {
    if (ch === '"') inStr = !inStr
    if (!inStr) {
      if (ch === '[') d++
      else if (ch === ']') d--
      else if (ch === ',' && d === 0) { items.push(cur); cur = ''; continue }
    }
    cur += ch
  }
  items.push(cur)
  return items.map((s) => s.trim()).filter(Boolean)
}

function depth(s) {
  let d = 0, inStr = false
  for (const ch of s) {
    if (ch === '"') inStr = !inStr
    else if (!inStr && ch === '[') d++
    else if (!inStr && ch === ']') d--
  }
  return d
}

function stripComments(text) {
  return text
    .split('\n')
    .map((line) => {
      let inStr = false
      for (let i = 0; i < line.length; i++) {
        if (line[i] === '"') inStr = !inStr
        else if (line[i] === '#' && !inStr) return line.slice(0, i)
      }
      return line
    })
    .join('\n')
}

/** 0x-prefixed felt → lowercase, no leading zeros, so 0x0124… and 0x124… compare equal. */
export function normalizeAddress(addr) {
  return '0x' + String(addr).toLowerCase().replace(/^0x/, '').replace(/^0+(?=.)/, '')
}

/** "erc721:0xabc" / "WORLD:0xabc:123" → { type: 'ERC721', address, block? } */
export function parseContractEntry(entry) {
  const [type, address, block] = String(entry).split(':')
  return { type: type.toUpperCase(), address: normalizeAddress(address), block: block === undefined ? undefined : Number(block) }
}
