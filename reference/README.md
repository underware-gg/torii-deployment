# reference/

Frozen copies of configs we replace or must stay compatible with. **Never shipped, never
generated from** — they exist so `pnpm compare` and `pnpm test` can diff what we generate against
the original.

| file                             | source                                                         | copied                |
| -------------------------------- | -------------------------------------------------------------- | --------------------- |
| `pistols/torii_mainnet.toml`     | `underware-gg/pistols` `dojo/torii_mainnet.toml` @ `05274e6`   | 2026-09-08            |
| `pistols/torii_sepolia.toml`     | `underware-gg/pistols` `dojo/torii_sepolia.toml` @ `05274e6`   | 2026-09-08            |

Refresh with `curl -fsSL https://raw.githubusercontent.com/underware-gg/pistols/main/dojo/torii_<net>.toml`
and update the commit above. `pending` in these files is `preconfirmed` in torii ≥ 1.8.
