import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { hashDomain, type Address, type Hex, type PublicClient } from 'viem'
import type { PrivateKeyAccount } from 'viem/accounts'
import type { WalletConfig } from './config.js'
import type { History } from './history.js'
import { checkSession, type SessionBinding } from './sessions.js'
import { describeOutcome } from './outcome.js'
export type { SessionBinding }

/** EIP-3009 typed data, mirrored from the facilitator side. */
const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const

const DOMAIN_ABI = [
  { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'DOMAIN_SEPARATOR', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
] as const

export type Eip712Domain = {
  readonly name: string
  readonly version: string
  readonly chainId: number
  readonly verifyingContract: Address
}

export function computeDomainSeparator(domain: Eip712Domain): Hex {
  return hashDomain({
    domain: { ...domain, chainId: BigInt(domain.chainId) },
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
    },
  })
}

export async function resolveDomain(publicClient: PublicClient, cfg: WalletConfig): Promise<Eip712Domain> {
  const address = cfg.USDG_ADDRESS as Address
  const [name, onchain] = await Promise.all([
    publicClient.readContract({ address, abi: DOMAIN_ABI, functionName: 'name' }),
    publicClient.readContract({ address, abi: DOMAIN_ABI, functionName: 'DOMAIN_SEPARATOR' }),
  ])
  for (const version of ['1', '2', '3']) {
    const domain: Eip712Domain = { name, version, chainId: cfg.CHAIN_ID, verifyingContract: address }
    if (computeDomainSeparator(domain).toLowerCase() === (onchain as string).toLowerCase()) return domain
  }
  throw new Error('could not match the token EIP-712 domain version')
}

const requirementsSchema = z.looseObject({
  scheme: z.literal('exact'),
  network: z.string(),
  maxAmountRequired: z.string().regex(/^\d+$/),
  payTo: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  asset: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  maxTimeoutSeconds: z.number().optional(),
})

const body402Schema = z.looseObject({
  x402Version: z.number(),
  accepts: z.array(requirementsSchema).min(1),
})

export type PayResult = {
  readonly paid: boolean
  readonly status: number
  readonly amountUsd: number
  readonly transaction: string | null
  readonly body: string
  readonly reason?: string
}

export type PayerDeps = {
  readonly cfg: WalletConfig
  readonly account: PrivateKeyAccount
  readonly history: History
  readonly domain: Eip712Domain
  readonly binding?: SessionBinding | null
  readonly fetchImpl?: typeof fetch
  readonly now?: () => number
}

/** Refused by the wallet before any request went out. */
const refused = (reason: string, amountUsd = 0): PayResult => ({
  paid: false,
  status: 0,
  amountUsd,
  transaction: null,
  body: '',
  reason,
})

/**
 * The x402 client flow: call, read the 402 offer, enforce budget caps, sign
 * an exact-amount EIP-3009 authorization, retry with X-PAYMENT.
 */
export async function payX402(url: string, init: RequestInit, deps: PayerDeps): Promise<PayResult> {
  const { cfg, account, history, domain } = deps
  const fetchImpl = deps.fetchImpl ?? fetch
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000))

  // Scope first: an out-of-scope host should never even be contacted.
  const binding = deps.binding ?? null
  if (binding) {
    const session = binding.current()
    if (!session) return refused('this session is no longer active')
    const preflight = checkSession(session, { url, amountUsd: 0, now: Date.now() })
    if (!preflight.ok) return refused(preflight.reason)
  }

  const first = await fetchImpl(url, init)
  const firstBody = await first.text()
  if (first.status !== 402) {
    return { paid: false, status: first.status, amountUsd: 0, transaction: null, body: firstBody }
  }

  const parsed = body402Schema.safeParse(JSON.parse(firstBody))
  if (!parsed.success) {
    return { paid: false, status: 402, amountUsd: 0, transaction: null, body: firstBody, reason: 'unrecognized 402 offer' }
  }
  const offer = parsed.data.accepts[0]!
  if (offer.network !== cfg.network) {
    return { paid: false, status: 402, amountUsd: 0, transaction: null, body: firstBody, reason: `network mismatch: ${offer.network}` }
  }
  if (offer.asset.toLowerCase() !== cfg.USDG_ADDRESS.toLowerCase()) {
    return { paid: false, status: 402, amountUsd: 0, transaction: null, body: firstBody, reason: 'offer asset is not USDG' }
  }

  const amountUsd = Number(offer.maxAmountRequired) / 1e6
  if (amountUsd > cfg.MAX_PER_CALL_USD) {
    return {
      paid: false, status: 402, amountUsd, transaction: null, body: firstBody,
      reason: `amount $${amountUsd} exceeds per-call cap $${cfg.MAX_PER_CALL_USD}`,
    }
  }
  if (binding) {
    const session = binding.current()
    if (!session) return refused('this session is no longer active', amountUsd)
    const outcome = checkSession(session, { url, amountUsd, now: Date.now() })
    if (!outcome.ok) {
      return { paid: false, status: 402, amountUsd, transaction: null, body: firstBody, reason: outcome.reason }
    }
  }
  const spent = history.spentTodayUsd()
  if (spent + amountUsd > cfg.DAILY_CAP_USD) {
    return {
      paid: false, status: 402, amountUsd, transaction: null, body: firstBody,
      reason: `daily cap reached ($${spent.toFixed(4)} of $${cfg.DAILY_CAP_USD})`,
    }
  }

  const t = now()
  const authorization = {
    from: account.address,
    to: offer.payTo as Address,
    value: BigInt(offer.maxAmountRequired),
    validAfter: BigInt(t - 60),
    validBefore: BigInt(t + (offer.maxTimeoutSeconds ?? 60) + 540),
    nonce: `0x${randomBytes(32).toString('hex')}` as Hex,
  }
  const signature = await account.signTypedData({
    domain,
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: 'TransferWithAuthorization',
    message: authorization,
  })
  const paymentHeader = Buffer.from(
    JSON.stringify({
      x402Version: 1,
      scheme: 'exact',
      network: cfg.network,
      payload: {
        signature,
        authorization: {
          from: authorization.from,
          to: authorization.to,
          value: String(authorization.value),
          validAfter: String(authorization.validAfter),
          validBefore: String(authorization.validBefore),
          nonce: authorization.nonce,
        },
      },
    }),
  ).toString('base64')

  const second = await fetchImpl(url, {
    ...init,
    headers: { ...(init.headers as Record<string, string> | undefined), 'x-payment': paymentHeader },
  })
  const secondBody = await second.text()

  let transaction: string | null = null
  const receiptHeader = second.headers.get('x-payment-response')
  if (receiptHeader) {
    try {
      const receipt = JSON.parse(Buffer.from(receiptHeader, 'base64').toString('utf8'))
      if (typeof receipt.transaction === 'string') transaction = receipt.transaction
    } catch {
      /* receipt header is informational */
    }
  }

  // Whether money moved is the settlement receipt's business, not the status
  // code's: a service can refuse to charge and still answer 4xx.
  const outcome = describeOutcome(second.status, transaction, secondBody)
  if (outcome.charged && binding) binding.recordSpend(amountUsd)
  history.append({
    ts: new Date().toISOString(),
    url,
    amountUsd,
    payer: account.address,
    transaction,
    status: outcome.status,
    ...(outcome.reason ? { reason: outcome.reason } : {}),
  })
  return {
    paid: outcome.ok, status: second.status, amountUsd, transaction, body: secondBody,
    ...(outcome.reason ? { reason: outcome.reason } : {}),
  }
}
