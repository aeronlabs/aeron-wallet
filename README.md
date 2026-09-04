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
| `pay [--method GET] <url> [json]` | Call an x402 endpoint, paying if it answers 402. POST unless told otherwise. |
| `history` | The last 10 payments, from the local log. |
| `session create` | Mint a scoped session: hosts, budget, per-call cap, expiry. |
| `session list` | Every session, what it spent, and whether it is still live. |
| `session revoke <id>` | Kill a session. It stops paying on its next call. |
| `mcp` | Run as an MCP server over stdio. The default with no arguments. |

## Install it in an agent

**Claude Code**

```
/plugin marketplace add aeronlabs/aeron-wallet
/plugin install aeron-wallet@aeronlabs
```

**Cursor**

[![Add to Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](cursor://anysphere.cursor-deeplink/mcp/install?name=aeron-wallet&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsImFlcm9uLXdhbGxldCIsIm1jcCJdfQ==)

**Gemini CLI**

```bash
gemini extensions install https://github.com/aeronlabs/aeron-wallet
```

**VS Code**

```bash
code --add-mcp '{"name":"aeron-wallet","command":"npx","args":["-y","aeron-wallet","mcp"]}'
```

**Anything else that speaks MCP**

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

## Paying merchants you did not write

Reading a 402 sounds like one line — take `accepts[0]` from the body — and that
line works against servers written the same way this wallet was. It works
against almost nothing else. On a survey of the machine-payable endpoints
listed on Robinhood Chain, **not one merchant put this rail's offer first**:
every one of them leads with Base, and the payable entry sits somewhere down a
list of a dozen.

So the offer is searched for, not assumed, across every shape merchants
actually use:

| What differs | What is done |
|---|---|
| Offers in the JSON body, or in a base64 `payment-required` header, or both | Both are read, and the same offer stated twice is one offer |
| The amount is `maxAmountRequired` (v1) or `amount` (v2) | Either is accepted |
| The list mixes chains and address formats this wallet has no key for | Non-EVM entries are skipped rather than treated as errors |
| Several offers are payable | The cheapest one wins |
| Nothing is payable | The refusal names what *was* offered, so the reason is actionable |

### The two protocol versions are not a version number

v1 carries the payment in `X-PAYMENT` and names the scheme and network at the
top level. v2 carries it in `payment-signature`, names neither, and states the
chosen offer verbatim in `accepted` — a rebuilt copy does not match, because
the server compares it against what it advertised. Answering a v2 merchant in
v1's form does not degrade; it is refused.

Worse, the split is not clean in the wild: merchants advertise a v2 header
beside a v1 body, and one host in a family of five wants `X-PAYMENT` while its
siblings want `payment-signature`. So the payment is offered in the form the
version asks for and, if that is refused outright, in the other one. Both
carry the **same** signed authorization, whose EIP-3009 nonce can be spent
exactly once — so the fallback cannot pay twice, however the server answers.

## What a result means

A request that comes back 4xx is not one situation, it is three, and they
differ in the only way that matters: whether the money left the wallet. The
signal is the settlement receipt — a service that settled returns
`X-PAYMENT-RESPONSE` with a transaction hash, and one that did not, does not.

| `status` | Charged | What happened |
|---|---|---|
| `settled` | yes | The service answered. `reason` is set only in the bad case below. |
| `rejected` | no | HTTP 402. The service refused the payment; the authorization is unspent. |
| `failed` | no | The service returned an error *and declined to charge* — usually its own upstream failed. |

The case worth naming: a `settled` row **with** a `reason` means the money
moved and nothing came back. That is the only outcome where the wallet is out
of pocket for nothing, so it is reported as itself rather than folded in with
refusals that cost nothing.

Only `settled` counts against `DAILY_CAP_USD`. A refusal and an upstream
failure leave the balance untouched, so neither eats into the cap.

`reason` quotes the service's own message when it gave one, instead of a
generic phrase — an agent operator reading a log needs to know whether to
retry, top up, or fix the seller.

## Configuration

| Variable | Default |
|---|---|
| `RPC_URL` | `https://rpc.mainnet.chain.robinhood.com` |
| `CHAIN_ID` | `4663` |
| `USDG_ADDRESS` | `0x5fc5360d0400a0fd4f2af552add042d716f1d168` |
| `AERON_WALLET_DIR` | `~/.aeron/wallet` |
| `AERON_WALLET_KEY` | unset. Overrides the stored key. |
| `AERON_WALLET_SESSION` | unset. Binds the whole process to one session. |

## Releases

Published from a tag by GitHub Actions using npm trusted publishing, so no
long-lived npm token exists to leak and every tarball carries a provenance
attestation: proof of the commit and workflow it was built from. Verify with
`npm audit signatures` after installing.

## Where payments go

Payments settle on Robinhood Chain mainnet in USDG through the Aeron
facilitator at `x402.aeron.sh`. The wallet works with any x402 endpoint on the
same network, not only Aeron's.

More at [aeron.sh/wallet](https://aeron.sh/wallet/).
