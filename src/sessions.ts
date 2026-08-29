import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import type { WalletConfig } from './config.js'

/**
 * A session is a scope, not a second key. EIP-3009 requires the signature to
 * come from the address that holds the USDG, so a separate keypair could not
 * spend this wallet's balance without being funded itself. What actually
 * contains a leaked agent is that the agent never holds the key at all: it
 * asks the wallet to pay. A session bounds what it may ask for.
 */
export type Session = {
  readonly id: string
  readonly tokenHash: string
  readonly hosts: readonly string[]
  readonly budgetUsd: number
  readonly maxPerCallUsd: number
  readonly spentUsd: number
  readonly createdAt: string
  readonly expiresAt: string
  readonly revokedAt: string | null
}

/** A session as shown to callers: the token hash never leaves the store. */
export type PublicSession = Omit<Session, 'tokenHash'>

export type Grant = {
  readonly hosts: readonly string[]
  readonly budgetUsd: number
  readonly maxPerCallUsd: number
  readonly ttlSeconds: number
}

const sessionSchema = z.object({
  id: z.string().min(1),
  tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
  hosts: z.array(z.string().min(1)).min(1),
  budgetUsd: z.number().positive(),
  maxPerCallUsd: z.number().positive(),
  spentUsd: z.number().min(0),
  createdAt: z.string(),
  expiresAt: z.string(),
  revokedAt: z.string().nullable(),
})

const TTL_PATTERN = /^(\d+)([mhd])?$/
const TTL_UNITS: Record<string, number> = { m: 60, h: 3600, d: 86400 }

/** Read a duration written as seconds, or with an m/h/d suffix. */
export function parseTtlSeconds(input: string): number {
  const match = TTL_PATTERN.exec(input.trim())
  if (!match) throw new Error(`invalid duration "${input}"; use 90, 30m, 2h, or 1d`)
  const amount = Number(match[1])
  if (amount <= 0) throw new Error(`duration must be greater than zero, got "${input}"`)
  return amount * (match[2] ? TTL_UNITS[match[2]]! : 1)
}

const hash = (token: string): string => createHash('sha256').update(token).digest('hex')

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex')
  const right = Buffer.from(b, 'hex')
  return left.length === right.length && timingSafeEqual(left, right)
}

export type CheckInput = { readonly url: string; readonly amountUsd: number; readonly now: number }
export type CheckOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: string }

/** Everything a session forbids, decided without touching disk or the chain. */
export function checkSession(session: Session, input: CheckInput): CheckOutcome {
  const deny = (reason: string): CheckOutcome => ({ ok: false, reason })
  if (session.revokedAt) return deny(`session ${session.id} was revoked at ${session.revokedAt}`)
  if (input.now > Date.parse(session.expiresAt)) {
    return deny(`session ${session.id} expired at ${session.expiresAt}`)
  }

  let host: string
  try {
    host = new URL(input.url).hostname
  } catch {
    return deny(`could not read a host from "${input.url}"`)
  }
  if (!session.hosts.includes(host)) {
    return deny(`host ${host} is outside this session's scope (${session.hosts.join(', ')})`)
  }

  if (input.amountUsd > session.maxPerCallUsd) {
    return deny(`$${input.amountUsd} is over the session per-call cap of $${session.maxPerCallUsd}`)
  }
  const remaining = session.budgetUsd - session.spentUsd
  if (input.amountUsd > remaining) {
    return deny(`session budget spent: $${remaining.toFixed(6)} left of $${session.budgetUsd}`)
  }
  return { ok: true }
}

export type SessionStore = {
  create(grant: Grant, now?: Date): { readonly session: Session; readonly token: string }
  list(): readonly PublicSession[]
  /** Resolve a presented token. Revoked sessions do not resolve. */
  findByToken(token: string): Session | null
  recordSpend(id: string, amountUsd: number): void
  revoke(id: string, now?: Date): boolean
}

/**
 * A live view of the session a process is bound to. `current` is re-read on
 * every call rather than captured once, so a revoke lands immediately and a
 * long-running server cannot spend against a stale budget.
 */
export type SessionBinding = {
  readonly current: () => Session | null
  readonly recordSpend: (amountUsd: number) => void
}

export function bindSession(store: SessionStore, token: string): SessionBinding {
  return {
    current: () => store.findByToken(token),
    recordSpend: (amountUsd) => {
      const session = store.findByToken(token)
      if (session) store.recordSpend(session.id, amountUsd)
    },
  }
}

export function createSessions(cfg: WalletConfig): SessionStore {
  const filePath = join(cfg.AERON_WALLET_DIR, 'sessions.json')

  function readAll(): readonly Session[] {
    if (!existsSync(filePath)) return []
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(filePath, 'utf8'))
    } catch {
      throw new Error(`sessions file is not valid JSON: ${filePath}`)
    }
    const parsed = z.array(sessionSchema).safeParse(raw)
    if (!parsed.success) throw new Error(`sessions file is malformed: ${filePath}`)
    return parsed.data
  }

  function writeAll(sessions: readonly Session[]): void {
    mkdirSync(cfg.AERON_WALLET_DIR, { recursive: true, mode: 0o700 })
    writeFileSync(filePath, `${JSON.stringify(sessions, null, 2)}\n`, { mode: 0o600 })
    chmodSync(filePath, 0o600)
  }

  const strip = ({ tokenHash: _tokenHash, ...rest }: Session): PublicSession => rest

  return {
    create(grant, now = new Date()) {
      const token = randomBytes(32).toString('hex')
      const session: Session = {
        id: randomBytes(4).toString('hex'),
        tokenHash: hash(token),
        hosts: [...grant.hosts],
        budgetUsd: grant.budgetUsd,
        maxPerCallUsd: grant.maxPerCallUsd,
        spentUsd: 0,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + grant.ttlSeconds * 1000).toISOString(),
        revokedAt: null,
      }
      writeAll([...readAll(), session])
      return { session, token }
    },

    list() {
      return readAll().map(strip)
    },

    findByToken(token) {
      if (!/^[0-9a-f]{64}$/.test(token)) return null
      const wanted = hash(token)
      return readAll().find((s) => !s.revokedAt && sameHash(s.tokenHash, wanted)) ?? null
    },

    recordSpend(id, amountUsd) {
      writeAll(readAll().map((s) => (s.id === id ? { ...s, spentUsd: s.spentUsd + amountUsd } : s)))
    },

    revoke(id, now = new Date()) {
      const sessions = readAll()
      if (!sessions.some((s) => s.id === id && !s.revokedAt)) return false
      writeAll(sessions.map((s) => (s.id === id ? { ...s, revokedAt: now.toISOString() } : s)))
      return true
    },
  }
}
