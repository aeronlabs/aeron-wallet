import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import type { PrivateKeyAccount } from 'viem/accounts'
import type { PublicClient } from 'viem'
import type { WalletConfig } from './config.js'
import type { History } from './history.js'
import { readBalances } from './balances.js'
import { payX402, type Eip712Domain } from './payer.js'
import { parseTtlSeconds, type SessionBinding, type SessionStore } from './sessions.js'

export type McpDeps = {
  readonly cfg: WalletConfig
  readonly account: PrivateKeyAccount
  readonly history: History
  readonly publicClient: PublicClient
  readonly domain: () => Promise<Eip712Domain>
  readonly sessions: SessionStore
  /** Set when this server is bound to one session; null when it is not. */
  readonly binding?: SessionBinding | null
}

export async function startMcpServer(deps: McpDeps): Promise<void> {
  const { cfg, account, history, publicClient, sessions } = deps
  const binding = deps.binding ?? null
  const server = new McpServer({ name: 'aeron-wallet', version: '0.1.0' })

  server.tool(
    'get_address',
    'The wallet address on Robinhood Chain. Fund it with USDG to pay for services.',
    {},
    async () => ({
      content: [{ type: 'text', text: JSON.stringify({ address: account.address, network: cfg.network }) }],
    }),
  )

  server.tool(
    'get_balance',
    'ETH and USDG balances of this wallet.',
    {},
    async () => {
      const balances = await readBalances(publicClient, cfg, account.address)
      return { content: [{ type: 'text', text: JSON.stringify({ address: account.address, ...balances }) }] }
    },
  )

  server.tool(
    'pay',
    binding
      ? 'Call a machine-payable (x402) endpoint and pay in USDG if it answers 402. This server is bound to a session: calls outside its hosts, per-call cap, budget, or expiry are refused.'
      : 'Call a machine-payable (x402) endpoint and pay in USDG if it answers 402. Budget caps apply.',
    {
      url: z.string().url(),
      method: z.enum(['GET', 'POST']).default('POST'),
      body: z.string().optional().describe('JSON body to send'),
    },
    async ({ url, method, body }) => {
      const domain = await deps.domain()
      const result = await payX402(
        url,
        {
          method,
          headers: { 'content-type': 'application/json' },
          ...(body ? { body } : {}),
        },
        { cfg, account, history, domain, binding },
      )
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    },
  )

  server.tool(
    'history',
    'Recent payments made by this wallet.',
    { limit: z.number().int().min(1).max(50).default(10) },
    async ({ limit }) => ({
      content: [{ type: 'text', text: JSON.stringify(history.recent(limit)) }],
    }),
  )

  if (!binding) registerSessionTools(server, sessions, cfg)

  await server.connect(new StdioServerTransport())
}

/**
 * Only an unbound server gets these. Handing them to a bound agent would let
 * it write itself a wider scope, which is the whole thing a session prevents.
 */
function registerSessionTools(server: McpServer, sessions: SessionStore, cfg: WalletConfig): void {
  server.tool(
    'create_session',
    'Create a scoped session: allowed hosts, a total budget, a per-call cap, and an expiry. Returns a token that binds an agent to that scope.',
    {
      hosts: z.array(z.string().min(1)).min(1).describe('hostnames this session may pay, e.g. inference.aeron.sh'),
      budgetUsd: z.number().positive().describe('total USD this session may spend'),
      ttl: z.string().describe('lifetime, e.g. 90, 30m, 2h, 1d'),
      maxPerCallUsd: z.number().positive().optional(),
    },
    async ({ hosts, budgetUsd, ttl, maxPerCallUsd }) => {
      const { session, token } = sessions.create({
        hosts,
        budgetUsd,
        maxPerCallUsd: maxPerCallUsd ?? Math.min(cfg.MAX_PER_CALL_USD, budgetUsd),
        ttlSeconds: parseTtlSeconds(ttl),
      })
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              id: session.id,
              token,
              hosts: session.hosts,
              budgetUsd: session.budgetUsd,
              maxPerCallUsd: session.maxPerCallUsd,
              expiresAt: session.expiresAt,
              bind: `AERON_WALLET_SESSION=${token} aeron-wallet mcp`,
            }),
          },
        ],
      }
    },
  )

  server.tool('list_sessions', 'Every session, with what it has spent and whether it is still live.', {}, async () => ({
    content: [{ type: 'text', text: JSON.stringify(sessions.list()) }],
  }))

  server.tool(
    'revoke_session',
    'Revoke a session by id. It stops paying on its next call.',
    { id: z.string().min(1) },
    async ({ id }) => ({
      content: [{ type: 'text', text: JSON.stringify({ id, revoked: sessions.revoke(id) }) }],
    }),
  )
}
