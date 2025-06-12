'use client'

import { useWallet } from '@solana/wallet-adapter-react'
import { WalletButton } from '../solana/solana-provider'
import { AppHero } from '../app-hero'
import { PublicKey } from '@solana/web3.js';
import { OrderbookCreate, OrderbookList, OrderbookView } from './orderbook-ui';
import { useOrderbookProgram } from './orderbook-data-access';
import { ExplorerLink } from '../cluster/cluster-ui';
import { ellipsify } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { useState } from 'react';

export default function OrderbookFeature() {
  const { publicKey } = useWallet();
  const { programId } = useOrderbookProgram();
  const [selectedAccount, setSelectedAccount] = useState<PublicKey | undefined>();

  if (!publicKey) {
    return (
      <div className="max-w-4xl mx-auto">
        <div className="hero py-[64px]">
          <div className="hero-content text-center">
            <WalletButton />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <AppHero
        title="Orderbook DEX"
        subtitle="Create a new orderbook market or interact with an existing one."
      >
        <p className="mb-6">
          Program ID: <ExplorerLink path={`account/${programId.toString()}`} label={ellipsify(programId.toString())} />
        </p>
        {selectedAccount && (
          <Button variant="outline" onClick={() => setSelectedAccount(undefined)}>
            ← Back to List
          </Button>
        )}
      </AppHero>

      {selectedAccount ? (
        <OrderbookView account={selectedAccount} />
      ) : (
        <div className="space-y-8">
          <OrderbookCreate onCreate={(pk) => {
            toast.success("Orderbook created successfully!");
            setSelectedAccount(pk);
          }} />
          <OrderbookList onSelect={(pk) => setSelectedAccount(pk)} />
        </div>
      )}
    </div>
  );
}