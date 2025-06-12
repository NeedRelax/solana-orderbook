// src/components/orderbook/orderbook-ui.tsx
'use client';

import { PublicKey } from '@solana/web3.js';
import { FormEvent, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { ExplorerLink } from '../cluster/cluster-ui';
import { useOrderbookProgram, useOrderbookProgramAccount } from './orderbook-data-access';
import { ellipsify } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Order } from '../../../anchor/target/types/orderbook';
import { toast } from 'sonner'; // 假设你使用了 sonner 或 react-hot-toast

// --- Component to Create a New Orderbook ---
export function OrderbookCreate({ onCreate }: { onCreate: (pk: PublicKey) => void }) {
  // FIX 1: 从 hook 中同时解构出 program 对象
  const { initialize, program } = useOrderbookProgram();
  const [baseMint, setBaseMint] = useState('');
  const [quoteMint, setQuoteMint] = useState('');

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!program) {
        toast.error("Program not initialized. Please connect your wallet and refresh.");
        return;
    }

    try {
      const baseMintPk = new PublicKey(baseMint);
      const quoteMintPk = new PublicKey(quoteMint);

      initialize.mutateAsync({ baseMint: baseMintPk, quoteMint: quoteMintPk })
        .then(() => {
          toast.success("Transaction sent! Waiting for confirmation...");
          // 在交易成功后计算 PDA
          const [orderbookPk] = PublicKey.findProgramAddressSync(
            [Buffer.from("orderbook"), baseMintPk.toBuffer(), quoteMintPk.toBuffer()],
            // FIX 2: 直接使用 program.programId
            program.programId
          );
          onCreate(orderbookPk);
        })
        .catch(err => {
            // 更好地处理异步 mutation 的错误
            toast.error(`Failed to create orderbook: ${(err as Error).message}`);
        });

    } catch (err) {
      toast.error(`Invalid public key: ${(err as Error).message}`);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create New Orderbook</CardTitle>
        <CardDescription>Enter the mint addresses for the base and quote tokens to create a new market.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <Input placeholder="Base Token Mint Address" value={baseMint} onChange={(e) => setBaseMint(e.target.value)} required />
          <Input placeholder="Quote Token Mint Address" value={quoteMint} onChange={(e) => setQuoteMint(e.target.value)} required />
          <Button type="submit" disabled={initialize.isPending || !baseMint || !quoteMint}>
            {initialize.isPending ? 'Creating...' : 'Create Orderbook'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

// --- Component to List Available Orderbooks ---
export function OrderbookList({ onSelect }: { onSelect: (pk: PublicKey) => void }) {
  const { accounts, getProgramAccount } = useOrderbookProgram();

  if (getProgramAccount.isLoading) {
    return <div className="flex justify-center"><span className="loading loading-spinner loading-lg"></span></div>;
  }
  if (!getProgramAccount.data?.value) {
    return (
      <div className="alert alert-info flex justify-center">
        <span>Program account not found. Make sure you have deployed the program.</span>
      </div>
    );
  }

  return (
    <div className={'space-y-6'}>
      {accounts.isLoading ? (
        <div className="flex justify-center"><span className="loading loading-spinner loading-lg"></span></div>
      ) : accounts.data?.length ? (
        <div className="grid md:grid-cols-2 gap-4">
          {accounts.data.map((account) => (
            <Card key={account.publicKey.toString()} className="cursor-pointer hover:bg-muted/50" onClick={() => onSelect(account.publicKey)}>
              <CardHeader>
                <CardTitle>Market</CardTitle>
                <CardDescription>Orderbook: {ellipsify(account.publicKey.toString())}</CardDescription>
              </CardHeader>
              <CardContent className="text-sm space-y-2">
                <p><strong>Base Mint:</strong> {ellipsify(account.account.baseMint.toString())}</p>
                <p><strong>Quote Mint:</strong> {ellipsify(account.account.quoteMint.toString())}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <div className="text-center py-8">
          <h2 className={'text-2xl'}>No Orderbooks Found</h2>
          <p>Create one above to get started.</p>
        </div>
      )}
    </div>
  );
}

// --- Component for the main trading interface ---
export function OrderbookView({ account }: { account: PublicKey }) {
  const { accountQuery } = useOrderbookProgramAccount({ account });

  if (accountQuery.isLoading) {
    return <div className="flex justify-center py-8"><span className="loading loading-spinner loading-lg"></span></div>;
  }
  if (!accountQuery.data) {
    return <div className="alert alert-error">Failed to load orderbook data.</div>;
  }
  
  const { bids, asks } = accountQuery.data;

  return (
      <Card>
          <CardHeader>
              <CardTitle>Trading Interface</CardTitle>
              <CardDescription>
                  Orderbook: <ExplorerLink path={`account/${account.toString()}`} label={ellipsify(account.toString())} />
              </CardDescription>
          </CardHeader>
          <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="md:col-span-2 grid grid-cols-2 gap-4">
                     <OrderTable title="Asks (Sell Orders)" orders={asks} type="ask" orderbookAccount={account} />
                     <OrderTable title="Bids (Buy Orders)" orders={bids} type="bid" orderbookAccount={account} />
                  </div>
                  <div className="md:col-span-1">
                      <PlaceOrderForm account={account} />
                  </div>
              </div>
          </CardContent>
      </Card>
  );
}

// --- Component to Display Bids or Asks Table ---
function OrderTable({ title, orders, type, orderbookAccount }: { title: string; orders: Order[]; type: 'bid' | 'ask'; orderbookAccount: PublicKey }) {
  const { publicKey } = useWallet();
  const { cancelOrder } = useOrderbookProgramAccount({ account: orderbookAccount });

  const sortedOrders = [...orders].sort((a, b) => {
    return type === 'ask' ? a.price.cmp(b.price) : b.price.cmp(a.price);
  });

  return (
    <div>
      <h3 className="text-lg font-semibold mb-2">{title}</h3>
      <div className="overflow-x-auto">
        <table className="table table-sm w-full">
          <thead>
            <tr>
              <th>Price</th>
              <th>Quantity</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {sortedOrders.length > 0 ? sortedOrders.map((order) => (
              <tr key={order.orderId.toString()}>
                <td>{order.price.toString()}</td>
                <td>{order.quantity.toString()}</td>
                <td>
                  {publicKey && order.owner.equals(publicKey) && (
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => cancelOrder.mutateAsync(order)}
                      disabled={cancelOrder.isPending && cancelOrder.variables?.orderId.eq(order.orderId)}
                    >
                      {cancelOrder.isPending && cancelOrder.variables?.orderId.eq(order.orderId) ? '...' : 'Cancel'}
                    </Button>
                  )}
                </td>
              </tr>
            )) : <tr><td colSpan={3} className="text-center">No orders</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// --- Component for the Place Order Form ---
function PlaceOrderForm({ account }: { account: PublicKey }) {
  const { placeOrder } = useOrderbookProgramAccount({ account });
  const [price, setPrice] = useState('');
  const [quantity, setQuantity] = useState('');

  const handleSubmit = (e: FormEvent, side: 'buy' | 'sell') => {
    e.preventDefault();
    placeOrder.mutateAsync({
      side,
      price: Number(price),
      quantity: Number(quantity),
    });
  };

  return (
    <Tabs defaultValue="buy" className="w-full">
      <TabsList className="grid w-full grid-cols-2">
        <TabsTrigger value="buy">Buy</TabsTrigger>
        <TabsTrigger value="sell">Sell</TabsTrigger>
      </TabsList>
      <TabsContent value="buy">
        <form onSubmit={(e) => handleSubmit(e, 'buy')} className="space-y-4 p-4 border rounded-md">
           <Input type="number" placeholder="Price" value={price} onChange={(e) => setPrice(e.target.value)} required />
           <Input type="number" placeholder="Quantity" value={quantity} onChange={(e) => setQuantity(e.target.value)} required />
           <Button type="submit" className="w-full bg-green-600 hover:bg-green-700" disabled={placeOrder.isPending}>
            {placeOrder.isPending ? 'Placing...' : 'Place Buy Order'}
           </Button>
        </form>
      </TabsContent>
      <TabsContent value="sell">
         <form onSubmit={(e) => handleSubmit(e, 'sell')} className="space-y-4 p-4 border rounded-md">
           <Input type="number" placeholder="Price" value={price} onChange={(e) => setPrice(e.target.value)} required />
           <Input type="number" placeholder="Quantity" value={quantity} onChange={(e) => setQuantity(e.target.value)} required />
           <Button type="submit" className="w-full" variant="destructive" disabled={placeOrder.isPending}>
            {placeOrder.isPending ? 'Placing...' : 'Place Sell Order'}
           </Button>
        </form>
      </TabsContent>
    </Tabs>
  );
}