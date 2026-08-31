import { describe, expect, it } from 'vitest'
import { describeOutcome, serviceMessage } from '../src/outcome.js'

const TX = '0xabc123'

describe('serviceMessage', () => {
  it('reads a nested error message', () => {
    expect(serviceMessage('{"error":{"message":"rate limited upstream"}}')).toBe(
      'rate limited upstream',
    )
  })

  it('reads a flat error string, which the x402 body uses', () => {
    expect(serviceMessage('{"x402Version":1,"error":"Settlement failed"}')).toBe('Settlement failed')
  })

  it('keeps a short plain-text body rather than discarding it', () => {
    expect(serviceMessage('service unavailable')).toBe('service unavailable')
  })

  it('drops a body too long to belong in an error line', () => {
    expect(serviceMessage('x'.repeat(400))).toBeNull()
  })

  it('has nothing to say about an empty or messageless body', () => {
    expect(serviceMessage('')).toBeNull()
    expect(serviceMessage('   ')).toBeNull()
    expect(serviceMessage('{"ok":true}')).toBeNull()
    expect(serviceMessage('{"error":{}}')).toBeNull()
  })
})

describe('describeOutcome', () => {
  it('a good answer is settled, charged, and needs no explanation', () => {
    expect(describeOutcome(200, TX, '{"choices":[]}')).toEqual({
      ok: true,
      charged: true,
      status: 'settled',
    })
  })

  it('names the case where the money moved and nothing came back', () => {
    const outcome = describeOutcome(502, TX, '{"error":{"message":"upstream died"}}')
    expect(outcome).toMatchObject({ ok: false, charged: true, status: 'settled' })
    expect(outcome.reason).toContain(TX)
    expect(outcome.reason).toContain('upstream died')
  })

  it('a 402 is a refused payment, and says the wallet was not charged', () => {
    const outcome = describeOutcome(402, null, '{"x402Version":1,"error":"nonce already used"}')
    expect(outcome).toMatchObject({ ok: false, charged: false, status: 'rejected' })
    expect(outcome.reason).toContain('not charged')
    expect(outcome.reason).toContain('nonce already used')
  })

  /**
   * The case this module was written for. The old wallet called every non-2xx
   * "payment rejected by the service", which is exactly backwards when the
   * service declined to charge because its own upstream failed.
   */
  it('a service that refused to charge is a failure, not a rejection', () => {
    const outcome = describeOutcome(
      429,
      null,
      '{"error":{"message":"upstream 429: Provider returned error. You were not charged."}}',
    )
    expect(outcome).toMatchObject({ ok: false, charged: false, status: 'failed' })
    expect(outcome.reason).toContain('did not charge you')
    expect(outcome.reason).toContain('Provider returned error')
  })

  it('falls back to the status alone when the service explained nothing', () => {
    expect(describeOutcome(503, null, '').reason).toBe(
      'the service returned HTTP 503 and did not charge you',
    )
  })

  it('treats a 2xx with no receipt as uncharged, so no cap is spent on it', () => {
    expect(describeOutcome(200, null, '{}')).toEqual({ ok: true, charged: false, status: 'settled' })
  })
})
