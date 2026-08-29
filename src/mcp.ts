import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import type { PrivateKeyAccount } from 'viem/accounts'
import type { PublicClient } from 'viem'
import type { WalletConfig } from './config.js'
import type { History } from './history.js'
import { readBalances } from './balances.js'
import { payX402, type Eip712Domain } from './payer.js'

export type McpDeps = {
  readonly cfg: WalletConfig
  readonly account: PrivateKeyAccount
  readonly history: History
  readonly publicClient: PublicClient
  readonly domain: () => Promise<Eip712Domain>
}

export async function startMcpServer(deps: McpDeps): Promise<void> {
  const { cfg, account, history, publicClient } = deps
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
    'Call a machine-payable (x402) endpoint and pay in USDG if it answers 402. Budget caps apply.',
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
        { cfg, account, history, domain },
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

  await server.connect(new StdioServerTransport())
}
