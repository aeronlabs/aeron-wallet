#!/usr/bin/env node
import { loadConfig } from './config.js'
import { loadOrCreateAccount } from './keystore.js'
import { createHistory } from './history.js'
import { createChainClient, readBalances } from './balances.js'
import { payX402, resolveDomain, type Eip712Domain } from './payer.js'
import { startMcpServer } from './mcp.js'

const out = (line: string) => process.stdout.write(`${line}\n`)

async function main(): Promise<void> {
  const cfg = loadConfig()
  const { account, created } = loadOrCreateAccount(cfg)
  const history = createHistory(cfg)
  const publicClient = createChainClient(cfg)
  let cachedDomain: Eip712Domain | null = null
  const domain = async () => {
    if (!cachedDomain) cachedDomain = await resolveDomain(publicClient, cfg)
    return cachedDomain
  }

  const [command = 'mcp', ...rest] = process.argv.slice(2)
  if (created && command !== 'mcp') {
    out(`new wallet created at ${cfg.AERON_WALLET_DIR} (hot wallet; keep balances small)`)
  }

  switch (command) {
    case 'address': {
      out(account.address)
      return
    }
    case 'balance': {
      const balances = await readBalances(publicClient, cfg, account.address)
      out(`address ${account.address}`)
      out(`eth    ${balances.eth}`)
      out(`usdg   ${balances.usdg}`)
      return
    }
    case 'pay': {
      const url = rest[0]
      if (!url) throw new Error('usage: pay <url> [json-body]')
      const body = rest[1]
      const result = await payX402(
        url,
        { method: 'POST', headers: { 'content-type': 'application/json' }, ...(body ? { body } : {}) },
        { cfg, account, history, domain: await domain() },
      )
      out(JSON.stringify(result, null, 2))
      if (!result.paid && result.reason) process.exitCode = 1
      return
    }
    case 'history': {
      for (const r of history.recent(10)) {
        out(`${r.ts} $${r.amountUsd} ${r.status} ${r.transaction ?? ''} ${r.url}`)
      }
      return
    }
    case 'mcp': {
      await startMcpServer({ cfg, account, history, publicClient, domain })
      return
    }
    default:
      throw new Error(`unknown command: ${command} (use address|balance|pay|history|mcp)`)
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
