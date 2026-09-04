import { z } from 'zod'

/**
 * Reading what a 402 is actually offering.
 *
 * This was one line for a long time — `accepts[0]` from the response body —
 * and that line only ever worked against servers written the same way this
 * wallet was. Out in the open, a merchant lists a dozen offers across a dozen
 * chains, in whichever order suits it, and the one this wallet can pay is
 * rarely the first. Taking the first offer is not a simplification of the
 * protocol; it is a different protocol.
 *
 * Three shapes have to be read as one:
 *
 * - the offers live in the JSON body, or in a base64 `payment-required`
 *   header, or both;
 * - the amount is called `maxAmountRequired` by some servers and `amount` by
 *   others;
 * - the list mixes chains and address formats this wallet has no key for.
 *
 * So: gather every offer from wherever it is stated, keep the ones this rail
 * can actually settle, and take the cheapest of those.
 */

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const ATOMIC = /^\d+$/

/** One payable offer, normalised across the shapes servers state it in. */
export type Offer = {
  readonly network: string
  readonly asset: string
  readonly payTo: string
  /** Smallest unit of the asset, as a decimal string. */
  readonly atomicAmount: string
  readonly maxTimeoutSeconds?: number
  /**
   * The protocol version the offer was stated under. Carried because the
   * X-PAYMENT sent back has to declare the same one: a v2 resource refuses a
   * payment that announces itself as v1, and says so instead of charging.
   */
  readonly x402Version: number
  /**
   * The offer exactly as the server wrote it.
   *
   * v2 matches the requirements a payment echoes back against the ones the
   * route advertised, so the entry has to go back byte for byte — a rebuilt
   * copy of it matches nothing. Kept opaque on purpose: nothing here should
   * be tempted to normalise a field the server will compare.
   */
  readonly raw: unknown
  /**
   * Whatever the server attached to the offer envelope. v2 payments echo it
   * back, so it is carried rather than dropped on the way through.
   */
  readonly extensions?: unknown
}

const offerSchema = z.looseObject({
  scheme: z.string(),
  network: z.string(),
  asset: z.string(),
  payTo: z.string(),
  maxAmountRequired: z.string().optional(),
  amount: z.string().optional(),
  maxTimeoutSeconds: z.number().optional(),
})

const envelopeSchema = z.looseObject({
  x402Version: z.number().optional(),
  accepts: z.array(z.unknown()).min(1),
  extensions: z.unknown().optional(),
})

/** What a 402 envelope says, before any of it has been believed. */
type Envelope = {
  readonly accepts: readonly unknown[]
  readonly version: number
  readonly extensions?: unknown
}

/**
 * An offer this wallet could sign for, or null.
 *
 * Non-EVM offers are dropped here rather than treated as errors: a Solana or
 * Stellar payee in the list is a normal thing for a merchant to publish, and
 * nothing for an EVM wallet to complain about.
 */
function normalize(raw: unknown, version: number, extensions?: unknown): Offer | null {
  const parsed = offerSchema.safeParse(raw)
  if (!parsed.success) return null

  const offer = parsed.data
  if (offer.scheme !== 'exact') return null
  if (!ADDRESS.test(offer.payTo) || !ADDRESS.test(offer.asset)) return null

  const atomicAmount = offer.maxAmountRequired ?? offer.amount
  if (atomicAmount === undefined || !ATOMIC.test(atomicAmount) || atomicAmount === '0') return null

  return {
    network: offer.network,
    asset: offer.asset,
    payTo: offer.payTo,
    atomicAmount,
    x402Version: version,
    raw,
    ...(extensions !== undefined ? { extensions } : {}),
    ...(offer.maxTimeoutSeconds !== undefined ? { maxTimeoutSeconds: offer.maxTimeoutSeconds } : {}),
  }
}

const acceptsIn = (value: unknown): Envelope => {
  const parsed = envelopeSchema.safeParse(value)
  if (!parsed.success) return { accepts: [], version: 1 }
  // An envelope that does not say is v1: that is the version that predates
  // anyone having to say.
  return {
    accepts: parsed.data.accepts,
    version: parsed.data.x402Version ?? 1,
    ...(parsed.data.extensions !== undefined ? { extensions: parsed.data.extensions } : {}),
  }
}

const EMPTY: Envelope = { accepts: [], version: 1 }

function decodeHeader(header: string | null): Envelope {
  if (!header) return EMPTY
  try {
    return acceptsIn(JSON.parse(Buffer.from(header, 'base64').toString('utf8')))
  } catch {
    return EMPTY
  }
}

function decodeBody(body: string): Envelope {
  try {
    return acceptsIn(JSON.parse(body))
  } catch {
    return EMPTY
  }
}

/**
 * Every offer a 402 states, from the body and the `payment-required` header
 * alike. Neither is authoritative over the other: servers use one, the other,
 * or both, and an offer is an offer wherever it was written down.
 */
export function readOffers(body: string, paymentRequiredHeader?: string | null): Offer[] {
  const fromBody = decodeBody(body)
  const fromHeader = decodeHeader(paymentRequiredHeader ?? null)
  const offers = [
    ...fromBody.accepts.map((raw) => normalize(raw, fromBody.version, fromBody.extensions)),
    ...fromHeader.accepts.map((raw) => normalize(raw, fromHeader.version, fromHeader.extensions)),
  ].filter((offer): offer is Offer => offer !== null)

  // The same offer stated in both places is one offer, not two — and when a
  // server states it twice it is usually a v2 server keeping a v1 body around
  // for old clients. Answering the older statement makes a v2 server refuse a
  // payment it advertised itself, so the newer one wins.
  const best = new Map<string, Offer>()
  for (const offer of offers) {
    const key = `${offer.network}|${offer.asset.toLowerCase()}|${offer.payTo.toLowerCase()}|${offer.atomicAmount}`
    const held = best.get(key)
    if (!held || offer.x402Version > held.x402Version) best.set(key, offer)
  }
  return [...best.values()]
}

export type OfferChoice =
  | { readonly ok: true; readonly offer: Offer }
  | { readonly ok: false; readonly reason: string }

/**
 * The cheapest offer payable on this rail.
 *
 * When nothing matches, the reason names what was on the table instead — a
 * buyer debugging a refusal needs to know whether the merchant wants another
 * chain or another token, not merely that it said no.
 */
export function selectOffer(offers: readonly Offer[], want: { network: string; asset: string }): OfferChoice {
  if (offers.length === 0) return { ok: false, reason: 'unrecognized 402 offer' }

  const asset = want.asset.toLowerCase()
  const payable = offers
    .filter((offer) => offer.network === want.network && offer.asset.toLowerCase() === asset)
    .sort((a, b) => (BigInt(a.atomicAmount) < BigInt(b.atomicAmount) ? -1 : 1))

  const offer = payable[0]
  if (offer) return { ok: true, offer }

  const onNetwork = offers.filter((o) => o.network === want.network)
  if (onNetwork.length > 0) {
    const tokens = [...new Set(onNetwork.map((o) => o.asset))].join(', ')
    return { ok: false, reason: `no offer in USDG on ${want.network} (offered: ${tokens})` }
  }

  const networks = [...new Set(offers.map((o) => o.network))].join(', ')
  return { ok: false, reason: `no offer on ${want.network} (offered: ${networks})` }
}
