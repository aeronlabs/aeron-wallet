import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import type { WalletConfig } from './config.js'

/**
 * Load or create the wallet key. Stored at <dir>/key with 0600 perms.
 * This is a hot wallet for small, metered spending; not for savings.
 */
export function loadOrCreateAccount(cfg: WalletConfig): { account: PrivateKeyAccount; created: boolean } {
  if (cfg.AERON_WALLET_KEY) {
    return { account: privateKeyToAccount(cfg.AERON_WALLET_KEY as `0x${string}`), created: false }
  }
  const keyPath = join(cfg.AERON_WALLET_DIR, 'key')
  if (existsSync(keyPath)) {
    const key = readFileSync(keyPath, 'utf8').trim()
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error(`corrupt key file at ${keyPath}`)
    return { account: privateKeyToAccount(key as `0x${string}`), created: false }
  }
  mkdirSync(cfg.AERON_WALLET_DIR, { recursive: true, mode: 0o700 })
  const key = generatePrivateKey()
  writeFileSync(keyPath, `${key}\n`, { mode: 0o600 })
  chmodSync(keyPath, 0o600)
  return { account: privateKeyToAccount(key), created: true }
}
