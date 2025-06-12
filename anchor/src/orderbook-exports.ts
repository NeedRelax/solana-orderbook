// Here we export some useful types and functions for interacting with the Anchor program.
import { AnchorProvider, Program } from '@coral-xyz/anchor'
import { Cluster, PublicKey } from '@solana/web3.js'
import OrderbookIDL from '../target/idl/orderbook.json'
import type { Orderbook } from '../target/types/orderbook'

// Re-export the generated IDL and type
export { Orderbook, OrderbookIDL }

// The programId is imported from the program IDL.
export const ORDERBOOK_PROGRAM_ID = new PublicKey(OrderbookIDL.address)

// This is a helper function to get the Orderbook Anchor program.
export function getOrderbookProgram(provider: AnchorProvider, address?: PublicKey): Program<Orderbook> {
  return new Program({ ...OrderbookIDL, address: address ? address.toBase58() : OrderbookIDL.address } as Orderbook, provider)
}

// This is a helper function to get the program ID for the Orderbook program depending on the cluster.
export function getOrderbookProgramId(cluster: Cluster) {
  switch (cluster) {
    case 'devnet':
    case 'testnet':
      // This is the program ID for the Orderbook program on devnet and testnet.
      return new PublicKey('coUnmi3oBUtwtd9fjeAvSsJssXh5A5xyPbhpewyzRVF')
    case 'mainnet-beta':
    default:
      return ORDERBOOK_PROGRAM_ID
  }
}
