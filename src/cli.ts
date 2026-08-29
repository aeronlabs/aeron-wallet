#!/usr/bin/env node
import { loadConfig } from './config.js'
import { loadOrCreateAccount } from './keystore.js'
import { createHistory } from './history.js'
import { createChainClient, readBalances } from './balances.js'
import { payX402, resolveDomain, type Eip712Domain } from './payer.js'
import { startMcpServer } from './mcp.js'
import { bindSession, createSessions } from './sessions.js'
import { runSessionCommand } from './cli-sessions.js'

const out = (line: string) => process.stdout.write(`${line}\n`)

async function main(): Promise<void> {
  const cfg = loadConfig()
  const { account, created } = loadOrCreateAccount(cfg)
  const history = createHistory(cfg)
  const sessions = createSessions(cfg)
  const publicClient = createChainClient(cfg)
  let cachedDomain: Eip712Domain | null = null
  const domain = async () => {
    if (!cachedDomain) cachedDomain = await resolveDomain(publicClient, cfg)
    return cachedDomain
  }

  const [command = 'mcp', ...argv] = process.argv.slice(2)
  // A `--session <token>` flag scopes one call; AERON_WALLET_SESSION scopes
  // the whole process, which is how you hand a sub-agent a bounded server.
  const flagAt = argv.indexOf('--session')
  const inlineToken = flagAt === -1 ? undefined : argv[flagAt + 1]
  if (flagAt !== -1 && !inlineToken) throw new Error('--session needs a token')
  const rest = flagAt === -1 ? argv : [...argv.slice(0, flagAt), ...argv.slice(flagAt + 2)]
  const token = inlineToken ?? cfg.AERON_WALLET_SESSION
  const binding = token ? bindSession(sessions, token) : null
  if (binding && !binding.current()) {
    throw new Error('that session token is unknown, revoked, or already gone')
  }
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
        { cfg, account, history, domain: await domain(), binding },
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
    case 'session': {
      runSessionCommand(rest, { sessions, cfg, out })
      return
    }
    case 'mcp': {
      await startMcpServer({ cfg, account, history, publicClient, domain, sessions, binding })
      return
    }
    default:
      throw new Error(`unknown command: ${command} (use address|balance|pay|history|session|mcp)`)
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
