import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { loadConfig } from '../src/config.js'
import { loadOrCreateAccount } from '../src/keystore.js'
import { createHistory } from '../src/history.js'
import { payX402, type Eip712Domain } from '../src/payer.js'
import { bindSession, createSessions } from '../src/sessions.js'

const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168'
const PAY_TO = '0x1b8eBeb3f15Bd38c58D23a6ea0Ef26f2D7D480bd'

const domain: Eip712Domain = {
  name: 'Global Dollar',
  version: '1',
  chainId: 4663,
  verifyingContract: USDG as `0x${string}`,
}

function tempCfg(overrides: Record<string, string> = {}) {
  return loadConfig({
    AERON_WALLET_DIR: mkdtempSync(join(tmpdir(), 'aeron-session-pay-')),
    ...overrides,
  })
}

describe('paying under a session', () => {
  let server: FastifyInstance | null = null
  let hits = 0

  afterEach(async () => {
    if (server) await server.close()
    server = null
    hits = 0
  })

  /** A 402 endpoint that settles anything correctly shaped. */
  async function mockServer(amount = '4000'): Promise<string> {
    hits = 0
    server = Fastify()
    server.post('/paid', async (req, reply) => {
      hits += 1
      if (!req.headers['x-payment']) {
        return reply.code(402).send({
          x402Version: 1,
          accepts: [
            {
              scheme: 'exact',
              network: 'eip155:4663',
              maxAmountRequired: amount,
              payTo: PAY_TO,
              asset: USDG,
              maxTimeoutSeconds: 60,
            },
          ],
        })
      }
      reply.header(
        'x-payment-response',
        Buffer.from(JSON.stringify({ success: true, transaction: '0xsettled' })).toString('base64'),
      )
      return reply.code(200).send({ ok: true })
    })
    await server.listen({ port: 0, host: '127.0.0.1' })
    const address = server.server.address()
    if (typeof address === 'object' && address) return `http://127.0.0.1:${address.port}/paid`
    throw new Error('no server address')
  }

  function setup(hosts: string[], budgetUsd = 0.25, maxPerCallUsd = 0.01) {
    const cfg = tempCfg()
    const { account } = loadOrCreateAccount(cfg)
    const history = createHistory(cfg)
    const sessions = createSessions(cfg)
    const { session, token } = sessions.create({ hosts, budgetUsd, maxPerCallUsd, ttlSeconds: 3600 })
    return { cfg, account, history, sessions, session, binding: bindSession(sessions, token) }
  }

  const post = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }

  it('pays inside the scope and bills the session, not just the day', async () => {
    const url = await mockServer()
    const { cfg, account, history, sessions, session, binding } = setup(['127.0.0.1'])

    const result = await payX402(url, post, { cfg, account, history, domain, binding })

    expect(result.paid).toBe(true)
    expect(result.transaction).toBe('0xsettled')
    const stored = sessions.list().find((s) => s.id === session.id)
    expect(stored?.spentUsd).toBeCloseTo(0.004, 6)
    expect(history.spentTodayUsd()).toBeCloseTo(0.004, 6)
  })

  it('never contacts a host outside the scope', async () => {
    const url = await mockServer()
    const { cfg, account, history, binding } = setup(['inference.aeron.sh'])

    const result = await payX402(url, post, { cfg, account, history, domain, binding })

    expect(result.paid).toBe(false)
    expect(result.status).toBe(0)
    expect(result.reason).toContain('outside this session')
    expect(hits).toBe(0)
  })

  it('reads the offer but refuses to sign above the session per-call cap', async () => {
    const url = await mockServer('20000') // $0.02, over the $0.01 session cap
    const { cfg, account, history, sessions, session, binding } = setup(['127.0.0.1'])

    const result = await payX402(url, post, { cfg, account, history, domain, binding })

    expect(result.paid).toBe(false)
    expect(result.reason).toContain('per-call cap')
    expect(hits).toBe(1)
    expect(sessions.list().find((s) => s.id === session.id)?.spentUsd).toBe(0)
  })

  it('stops when the session budget runs out, while the wallet still has room', async () => {
    const url = await mockServer()
    const { cfg, account, history, sessions, session, binding } = setup(['127.0.0.1'], 0.006)

    const first = await payX402(url, post, { cfg, account, history, domain, binding })
    const second = await payX402(url, post, { cfg, account, history, domain, binding })

    expect(first.paid).toBe(true)
    expect(second.paid).toBe(false)
    expect(second.reason).toContain('budget')
    expect(sessions.list().find((s) => s.id === session.id)?.spentUsd).toBeCloseTo(0.004, 6)
  })

  it('a revoke lands on the very next call', async () => {
    const url = await mockServer()
    const { cfg, account, history, sessions, session, binding } = setup(['127.0.0.1'])

    expect((await payX402(url, post, { cfg, account, history, domain, binding })).paid).toBe(true)
    sessions.revoke(session.id)
    const after = await payX402(url, post, { cfg, account, history, domain, binding })

    expect(after.paid).toBe(false)
    expect(after.reason).toContain('no longer active')
  })
})
