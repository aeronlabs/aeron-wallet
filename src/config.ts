import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

const envSchema = z.object({
  RPC_URL: z.string().url().default('https://rpc.mainnet.chain.robinhood.com'),
  CHAIN_ID: z.coerce.number().int().positive().default(4663),
  USDG_ADDRESS: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .default('0x5fc5360d0400a0fd4f2af552add042d716f1d168'),
  /** Override the stored key (hot wallets only; small balances). */
  AERON_WALLET_KEY: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .optional()
    .or(z.literal('').transform(() => undefined)),
  AERON_WALLET_DIR: z.string().default(join(homedir(), '.aeron', 'wallet')),
  /** Budget caps, USD. The wallet refuses to sign above these. */
  MAX_PER_CALL_USD: z.coerce.number().positive().default(0.05),
  DAILY_CAP_USD: z.coerce.number().positive().default(1),
})

export type WalletConfig = z.infer<typeof envSchema> & { readonly network: string }

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WalletConfig {
  const parsed = envSchema.safeParse(env)
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new Error(`Invalid configuration: ${detail}`)
  }
  return { ...parsed.data, network: `eip155:${parsed.data.CHAIN_ID}` }
}
