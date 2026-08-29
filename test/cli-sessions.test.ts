import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { createSessions } from '../src/sessions.js'
import { runSessionCommand } from '../src/cli-sessions.js'

function harness(overrides: Record<string, string> = {}) {
  const cfg = loadConfig({
    AERON_WALLET_DIR: mkdtempSync(join(tmpdir(), 'aeron-cli-sessions-')),
    ...overrides,
  })
  const sessions = createSessions(cfg)
  const lines: string[] = []
  const run = (args: string[]) => runSessionCommand(args, { sessions, cfg, out: (l) => lines.push(l) })
  return { cfg, sessions, lines, run, text: () => lines.join('\n') }
}

describe('session create', () => {
  it('stores the grant and prints the token with the line that binds it', () => {
    const h = harness()
    h.run(['create', '--host', 'inference.aeron.sh', '--budget', '0.25', '--ttl', '2h', '--max-per-call', '0.01'])

    const [stored] = h.sessions.list()
    expect(stored?.hosts).toEqual(['inference.aeron.sh'])
    expect(stored?.budgetUsd).toBe(0.25)
    expect(stored?.maxPerCallUsd).toBe(0.01)

    const token = h.lines.find((l) => /^[0-9a-f]{64}$/.test(l))
    expect(token).toBeDefined()
    expect(h.text()).toContain(`AERON_WALLET_SESSION=${token} aeron-wallet mcp`)
    expect(h.sessions.findByToken(token!)?.id).toBe(stored?.id)
  })

  it('takes several hosts, as repeated flags or one comma-separated list', () => {
    const h = harness()
    h.run(['create', '--host', 'a.example', '--host', 'b.example,c.example', '--budget', '1', '--ttl', '1d'])
    expect(h.sessions.list()[0]?.hosts).toEqual(['a.example', 'b.example', 'c.example'])
  })

  it('defaults the per-call cap to the wallet cap, or the budget when that is smaller', () => {
    const wide = harness({ MAX_PER_CALL_USD: '0.05' })
    wide.run(['create', '--host', 'a.example', '--budget', '1', '--ttl', '1h'])
    expect(wide.sessions.list()[0]?.maxPerCallUsd).toBe(0.05)

    const tight = harness({ MAX_PER_CALL_USD: '0.05' })
    tight.run(['create', '--host', 'a.example', '--budget', '0.02', '--ttl', '1h'])
    expect(tight.sessions.list()[0]?.maxPerCallUsd).toBe(0.02)
  })

  it('says so when the session budget is bigger than the daily cap that still applies', () => {
    const h = harness({ DAILY_CAP_USD: '1' })
    h.run(['create', '--host', 'a.example', '--budget', '5', '--ttl', '1h'])
    expect(h.text()).toContain('daily cap of $1 still applies')
  })

  it.each([
    [['create', '--budget', '1', '--ttl', '1h'], 'at least one --host'],
    [['create', '--host', 'a.example', '--ttl', '1h'], '--budget is required'],
    [['create', '--host', 'a.example', '--budget', '1'], '--ttl is required'],
    [['create', '--host', 'a.example', '--budget', 'free', '--ttl', '1h'], 'positive number'],
    [['create', '--host', 'a.example', '--budget', '-1', '--ttl', '1h'], 'positive number'],
    [['create', '--host', 'a.example', '--budget', '1', '--ttl', 'forever'], 'invalid duration'],
    [['create', '--hosts', 'a.example'], 'unknown flag --hosts'],
    [['create', '--host'], '--host needs a value'],
    [['create', 'a.example'], 'unexpected argument'],
  ])('refuses %j', (args, message) => {
    const h = harness()
    expect(() => h.run(args as string[])).toThrow(message as string)
    expect(h.sessions.list()).toHaveLength(0)
  })
})

describe('session list and revoke', () => {
  it('reports an empty store plainly', () => {
    const h = harness()
    h.run(['list'])
    expect(h.text()).toBe('no sessions')
  })

  it('shows spend, scope, and state', () => {
    const h = harness()
    h.run(['create', '--host', 'a.example', '--budget', '0.25', '--ttl', '1h'])
    const id = h.sessions.list()[0]!.id
    h.sessions.recordSpend(id, 0.004)

    h.lines.length = 0
    h.run(['list'])
    expect(h.text()).toContain(id)
    expect(h.text()).toContain('active')
    expect(h.text()).toContain('$0.0040/$0.25')
  })

  it('marks an expired session without needing a revoke', () => {
    const h = harness()
    h.sessions.create(
      { hosts: ['a.example'], budgetUsd: 1, maxPerCallUsd: 0.01, ttlSeconds: 1 },
      new Date(Date.now() - 60_000),
    )
    h.run(['list'])
    expect(h.text()).toContain('expired')
  })

  it('revokes a known id once, and says so for anything else', () => {
    const h = harness()
    h.run(['create', '--host', 'a.example', '--budget', '1', '--ttl', '1h'])
    const id = h.sessions.list()[0]!.id

    h.lines.length = 0
    h.run(['revoke', id])
    h.run(['revoke', id])
    h.run(['revoke', 'ffffffff'])

    expect(h.lines[0]).toBe(`revoked ${id}`)
    expect(h.lines[1]).toBe(`no active session with id ${id}`)
    expect(h.lines[2]).toBe('no active session with id ffffffff')
  })

  it('rejects a missing id and an unknown subcommand', () => {
    const h = harness()
    expect(() => h.run(['revoke'])).toThrow('session revoke <id>')
    expect(() => h.run(['inspect'])).toThrow('session create|list|revoke')
  })
})
