/**
 * What actually happened after the wallet handed over a payment.
 *
 * "The request came back 4xx" is not one situation, it is three, and they
 * differ in the only way an agent operator cares about: whether the money
 * left the wallet.
 *
 *   - the service answered           → paid, got the goods
 *   - the service refused the payment → not charged, the authorization stands
 *   - the service refused to charge   → not charged, its upstream failed
 *   - the service charged and failed  → charged, got nothing  ← say this loudly
 *
 * The signal is the settlement receipt. A service that settles returns
 * X-PAYMENT-RESPONSE with a transaction hash; one that did not, does not.
 */

export type OutcomeStatus = 'settled' | 'rejected' | 'failed'

export type Outcome = {
  /** Did the caller get what it paid for? */
  readonly ok: boolean
  /** Did money leave the wallet? Drives the daily cap and the session spend. */
  readonly charged: boolean
  readonly status: OutcomeStatus
  readonly reason?: string
}

/** The service's own words, dug out of whatever shape it used to say them. */
export function serviceMessage(body: string): string | null {
  if (!body.trim()) return null
  try {
    const parsed = JSON.parse(body) as { error?: unknown }
    const error = parsed.error
    if (typeof error === 'string' && error.trim()) return error.trim()
    if (error && typeof error === 'object') {
      const message = (error as { message?: unknown }).message
      if (typeof message === 'string' && message.trim()) return message.trim()
    }
    return null
  } catch {
    // Not JSON. A short plain-text body is still better than a generic phrase.
    const text = body.trim()
    return text.length <= 200 ? text : null
  }
}

const withMessage = (fallback: string, body: string): string => {
  const message = serviceMessage(body)
  return message ? `${fallback}: ${message}` : fallback
}

export function describeOutcome(
  httpStatus: number,
  transaction: string | null,
  body: string,
): Outcome {
  const charged = transaction !== null

  if (httpStatus < 400) return { ok: true, charged, status: 'settled' }

  if (charged) {
    // The worst case and the quietest one: the money moved and the caller has
    // nothing to show for it. Named explicitly so it cannot be mistaken for a
    // refusal that cost nothing.
    return {
      ok: false,
      charged: true,
      status: 'settled',
      reason: withMessage(
        `charged (${transaction}) but the service then returned HTTP ${httpStatus}`,
        body,
      ),
    }
  }

  if (httpStatus === 402) {
    return {
      ok: false,
      charged: false,
      status: 'rejected',
      reason: withMessage('the service refused the payment; you were not charged', body),
    }
  }

  return {
    ok: false,
    charged: false,
    status: 'failed',
    reason: withMessage(
      `the service returned HTTP ${httpStatus} and did not charge you`,
      body,
    ),
  }
}
