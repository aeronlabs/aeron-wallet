import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { WalletConfig } from './config.js'

export type PaymentRecord = {
  readonly ts: string
  readonly url: string
  readonly amountUsd: number
  readonly payer: string
  readonly transaction: string | null
  readonly status: 'settled' | 'rejected' | 'failed'
  readonly reason?: string
}

export type History = {
  append(record: PaymentRecord): void
  recent(limit: number): readonly PaymentRecord[]
  /** Total settled USD since local midnight; input drives the daily cap. */
  spentTodayUsd(now?: Date): number
}

export function createHistory(cfg: WalletConfig): History {
  const filePath = join(cfg.AERON_WALLET_DIR, 'history.jsonl')

  function readAll(): PaymentRecord[] {
    if (!existsSync(filePath)) return []
    return readFileSync(filePath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as PaymentRecord
        } catch {
          return null
        }
      })
      .filter((r): r is PaymentRecord => r !== null)
  }

  return {
    append(record) {
      mkdirSync(cfg.AERON_WALLET_DIR, { recursive: true, mode: 0o700 })
      appendFileSync(filePath, `${JSON.stringify(record)}\n`)
    },
    recent(limit) {
      return readAll().slice(-limit).reverse()
    },
    spentTodayUsd(now = new Date()) {
      const midnight = new Date(now)
      midnight.setHours(0, 0, 0, 0)
      return readAll()
        .filter((r) => r.status === 'settled' && new Date(r.ts) >= midnight)
        .reduce((sum, r) => sum + r.amountUsd, 0)
    },
  }
}
