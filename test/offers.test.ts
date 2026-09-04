import { describe, expect, it } from 'vitest'
import { readOffers, selectOffer, type Offer } from '../src/offers.js'

const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168'
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const PAY_TO = '0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0'
const RAIL = { network: 'eip155:4663', asset: USDG }

const evm = (over: Record<string, unknown> = {}) => ({
  scheme: 'exact', network: 'eip155:4663', asset: USDG, payTo: PAY_TO, maxAmountRequired: '1000', ...over,
})

const encode = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64')

describe('readOffers', () => {
  it('reads offers stated in the body', () => {
    const body = JSON.stringify({ x402Version: 1, accepts: [evm()] })
    expect(readOffers(body)).toEqual([
      { network: 'eip155:4663', asset: USDG, payTo: PAY_TO, atomicAmount: '1000', x402Version: 1, raw: evm() },
    ])
  })

  it('reads offers stated only in the payment-required header', () => {
    const header = encode({ x402Version: 2, accepts: [evm({ maxAmountRequired: undefined, amount: '2000' })] })
    const offers = readOffers('{"altPayment":{"protocol":"proof-of-work"}}', header)
    expect(offers).toHaveLength(1)
    expect(offers[0]!.atomicAmount).toBe('2000')
  })

  it('accepts either name for the amount', () => {
    const body = JSON.stringify({ accepts: [evm({ maxAmountRequired: undefined, amount: '55' })] })
    expect(readOffers(body)[0]!.atomicAmount).toBe('55')
  })

  it('prefers maxAmountRequired when a server sends both', () => {
    const body = JSON.stringify({ accepts: [evm({ maxAmountRequired: '10', amount: '99' })] })
    expect(readOffers(body)[0]!.atomicAmount).toBe('10')
  })

  it('keeps the same offer once when it is stated in both places', () => {
    const body = JSON.stringify({ accepts: [evm()] })
    expect(readOffers(body, encode({ accepts: [evm()] }))).toHaveLength(1)
  })

  it('answers the newer statement when a server states one offer under both versions', () => {
    // A v2 server that keeps a v1 body around for old clients. Answering the
    // v1 copy makes it refuse a payment it advertised itself.
    const body = JSON.stringify({ x402Version: 1, accepts: [evm()] })
    const header = encode({ x402Version: 2, accepts: [evm({ maxAmountRequired: undefined, amount: '1000' })] })

    const offers = readOffers(body, header)
    expect(offers).toHaveLength(1)
    expect(offers[0]!.x402Version).toBe(2)
  })

  it('gathers offers from the body and the header together', () => {
    const body = JSON.stringify({ accepts: [evm({ network: 'eip155:8453', asset: USDC_BASE })] })
    const header = encode({ accepts: [evm()] })
    expect(readOffers(body, header).map((o) => o.network)).toEqual(['eip155:8453', 'eip155:4663'])
  })

  it.each([
    ['a scheme this wallet cannot sign', { scheme: 'upto' }],
    ['no amount at all', { maxAmountRequired: undefined }],
    ['an amount of zero', { maxAmountRequired: '0' }],
    ['an amount that is not a number', { maxAmountRequired: '1.5' }],
    ['a payee that is not an EVM address', { payTo: 'J7aN3PLJnTCF5qpEnvJHJsnCjcGuqC2rYtEM8Gv3xwg' }],
    ['an asset that is not an EVM token', { asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' }],
  ])('drops an offer with %s', (_label, over) => {
    expect(readOffers(JSON.stringify({ accepts: [evm(over)] }))).toEqual([])
  })

  it('keeps the payable offers from a list that also holds unpayable ones', () => {
    const body = JSON.stringify({
      accepts: [
        { scheme: 'exact', network: 'solana:5eykt4Us', asset: 'EPjFWdd5', payTo: 'J7aN3PLJ', amount: '1000' },
        evm(),
        { scheme: 'upto', network: 'eip155:8453', asset: USDC_BASE, payTo: PAY_TO, amount: '1000' },
      ],
    })
    expect(readOffers(body)).toHaveLength(1)
  })

  it.each([
    ['a body that is not JSON', 'not json at all'],
    ['a body with no offers', '{"altPayment":{"protocol":"proof-of-work"}}'],
    ['an empty accepts list', '{"accepts":[]}'],
  ])('returns nothing for %s', (_label, body) => {
    expect(readOffers(body)).toEqual([])
  })

  it('survives a header that is not valid base64 JSON', () => {
    expect(readOffers('{}', 'not-base64-json')).toEqual([])
  })

  it('carries the protocol version the offer was stated under', () => {
    const header = encode({ x402Version: 2, accepts: [evm({ maxAmountRequired: undefined, amount: '1000' })] })
    expect(readOffers('{}', header)[0]!.x402Version).toBe(2)
  })

  it('reads an envelope that names no version as version 1', () => {
    expect(readOffers(JSON.stringify({ accepts: [evm()] }))[0]!.x402Version).toBe(1)
  })

  it('keeps the offer exactly as written, for a server that will compare it', () => {
    const stated = evm({ extra: { name: 'Global Dollar', version: '1' }, maxTimeoutSeconds: 300 })
    expect(readOffers(JSON.stringify({ x402Version: 2, accepts: [stated] }))[0]!.raw).toEqual(stated)
  })
})

describe('selectOffer', () => {
  const offer = (over: Partial<Offer> = {}): Offer =>
    ({ network: 'eip155:4663', asset: USDG, payTo: PAY_TO, atomicAmount: '1000', x402Version: 1, raw: {}, ...over })

  it('finds the payable offer wherever it sits in the list', () => {
    const offers = [
      offer({ network: 'eip155:8453', asset: USDC_BASE }),
      offer({ network: 'eip155:137', asset: USDC_BASE }),
      offer(),
    ]
    const choice = selectOffer(offers, RAIL)
    expect(choice).toMatchObject({ ok: true, offer: { network: 'eip155:4663' } })
  })

  it('takes the cheapest of several payable offers', () => {
    const choice = selectOffer([offer({ atomicAmount: '5000' }), offer({ atomicAmount: '900' })], RAIL)
    expect(choice.ok && choice.offer.atomicAmount).toBe('900')
  })

  it('matches the token address whatever its case', () => {
    expect(selectOffer([offer({ asset: USDG.toUpperCase().replace('0X', '0x') })], RAIL).ok).toBe(true)
  })

  it('says which chains were offered when none is this one', () => {
    const offers = [offer({ network: 'eip155:8453', asset: USDC_BASE }), offer({ network: 'eip155:137', asset: USDC_BASE })]
    const choice = selectOffer(offers, RAIL)
    expect(choice.ok).toBe(false)
    expect(!choice.ok && choice.reason).toContain('eip155:8453')
  })

  it('says the chain was right and the token wrong, when that is what happened', () => {
    const choice = selectOffer([offer({ asset: USDC_BASE })], RAIL)
    expect(!choice.ok && choice.reason).toContain('no offer in USDG on eip155:4663')
  })

  it('reports an empty list as an unreadable offer', () => {
    expect(selectOffer([], RAIL)).toMatchObject({ ok: false, reason: 'unrecognized 402 offer' })
  })
})
