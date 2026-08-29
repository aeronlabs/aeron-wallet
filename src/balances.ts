import { createPublicClient, defineChain, http, formatEther, type Address, type PublicClient } from 'viem'
import type { WalletConfig } from './config.js'

const ERC20_ABI = [
  {
    type: 'function', name: 'balanceOf', stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const

export function createChainClient(cfg: WalletConfig): PublicClient {
  const chain = defineChain({
    id: cfg.CHAIN_ID,
    name: 'Robinhood Chain',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [cfg.RPC_URL] } },
  })
  return createPublicClient({ chain, transport: http(cfg.RPC_URL) })
}

export async function readBalances(
  publicClient: PublicClient,
  cfg: WalletConfig,
  address: Address,
): Promise<{ eth: string; usdg: string }> {
  const [wei, usdgRaw] = await Promise.all([
    publicClient.getBalance({ address }),
    publicClient.readContract({
      address: cfg.USDG_ADDRESS as Address,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [address],
    }),
  ])
  return { eth: formatEther(wei), usdg: (Number(usdgRaw as bigint) / 1e6).toFixed(6) }
}
