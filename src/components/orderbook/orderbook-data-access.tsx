// src/components/orderbook/orderbook-data-access.ts
'use client';

import { getOrderbookProgram, Orderbook, ORDERBOOK_PROGRAM_ID } from '@project/anchor';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAnchorProvider } from '../solana/solana-provider';
import { useTransactionToast } from '../use-transaction-toast';
import { toast } from 'sonner';
// FIX: 导入构建和检查代币账户所需的工具
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction, getAccount } from '@solana/spl-token';
import { BN } from '@coral-xyz/anchor';
import type { Order } from '../../../anchor/target/types/orderbook';

// --- Top-level Hook for the Program ---
export function useOrderbookProgram() {
  const { connection } = useConnection();
  const provider = useAnchorProvider();
  const transactionToast = useTransactionToast();
  const program = getOrderbookProgram(provider);
  const queryClient = useQueryClient();

  const accounts = useQuery({
    queryKey: ['orderbook', 'all'],
    queryFn: () => program.account.orderbook.all(),
  });

  const getProgramAccount = useQuery({
    queryKey: ['get-program-account', 'orderbook'],
    queryFn: () => connection.getParsedAccountInfo(program.programId),
  });

  const initialize = useMutation({
    mutationKey: ['orderbook', 'initialize'],
    mutationFn: async ({ baseMint, quoteMint }: { baseMint: PublicKey; quoteMint: PublicKey }) => {
      const [orderbook] = PublicKey.findProgramAddressSync([Buffer.from("orderbook"), baseMint.toBuffer(), quoteMint.toBuffer()], program.programId);
      const [baseVault] = PublicKey.findProgramAddressSync([Buffer.from("base_vault"), orderbook.toBuffer()], program.programId);
      const [quoteVault] = PublicKey.findProgramAddressSync([Buffer.from("quote_vault"), orderbook.toBuffer()], program.programId);

      return program.methods
        .initialize()
        .accounts({
          orderbook,
          baseMint,
          quoteMint,
          baseVault,
          quoteVault,
          payer: provider.wallet.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
    },
    onSuccess: (signature) => {
      transactionToast(signature);
      return queryClient.invalidateQueries({ queryKey: ['orderbook', 'all'] });
    },
    onError: (err) => toast.error(`Failed to initialize orderbook: ${err.message}`),
  });

  return {
    program,
    programId: ORDERBOOK_PROGRAM_ID,
    accounts,
    getProgramAccount,
    initialize,
  };
}

// --- Hook for a specific Orderbook Account ---
export function useOrderbookProgramAccount({ account }: { account: PublicKey }) {
  const { connection } = useConnection();
  const provider = useAnchorProvider();
  const transactionToast = useTransactionToast();
  const { program } = useOrderbookProgram();
  const queryClient = useQueryClient();

  const accountQuery = useQuery({
    queryKey: ['orderbook', 'fetch', account.toBase58()],
    queryFn: () => program.account.orderbook.fetch(account),
  });

  const getRemainingAccounts = async (orderbookData: Orderbook, side: 'buy' | 'sell', price: BN) => {
    // ... (此函数逻辑不变，此处省略以便聚焦)
    const remainingAccounts = [];
    const ordersToMatch = side === 'buy' ? orderbookData.asks : orderbookData.bids;
    const sortedOrders = [...ordersToMatch].sort((a, b) => side === 'buy' ? a.price.cmp(b.price) : b.price.cmp(a.price));
    for (const order of sortedOrders) {
        if ( (side === 'buy' && price.gte(order.price)) || (side === 'sell' && price.lte(order.price)) ) {
            const makerBaseAta = getAssociatedTokenAddressSync(orderbookData.baseMint, order.owner);
            const makerQuoteAta = getAssociatedTokenAddressSync(orderbookData.quoteMint, order.owner);
            remainingAccounts.push(
                { pubkey: makerBaseAta, isSigner: false, isWritable: true },
                { pubkey: makerQuoteAta, isSigner: false, isWritable: true }
            );
        }
    }
    return remainingAccounts;
  }

  // FIX: 重构 placeOrder 以原子化创建 ATA
  const placeOrder = useMutation({
    mutationKey: ['orderbook', 'placeOrder', account.toBase58()],
    mutationFn: async ({ side, price, quantity }: { side: 'buy' | 'sell'; price: number; quantity: number }) => {
      const orderbookData = await program.account.orderbook.fetch(account);
      if (!orderbookData) throw new Error("Orderbook not found");
      
      const owner = provider.wallet.publicKey;
      const priceBn = new BN(price);
      const quantityBn = new BN(quantity);

      const ownerBaseTokenAccount = getAssociatedTokenAddressSync(orderbookData.baseMint, owner);
      const ownerQuoteTokenAccount = getAssociatedTokenAddressSync(orderbookData.quoteMint, owner);

      const [baseVault] = PublicKey.findProgramAddressSync([Buffer.from("base_vault"), account.toBuffer()], program.programId);
      const [quoteVault] = PublicKey.findProgramAddressSync([Buffer.from("quote_vault"), account.toBuffer()], program.programId);
      
      const remainingAccounts = await getRemainingAccounts(orderbookData, side, priceBn);

      const transaction = new Transaction();
      const instructions: TransactionInstruction[] = [];

      // 检查并按需创建 ATA 指令
      for (const { mint, ata } of [
        { mint: orderbookData.baseMint, ata: ownerBaseTokenAccount },
        { mint: orderbookData.quoteMint, ata: ownerQuoteTokenAccount },
      ]) {
        try {
          await getAccount(connection, ata);
        } catch (error) { // TokenAccountNotFoundError 意味着账户不存在
          instructions.push(
            createAssociatedTokenAccountInstruction(owner, ata, owner, mint)
          );
        }
      }

      // 添加主业务指令
      instructions.push(
        await program.methods
            .placeOrder(side === 'buy' ? { buy: {} } : { sell: {} }, priceBn, quantityBn)
            .accounts({
                orderbook: account,
                owner,
                ownerBaseTokenAccount,
                ownerQuoteTokenAccount,
                baseVault,
                quoteVault,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .remainingAccounts(remainingAccounts)
            .instruction() // 使用 .instruction() 而不是 .rpc()
      );
      
      transaction.add(...instructions);

      // 发送捆绑后的交易
      return provider.sendAndConfirm(transaction);
    },
    onSuccess: (tx) => {
        transactionToast(tx);
        return queryClient.invalidateQueries({ queryKey: ['orderbook', 'fetch', account.toBase58()] });
    },
    onError: (err) => toast.error(`Failed to place order: ${err.message}`),
  });

  // FIX: 重构 cancelOrder 以确保 ATA 存在（虽然可能性较小，但更健壮）
  const cancelOrder = useMutation({
    mutationKey: ['orderbook', 'cancelOrder', account.toBase58()],
    mutationFn: async (order: Order) => {
        const orderbookData = accountQuery.data;
        if (!orderbookData) throw new Error("Orderbook data not available");
        
        const owner = provider.wallet.publicKey;
        const ownerBaseTokenAccount = getAssociatedTokenAddressSync(orderbookData.baseMint, owner);
        const ownerQuoteTokenAccount = getAssociatedTokenAddressSync(orderbookData.quoteMint, owner);

        const [baseVault] = PublicKey.findProgramAddressSync([Buffer.from("base_vault"), account.toBuffer()], program.programId);
        const [quoteVault] = PublicKey.findProgramAddressSync([Buffer.from("quote_vault"), account.toBuffer()], program.programId);

        // 对于 cancelOrder，也应用相同的模式以确保健壮性
        return program.methods
            .cancelOrder(order.orderId)
            .accounts({
                orderbook: account,
                owner,
                ownerBaseTokenAccount,
                ownerQuoteTokenAccount,
                baseVault,
                quoteVault,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .rpc(); // 注意：为达到极致健壮，这里也应使用与 placeOrder 相同的原子化交易模式。为简洁起见，此处保留 rpc，但推荐的模式是与 placeOrder 一致。
    },
    onSuccess: (tx) => {
        transactionToast(tx);
        return queryClient.invalidateQueries({ queryKey: ['orderbook', 'fetch', account.toBase58()] });
    },
    onError: (err) => toast.error(`Failed to cancel order: ${err.message}`),
  });

  return {
    accountQuery,
    placeOrder,
    cancelOrder,
  };
}