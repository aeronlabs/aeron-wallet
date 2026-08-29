import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { checkSession, createSessions, parseTtlSeconds } from '../src/sessions.js'

function tempCfg(overrides: Record<string, string> = {}) {
  return loadConfig({
    AERON_WALLET_DIR: mkdtempSync(join(tmpdir(), 'aeron-sessions-')),
    ...overrides,
  })
}

const grant = {
  hosts: ['inference.aeron.sh'],
  budgetUsd: 0.25,
  maxPerCallUsd: 0.01,
  ttlSeconds: 3600,
}

describe('parseTtlSeconds', () => {
  it('reads plain seconds and the m/h/d suffixes', () => {
    expect(parseTtlSeconds('90')).toBe(90)
    expect(parseTtlSeconds('30m')).toBe(1800)
    expect(parseTtlSeconds('2h')).toBe(7200)
    expect(parseTtlSeconds('1d')).toBe(86400)
  })

  it('rejects anything else', () => {
    expect(() => parseTtlSeconds('2 hours')).toThrow()
    expect(() => parseTtlSeconds('0')).toThrow()
    expect(() => parseTtlSeconds('-5m')).toThrow()
  })
})

describe('session store', () => {
  it('returns the token once and never writes it to disk', () => {
    const cfg = tempCfg()
    const sessions = createSessions(cfg)
    const { session, token } = sessions.create(grant)

    expect(token).toMatch(/^[0-9a-f]{64}$/)
    const raw = readFileSync(join(cfg.AERON_WALLET_DIR, 'sessions.json'), 'utf8')
    expect(raw).not.toContain(token)
    expect(raw).toContain(session.id)
    expect(statSync(join(cfg.AERON_WALLET_DIR, 'sessions.json')).mode & 0o777).toBe(0o600)
  })

  it('finds a session by its token and nothing by a wrong one', () => {
    const sessions = createSessions(tempCfg())
    const { session, token } = sessions.create(grant)

    expect(sessions.findByToken(token)?.id).toBe(session.id)
    expect(sessions.findByToken(`${'0'.repeat(64)}`)).toBeNull()
  })

  it('records spend without mutating the session it was given', () => {
    const sessions = createSessions(tempCfg())
    const { session, token } = sessions.create(grant)

    sessions.recordSpend(session.id, 0.004)
    expect(session.spentUsd).toBe(0)
    expect(sessions.findByToken(token)?.spentUsd).toBeCloseTo(0.004, 6)

    sessions.recordSpend(session.id, 0.004)
    expect(sessions.findByToken(token)?.spentUsd).toBeCloseTo(0.008, 6)
  })

  it('revokes by id, and a revoked session stops resolving', () => {
    const sessions = createSessions(tempCfg())
    const { session, token } = sessions.create(grant)

    expect(sessions.revoke(session.id)).toBe(true)
    expect(sessions.findByToken(token)).toBeNull()
    expect(sessions.revoke('nope')).toBe(false)
  })

  it('lists sessions without exposing the token hash', () => {
    const sessions = createSessions(tempCfg())
    sessions.create(grant)

    const listed = sessions.list()
    expect(listed).toHaveLength(1)
    expect(JSON.stringify(listed)).not.toContain('tokenHash')
  })
})

describe('checkSession', () => {
  const cfg = tempCfg()
  const sessions = createSessions(cfg)
  const { session } = sessions.create(grant)
  const now = () => Date.parse(session.createdAt) + 1000

  it('passes a call inside the scope', () => {
    const outcome = checkSession(session, {
      url: 'https://inference.aeron.sh/v1/chat/completions',
      amountUsd: 0.004,
      now: now(),
    })
    expect(outcome.ok).toBe(true)
  })

  it('refuses a host the session was not granted', () => {
    const outcome = checkSession(session, {
      url: 'https://elsewhere.example/v1/chat',
      amountUsd: 0.004,
      now: now(),
    })
    expect(outcome).toMatchObject({ ok: false })
    expect(outcome.ok === false && outcome.reason).toContain('elsewhere.example')
  })

  it('refuses an amount above the session per-call cap', () => {
    const outcome = checkSession(session, {
      url: 'https://inference.aeron.sh/v1/chat',
      amountUsd: 0.02,
      now: now(),
    })
    expect(outcome).toMatchObject({ ok: false })
    expect(outcome.ok === false && outcome.reason).toContain('per-call')
  })

  it('refuses once the session budget is used up', () => {
    const spent = { ...session, spentUsd: 0.249 }
    const outcome = checkSession(spent, {
      url: 'https://inference.aeron.sh/v1/chat',
      amountUsd: 0.004,
      now: now(),
    })
    expect(outcome).toMatchObject({ ok: false })
    expect(outcome.ok === false && outcome.reason).toContain('budget')
  })

  it('refuses after expiry', () => {
    const outcome = checkSession(session, {
      url: 'https://inference.aeron.sh/v1/chat',
      amountUsd: 0.004,
      now: Date.parse(session.expiresAt) + 1,
    })
    expect(outcome).toMatchObject({ ok: false })
    expect(outcome.ok === false && outcome.reason).toContain('expired')
  })

  it('refuses a revoked session', () => {
    const revoked = { ...session, revokedAt: new Date(now()).toISOString() }
    const outcome = checkSession(revoked, {
      url: 'https://inference.aeron.sh/v1/chat',
      amountUsd: 0.004,
      now: now(),
    })
    expect(outcome).toMatchObject({ ok: false })
    expect(outcome.ok === false && outcome.reason).toContain('revoked')
  })
})
