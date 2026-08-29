import type { WalletConfig } from './config.js'
import { parseTtlSeconds, type SessionStore } from './sessions.js'

type Out = (line: string) => void

/** Collect repeated `--flag value` pairs. Unknown flags are an error, not a shrug. */
function readFlags(args: readonly string[], known: readonly string[]): Map<string, string[]> {
  const flags = new Map<string, string[]>()
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!
    if (!arg.startsWith('--')) throw new Error(`unexpected argument "${arg}"`)
    const name = arg.slice(2)
    if (!known.includes(name)) throw new Error(`unknown flag --${name}; expected ${known.map((k) => `--${k}`).join(', ')}`)
    const value = args[i + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value`)
    flags.set(name, [...(flags.get(name) ?? []), value])
    i += 1
  }
  return flags
}

function positiveNumber(raw: string, label: string): number {
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be a positive number, got "${raw}"`)
  return value
}

const CREATE_FLAGS = ['host', 'budget', 'ttl', 'max-per-call'] as const

function create(args: readonly string[], sessions: SessionStore, cfg: WalletConfig, out: Out): void {
  const flags = readFlags(args, CREATE_FLAGS)
  const hosts = (flags.get('host') ?? []).flatMap((h) => h.split(',')).map((h) => h.trim()).filter(Boolean)
  if (hosts.length === 0) throw new Error('at least one --host is required; a session with no scope is not a scope')

  const budgetRaw = flags.get('budget')?.[0]
  const ttlRaw = flags.get('ttl')?.[0]
  if (!budgetRaw) throw new Error('--budget is required, in USD')
  if (!ttlRaw) throw new Error('--ttl is required, for example 2h')

  const budgetUsd = positiveNumber(budgetRaw, '--budget')
  const maxPerCallUsd = flags.has('max-per-call')
    ? positiveNumber(flags.get('max-per-call')![0]!, '--max-per-call')
    : Math.min(cfg.MAX_PER_CALL_USD, budgetUsd)

  const { session, token } = sessions.create({
    hosts,
    budgetUsd,
    maxPerCallUsd,
    ttlSeconds: parseTtlSeconds(ttlRaw),
  })

  out(`session  ${session.id}`)
  out(`hosts    ${session.hosts.join(', ')}`)
  out(`budget   $${session.budgetUsd} total, $${session.maxPerCallUsd} per call`)
  out(`expires  ${session.expiresAt}`)
  out('')
  out('token, shown once:')
  out(token)
  out('')
  out('Give it to an agent by binding a server to it:')
  out(`  AERON_WALLET_SESSION=${token} aeron-wallet mcp`)
  if (budgetUsd > cfg.DAILY_CAP_USD) {
    out('')
    out(`note: the wallet's own daily cap of $${cfg.DAILY_CAP_USD} still applies and is lower than this budget.`)
  }
}

function list(sessions: SessionStore, out: Out, now = new Date()): void {
  const all = sessions.list()
  if (all.length === 0) {
    out('no sessions')
    return
  }
  for (const s of all) {
    const state = s.revokedAt ? 'revoked' : Date.parse(s.expiresAt) < now.getTime() ? 'expired' : 'active'
    out(
      `${s.id}  ${state.padEnd(7)}  $${s.spentUsd.toFixed(4)}/$${s.budgetUsd}  ${s.hosts.join(',')}  until ${s.expiresAt}`,
    )
  }
}

export function runSessionCommand(
  args: readonly string[],
  deps: { readonly sessions: SessionStore; readonly cfg: WalletConfig; readonly out: Out },
): void {
  const [sub, ...rest] = args
  switch (sub) {
    case 'create':
      return create(rest, deps.sessions, deps.cfg, deps.out)
    case 'list':
      return list(deps.sessions, deps.out)
    case 'revoke': {
      const id = rest[0]
      if (!id) throw new Error('usage: session revoke <id>')
      deps.out(deps.sessions.revoke(id) ? `revoked ${id}` : `no active session with id ${id}`)
      return
    }
    default:
      throw new Error('usage: session create|list|revoke')
  }
}
