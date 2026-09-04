import type { Offer } from './offers.js'

/**
 * Putting the signed authorization on the wire.
 *
 * The two protocol versions disagree about more than a number. v1 carries the
 * payment in `X-PAYMENT` and names the scheme and network at the top level; v2
 * carries it in `payment-signature` and names neither, stating the chosen
 * offer verbatim in `accepted` instead.
 *
 * Neither shape was guessed: both were read off the reference client's own
 * traffic and confirmed against live merchants.
 */

/** The EIP-3009 authorization, in the string form both versions put on the wire. */
export type SignedAuthorization = {
  readonly signature: string
  readonly authorization: {
    readonly from: string
    readonly to: string
    readonly value: string
    readonly validAfter: string
    readonly validBefore: string
    readonly nonce: string
  }
}

export type PaymentHeader = {
  readonly name: string
  readonly value: string
}

const encode = (payload: unknown): string => Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')

function v2Header(offer: Offer, signed: SignedAuthorization): PaymentHeader {
  return {
    name: 'payment-signature',
    value: encode({
      x402Version: Math.max(offer.x402Version, 2),
      // The chosen offer, exactly as the server wrote it. v2 has no top-level
      // scheme or network — they live in here, and a server that matches the
      // payment against what it advertised needs the entry back byte for byte
      // rather than rebuilt.
      accepted: offer.raw,
      payload: signed,
      // Echoed the way the reference client echoes it: the server sent these
      // with the offer, and some read them again on the way in.
      ...(offer.extensions !== undefined ? { extensions: offer.extensions } : {}),
    }),
  }
}

function v1Header(offer: Offer, signed: SignedAuthorization): PaymentHeader {
  return {
    name: 'x-payment',
    value: encode({
      x402Version: 1,
      scheme: 'exact',
      network: offer.network,
      payload: signed,
    }),
  }
}

/** The form this offer's own version asks for. */
export function buildPaymentHeader(offer: Offer, signed: SignedAuthorization): PaymentHeader {
  return offer.x402Version >= 2 ? v2Header(offer, signed) : v1Header(offer, signed)
}

/**
 * The forms to offer a payment in, best guess first.
 *
 * Out in the open the two versions are not cleanly separated: merchants
 * advertise a v2 header beside a v1 body, and which one they will actually
 * accept is not reliably stated anywhere — one host in a family of five wants
 * `X-PAYMENT` while its siblings want `payment-signature`.
 *
 * So present the other form too. A refusal costs nothing, and both forms carry
 * the *same* signed authorization, whose EIP-3009 nonce can be spent exactly
 * once. The fallback therefore cannot pay twice, however the server answers.
 */
export function paymentAttempts(offer: Offer, signed: SignedAuthorization): PaymentHeader[] {
  return offer.x402Version >= 2
    ? [v2Header(offer, signed), v1Header(offer, signed)]
    : [v1Header(offer, signed), v2Header(offer, signed)]
}
