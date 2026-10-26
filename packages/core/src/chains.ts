import { defineChain, type Address, type Chain } from "viem";
import { bsc, bscTestnet, opBNB, opBNBTestnet } from "viem/chains";

export const localDevnet: Chain = defineChain({
  id: 31337,
  name: "Bashard Localnet",
  nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
  testnet: true,
});

export const chains: Record<number, Chain> = {
  31337: localDevnet,
  97: bscTestnet,
  56: bsc,
  204: opBNB,
  5611: opBNBTestnet,
};

export function chainById(id: number): Chain {
  const c = chains[id];
  if (!c) throw new Error(`unsupported chain ${id}`);
  return c;
}

/** Contents of packages/contracts/deployments/<network>.json */
export interface Deployment {
  network: string;
  chainId: number;
  token: Address;
  staking: Address;
  bashard: Address;
  deployBlock: number;
  epochSeconds: number;
  committeeSize: number;
  pricePerMBEpoch: string;
  deployedAt: string;
}

export function explorerTxUrl(chainId: number, hash: string): string | null {
  const c = chains[chainId];
  const base = c?.blockExplorers?.default?.url;
  return base ? `${base}/tx/${hash}` : null;
}
