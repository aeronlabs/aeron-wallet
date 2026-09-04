import { describe, expect, it } from 'vitest'
import { buildPaymentHeader, paymentAttempts } from '../src/payment-header.js'
import type { Offer } from '../src/offers.js'

const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168'
const PAY_TO = '0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0'

const offer = (over: Partial<Offer> = {}): Offer => ({
  network: 'eip155:4663',
  asset: USDG,
  payTo: PAY_TO,
  atomicAmount: '1000',
  x402Version: 1,
  raw: {},
  ...over,
})

const signed = {
  signature: '0xdeadbeef',
  authorization: {
    from: '0xe633ACf5073D54e17cE6B0543054c7e5b5c74946',
    to: PAY_TO,
    value: '1000',
    validAfter: '0',
    validBefore: '1788510418',
    nonce: `0x${'ab'.repeat(32)}`,
  },
}

const decode = (value: string) => JSON.parse(Buffer.from(value, 'base64').toString('utf8'))

describe('buildPaymentHeader', () => {
  describe('v1', () => {
    const header = buildPaymentHeader(offer(), signed)

    it('goes out as X-PAYMENT', () => {
      expect(header.name).toBe('x-payment')
    })

    it('names the scheme and network, which v1 reads from the top level', () => {
      expect(decode(header.value)).toEqual({
        x402Version: 1,
        scheme: 'exact',
        network: 'eip155:4663',
        payload: signed,
      })
    })
  })

  describe('v2', () => {
    const header = buildPaymentHeader(offer({ x402Version: 2 }), signed)

    it('goes out as payment-signature, which is where a v2 server looks', () => {
      expect(header.name).toBe('payment-signature')
    })

    it('names the offer inside `accepted` rather than at the top level', () => {
      const chosen = { scheme: 'exact', network: 'eip155:4663', amount: '1000', asset: USDG, payTo: PAY_TO }
      const payload = decode(buildPaymentHeader(offer({ x402Version: 2, raw: chosen }), signed).value)

      expect(payload).toEqual({ x402Version: 2, accepted: chosen, payload: signed })
      expect(payload).not.toHaveProperty('scheme')
      expect(payload).not.toHaveProperty('network')
    })

    it('sends the offer back exactly as written, not rebuilt from parsed fields', () => {
      const chosen = { scheme: 'exact', network: 'eip155:4663', amount: '1000', asset: USDG, payTo: PAY_TO, extra: { name: 'Global Dollar', version: '1' } }
      const payload = decode(buildPaymentHeader(offer({ x402Version: 2, raw: chosen }), signed).value)
      expect(payload.accepted).toEqual(chosen)
    })

    it('echoes the extensions the server sent with the offer', () => {
      const extensions = { bazaar: { info: { input: { method: 'POST' } } } }
      const payload = decode(buildPaymentHeader(offer({ x402Version: 2, extensions }), signed).value)
      expect(payload.extensions).toEqual(extensions)
    })

    it('leaves extensions out when the server sent none', () => {
      expect(decode(header.value)).not.toHaveProperty('extensions')
    })

    it('treats anything past v2 as v2 rather than falling back to v1', () => {
      expect(buildPaymentHeader(offer({ x402Version: 3 }), signed).name).toBe('payment-signature')
    })
  })
})

describe('paymentAttempts', () => {
  it('leads with v2 for a v2 offer, and keeps v1 as a fallback', () => {
    expect(paymentAttempts(offer({ x402Version: 2 }), signed).map((a) => a.name)).toEqual([
      'payment-signature',
      'x-payment',
    ])
  })

  it('leads with v1 for a v1 offer, and keeps v2 as a fallback', () => {
    expect(paymentAttempts(offer(), signed).map((a) => a.name)).toEqual(['x-payment', 'payment-signature'])
  })

  it('never announces v1 in the v2 form, whatever the offer said', () => {
    const [, fallback] = paymentAttempts(offer({ x402Version: 1 }), signed)
    expect(decode(fallback!.value).x402Version).toBe(2)
  })

  it('signs both forms with the same authorization, so only one can ever settle', () => {
    const nonces = paymentAttempts(offer({ x402Version: 2 }), signed)
      .map((a) => decode(a.value).payload.authorization.nonce)
    expect(new Set(nonces).size).toBe(1)
  })
})
