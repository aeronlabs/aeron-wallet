import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { recoverTypedDataAddress } from 'viem'
import { loadConfig } from '../src/config.js'
import { loadOrCreateAccount } from '../src/keystore.js'
import { createHistory } from '../src/history.js'
import { computeDomainSeparator, payX402, type Eip712Domain } from '../src/payer.js'

const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168'
const PAY_TO = '0x1b8eBeb3f15Bd38c58D23a6ea0Ef26f2D7D480bd'

function tempCfg(overrides: Record<string, string> = {}) {
  return loadConfig({
    AERON_WALLET_DIR: mkdtempSync(join(tmpdir(), 'aeron-wallet-')),
    ...overrides,
  })
}

const domain: Eip712Domain = {
  name: 'Global Dollar',
  version: '1',
  chainId: 4663,
  verifyingContract: USDG as `0x${string}`,
}

describe('keystore', () => {
  it('creates a new 0600 key, then reloads the same key', () => {
    const cfg = tempCfg()
    const first = loadOrCreateAccount(cfg)
    expect(first.created).toBe(true)
    const mode = statSync(join(cfg.AERON_WALLET_DIR, 'key')).mode & 0o777
    expect(mode).toBe(0o600)
    const second = loadOrCreateAccount(cfg)
    expect(second.created).toBe(false)
    expect(second.account.address).toBe(first.account.address)
    expect(readFileSync(join(cfg.AERON_WALLET_DIR, 'key'), 'utf8')).toMatch(/^0x[0-9a-f]{64}\n$/)
  })

  it('an env key override is used without writing a file', () => {
    const key = `0x${'ab'.repeat(32)}`
    const cfg = tempCfg({ AERON_WALLET_KEY: key })
    const { account, created } = loadOrCreateAccount(cfg)
    expect(created).toBe(false)
    expect(account.address).toMatch(/^0x/)
  })
})

describe('history', () => {
  it('append + recent + spentTodayUsd count only settled payments from today', () => {
    const cfg = tempCfg()
    const history = createHistory(cfg)
    const today = new Date().toISOString()
    history.append({ ts: today, url: 'u1', amountUsd: 0.02, payer: '0x1', transaction: '0xt', status: 'settled' })
    history.append({ ts: today, url: 'u2', amountUsd: 0.03, payer: '0x1', transaction: null, status: 'rejected' })
    history.append({ ts: '2000-01-01T00:00:00Z', url: 'u3', amountUsd: 9, payer: '0x1', transaction: '0xt', status: 'settled' })
    expect(history.recent(10)).toHaveLength(3)
    expect(history.recent(1)[0]?.url).toBe('u3')
    expect(history.spentTodayUsd()).toBeCloseTo(0.02, 6)
  })
})

describe('payX402', () => {
  let server: FastifyInstance | null = null
  afterEach(async () => {
    if (server) await server.close()
    server = null
  })

  async function mock402Server(opts: { amount?: string; settleStatus?: number } = {}): Promise<string> {
    const amount = opts.amount ?? '4000'
    server = Fastify()
    server.post('/paid', async (req, reply) => {
      const payment = req.headers['x-payment']
      if (!payment) {
        return reply.code(402).send({
          x402Version: 1,
          error: 'X-PAYMENT header is required',
          accepts: [{
            scheme: 'exact', network: 'eip155:4663', maxAmountRequired: amount,
            resource: 'http://x/paid', description: 'test', mimeType: 'application/json',
            payTo: PAY_TO, maxTimeoutSeconds: 60, asset: USDG, extra: { name: 'USDG', decimals: 6 },
          }],
        })
      }
      const decoded = JSON.parse(Buffer.from(String(payment), 'base64').toString('utf8'))
      const auth = decoded.payload.authorization
      const signer = await recoverTypedDataAddress({
        domain,
        types: {
          TransferWithAuthorization: [
            { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
            { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' },
            { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
          ],
        },
        primaryType: 'TransferWithAuthorization',
        message: {
          from: auth.from, to: auth.to, value: BigInt(auth.value),
          validAfter: BigInt(auth.validAfter), validBefore: BigInt(auth.validBefore), nonce: auth.nonce,
        },
        signature: decoded.payload.signature,
      })
      if (signer.toLowerCase() !== auth.from.toLowerCase()) {
        return reply.code(402).send({ error: 'bad signature' })
      }
      reply.header('x-payment-response', Buffer.from(JSON.stringify({ success: true, transaction: '0xsettled' })).toString('base64'))
      return reply.code(opts.settleStatus ?? 200).send({ ok: true, paidBy: signer })
    })
    await server.listen({ port: 0, host: '127.0.0.1' })
    const address = server.server.address()
    if (typeof address === 'object' && address) return `http://127.0.0.1:${address.port}/paid`
    throw new Error('no server address')
  }

  it('full flow: 402 -> sign -> retry -> settled, and written to history', async () => {
    const cfg = tempCfg()
    const { account } = loadOrCreateAccount(cfg)
    const history = createHistory(cfg)
    const url = await mock402Server()
    const result = await payX402(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }, {
      cfg, account, history, domain,
    })
    expect(result.paid).toBe(true)
    expect(result.amountUsd).toBeCloseTo(0.004, 6)
    expect(result.transaction).toBe('0xsettled')
    expect(JSON.parse(result.body).paidBy.toLowerCase()).toBe(account.address.toLowerCase())
    expect(history.recent(1)[0]?.status).toBe('settled')
  })

  it('the per-call cap rejects before signing', async () => {
    const cfg = tempCfg({ MAX_PER_CALL_USD: '0.001' })
    const { account } = loadOrCreateAccount(cfg)
    const history = createHistory(cfg)
    const url = await mock402Server({ amount: '4000' })
    const result = await payX402(url, { method: 'POST' }, { cfg, account, history, domain })
    expect(result.paid).toBe(false)
    expect(result.reason).toContain('per-call cap')
    expect(history.recent(10)).toHaveLength(0)
  })

  it('the daily cap rejects based on history', async () => {
    const cfg = tempCfg({ DAILY_CAP_USD: '0.005' })
    const { account } = loadOrCreateAccount(cfg)
    const history = createHistory(cfg)
    history.append({
      ts: new Date().toISOString(), url: 'u', amountUsd: 0.004, payer: account.address,
      transaction: '0xt', status: 'settled',
    })
    const url = await mock402Server({ amount: '4000' })
    const result = await payX402(url, { method: 'POST' }, { cfg, account, history, domain })
    expect(result.paid).toBe(false)
    expect(result.reason).toContain('daily cap')
  })

  it('a non-USDG asset is rejected', async () => {
    const cfg = tempCfg()
    const { account } = loadOrCreateAccount(cfg)
    const history = createHistory(cfg)
    server = Fastify()
    server.post('/paid', async (_req, reply) =>
      reply.code(402).send({
        x402Version: 1,
        accepts: [{
          scheme: 'exact', network: 'eip155:4663', maxAmountRequired: '1000',
          payTo: PAY_TO, asset: `0x${'99'.repeat(20)}`,
        }],
      }),
    )
    await server.listen({ port: 0, host: '127.0.0.1' })
    const address = server.server.address()
    const url = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}/paid` : ''
    const result = await payX402(url, { method: 'POST' }, { cfg, account, history, domain })
    expect(result.paid).toBe(false)
    // The refusal names the token that was offered instead, so a buyer can see
    // whether the merchant wants another chain or another token.
    expect(result.reason).toContain('no offer in USDG on eip155:4663')
  })

  it('pays an offer that is not the first one listed', async () => {
    const cfg = tempCfg()
    const { account } = loadOrCreateAccount(cfg)
    const history = createHistory(cfg)
    server = Fastify()
    server.post('/paid', async (req, reply) => {
      if (!req.headers['x-payment']) {
        // How merchants out in the open actually answer: many chains, and
        // this rail's is somewhere down the list.
        return reply.code(402).send({
          x402Version: 1,
          accepts: [
            { scheme: 'exact', network: 'eip155:8453', amount: '1000', payTo: PAY_TO, asset: `0x${'11'.repeat(20)}` },
            { scheme: 'exact', network: 'eip155:137', amount: '1000', payTo: PAY_TO, asset: `0x${'22'.repeat(20)}` },
            { scheme: 'exact', network: 'eip155:4663', amount: '1000', payTo: PAY_TO, asset: USDG },
          ],
        })
      }
      return reply.send({ ok: true })
    })
    await server.listen({ port: 0, host: '127.0.0.1' })
    const address = server.server.address()
    const url = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}/paid` : ''

    const result = await payX402(url, { method: 'POST' }, { cfg, account, history, domain })
    expect(result.paid).toBe(true)
    expect(result.amountUsd).toBe(0.001)
  })

  it('pays a v2 server, which reads the payment from payment-signature', async () => {
    const cfg = tempCfg()
    const { account } = loadOrCreateAccount(cfg)
    const history = createHistory(cfg)
    server = Fastify()
    server.post('/paid', async (req, reply) => {
      // A v2 server does not look at X-PAYMENT at all.
      if (!req.headers['payment-signature']) {
        const offers = {
          x402Version: 2,
          accepts: [{ scheme: 'exact', network: 'eip155:4663', amount: '1000', payTo: PAY_TO, asset: USDG }],
        }
        return reply
          .code(402)
          .header('payment-required', Buffer.from(JSON.stringify(offers), 'utf8').toString('base64'))
          .send({ altPayment: { protocol: 'proof-of-work' } })
      }
      const payload = JSON.parse(Buffer.from(String(req.headers['payment-signature']), 'base64').toString('utf8'))
      if (payload.x402Version !== 2) return reply.code(402).send({ reason: 'version-mismatch' })
      return reply.send({ ok: true })
    })
    await server.listen({ port: 0, host: '127.0.0.1' })
    const address = server.server.address()
    const url = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}/paid` : ''

    const result = await payX402(url, { method: 'POST' }, { cfg, account, history, domain })
    expect(result.paid).toBe(true)
  })

  it('still pays a v1 server on X-PAYMENT', async () => {
    const cfg = tempCfg()
    const { account } = loadOrCreateAccount(cfg)
    const history = createHistory(cfg)
    server = Fastify()
    server.post('/paid', async (req, reply) => {
      if (!req.headers['x-payment']) {
        return reply.code(402).send({
          x402Version: 1,
          accepts: [{ scheme: 'exact', network: 'eip155:4663', maxAmountRequired: '1000', payTo: PAY_TO, asset: USDG }],
        })
      }
      const payload = JSON.parse(Buffer.from(String(req.headers['x-payment']), 'base64').toString('utf8'))
      if (payload.x402Version !== 1 || payload.scheme !== 'exact') return reply.code(402).send({ reason: 'bad-shape' })
      return reply.send({ ok: true })
    })
    await server.listen({ port: 0, host: '127.0.0.1' })
    const address = server.server.address()
    const url = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}/paid` : ''

    const result = await payX402(url, { method: 'POST' }, { cfg, account, history, domain })
    expect(result.paid).toBe(true)
  })

  it('pays an offer stated only in the payment-required header', async () => {
    const cfg = tempCfg()
    const { account } = loadOrCreateAccount(cfg)
    const history = createHistory(cfg)
    server = Fastify()
    server.post('/paid', async (req, reply) => {
      if (!req.headers['payment-signature']) {
        const offers = {
          x402Version: 2,
          accepts: [
            { scheme: 'exact', network: 'eip155:8453', amount: '1000', payTo: PAY_TO, asset: `0x${'11'.repeat(20)}` },
            { scheme: 'exact', network: 'eip155:4663', amount: '1000', payTo: PAY_TO, asset: USDG },
          ],
        }
        return reply
          .code(402)
          .header('payment-required', Buffer.from(JSON.stringify(offers), 'utf8').toString('base64'))
          .send({ altPayment: { protocol: 'proof-of-work' } })
      }
      return reply.send({ ok: true })
    })
    await server.listen({ port: 0, host: '127.0.0.1' })
    const address = server.server.address()
    const url = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}/paid` : ''

    const result = await payX402(url, { method: 'POST' }, { cfg, account, history, domain })
    expect(result.paid).toBe(true)
    expect(result.amountUsd).toBe(0.001)
  })

  it('a non-402 response passes through without paying', async () => {
    const cfg = tempCfg()
    const { account } = loadOrCreateAccount(cfg)
    const history = createHistory(cfg)
    server = Fastify()
    server.post('/free', async () => ({ free: true }))
    await server.listen({ port: 0, host: '127.0.0.1' })
    const address = server.server.address()
    const url = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}/free` : ''
    const result = await payX402(url, { method: 'POST' }, { cfg, account, history, domain })
    expect(result.paid).toBe(false)
    expect(result.status).toBe(200)
    expect(result.reason).toBeUndefined()
  })
})

describe('balances & domain resolve (mocked chain)', () => {
  it('readBalances formats ETH and USDG', async () => {
    const { readBalances } = await import('../src/balances.js')
    const cfg = tempCfg()
    const client = {
      async getBalance() { return 1_500_000_000_000_000n },
      async readContract() { return 2_500_000n },
    } as never
    const out = await readBalances(client, cfg, `0x${'11'.repeat(20)}`)
    expect(out.eth).toBe('0.0015')
    expect(out.usdg).toBe('2.500000')
  })

  it('resolveDomain finds the matching version', async () => {
    const { resolveDomain } = await import('../src/payer.js')
    const cfg = tempCfg()
    const client = {
      async readContract({ functionName }: { functionName: string }) {
        if (functionName === 'name') return 'Global Dollar'
        if (functionName === 'DOMAIN_SEPARATOR') return computeDomainSeparator(domain)
        throw new Error('unexpected')
      },
    } as never
    expect(await resolveDomain(client, cfg)).toEqual(domain)
  })

  it('resolveDomain fails when the separator does not match', async () => {
    const { resolveDomain } = await import('../src/payer.js')
    const cfg = tempCfg()
    const client = {
      async readContract({ functionName }: { functionName: string }) {
        if (functionName === 'name') return 'Global Dollar'
        return `0x${'ff'.repeat(32)}`
      },
    } as never
    await expect(resolveDomain(client, cfg)).rejects.toThrow('domain version')
  })
})

describe('domain separator', () => {
  it('is deterministic for the domain contents', () => {
    const a = computeDomainSeparator(domain)
    const b = computeDomainSeparator({ ...domain, version: '2' })
    expect(a).toMatch(/^0x[0-9a-f]{64}$/)
    expect(a).not.toBe(b)
  })
})
