# aeron-wallet

A non-custodial wallet for agents. It holds USDG on Robinhood Chain and pays
`402 Payment Required` responses on its own, so an agent can call a metered API
without a card, an account, or a human in the loop.

Ships two ways: a CLI, and an MCP server for Claude and other MCP clients.

## Quickstart

```bash
npx -y aeron-wallet address
```

That prints your wallet address and creates a key on first run. Send USDG to
that address, then pay for a call:

```bash
npx -y aeron-wallet pay https://inference.aeron.sh/v1/chat/completions \
  '{"model":"deepseek/deepseek-chat","messages":[{"role":"user","content":"hi"}]}'
```

The wallet reads the 402 challenge, checks it against your budget caps, signs an
EIP-3009 transfer, and retries the request with the payment attached. You do not
need ETH: the facilitator relays the transaction and pays gas.

## Commands

| Command | What it does |
|---|---|
| `address` | Print the wallet address. Creates the key if none exists. |
| `balance` | ETH and USDG balances, read from chain. |
| `pay <url> [json]` | Call an x402 endpoint, paying if it answers 402. |
| `history` | The last 10 payments, from the local log. |
| `session create` | Mint a scoped session: hosts, budget, per-call cap, expiry. |
| `session list` | Every session, what it spent, and whether it is still live. |
| `session revoke <id>` | Kill a session. It stops paying on its next call. |
| `mcp` | Run as an MCP server over stdio. The default with no arguments. |

## MCP

```json
{
  "mcpServers": {
    "aeron-wallet": {
      "command": "npx",
      "args": ["-y", "aeron-wallet", "mcp"]
    }
  }
}
```

Four tools: `get_address`, `get_balance`, `pay`, `history`. An unbound server
also gets `create_session`, `list_sessions`, and `revoke_session`.

## Sessions

A session is a scope you can hand to an agent without handing over the wallet.
It names the hosts that may be paid, a total budget, a per-call cap, and an
expiry:

```bash
aeron-wallet session create --host inference.aeron.sh --budget 0.25 --ttl 2h
```

That prints a token, once. Bind a server to it and every call through that
server inherits the scope:

```json
{
  "mcpServers": {
    "aeron-wallet": {
      "command": "npx",
      "args": ["-y", "aeron-wallet", "mcp"],
      "env": { "AERON_WALLET_SESSION": "<token>" }
    }
  }
}
```

A bound server deliberately has no session tools. An agent that could mint
itself a wider session would not be contained by one. It also cannot reach a
host outside the scope: the wallet refuses before the request goes out, so an
agent talked into paying an attacker's endpoint never contacts it.

Revoking takes effect on the next call, including for a server already
running, because the scope is re-read every time rather than captured at
startup.

`aeron-wallet pay --session <token> <url>` applies a scope to a single call.

Sessions narrow the wallet; they never widen it. The caps below still apply
underneath, so a $5 session on a $1/day wallet spends $1 a day.

## Your key

The key is generated on your machine on first run and written to
`~/.aeron/wallet/key` with `0600` permissions. It never leaves the machine and
nobody else can derive your address. Every install creates a different wallet.

Two consequences worth planning for:

- **Ephemeral containers.** If `$HOME` is wiped between runs, the wallet
  regenerates and any USDG left on the old address is stranded. Mount a volume
  for `~/.aeron`, set `AERON_WALLET_DIR` to a path that persists, or supply the
  key yourself with `AERON_WALLET_KEY`.
- **Hot wallet.** The key sits unencrypted on disk so an agent can sign without
  a prompt. Keep the balance small. Fund it the way you would top up a prepaid
  card, not the way you would fund savings.

## Budget caps

The wallet refuses to sign above either cap, so a loop cannot drain it.

| Variable | Default | Meaning |
|---|---|---|
| `MAX_PER_CALL_USD` | `0.05` | Largest single payment. |
| `DAILY_CAP_USD` | `1` | Total for the current UTC day. |

## Configuration

| Variable | Default |
|---|---|
| `RPC_URL` | `https://rpc.mainnet.chain.robinhood.com` |
| `CHAIN_ID` | `4663` |
| `USDG_ADDRESS` | `0x5fc5360d0400a0fd4f2af552add042d716f1d168` |
| `AERON_WALLET_DIR` | `~/.aeron/wallet` |
| `AERON_WALLET_KEY` | unset. Overrides the stored key. |
| `AERON_WALLET_SESSION` | unset. Binds the whole process to one session. |

## Where payments go

Payments settle on Robinhood Chain mainnet in USDG through the Aeron
facilitator at `x402.aeron.sh`. The wallet works with any x402 endpoint on the
same network, not only Aeron's.

More at [aeron.sh/wallet](https://aeron.sh/wallet/).
