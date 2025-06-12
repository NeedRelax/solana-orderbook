// 导入 Anchor 框架的所有功能，用于与 Solana 程序交互
import * as anchor from "@coral-xyz/anchor";
// 导入 Anchor 的核心类 Program 和 BN（大整数类）
import { Program, BN } from "@coral-xyz/anchor";
// 导入生成的订单簿程序类型定义（IDL），路径需与项目结构匹配
import { Orderbook } from "../target/types/orderbook";
// 导入 Solana Web3.js 的核心类和常量，用于账户管理、连接和代币操作
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Connection,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
// 导入 SPL Token 程序的常量和方法，用于代币账户的创建、铸造和查询
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";

// 定义测试套件，命名为 "orderbook"
describe("orderbook", () => {
  // --- 设置测试环境 ---
  // 获取 Anchor 的默认提供者（Provider），从环境变量加载钱包和连接
  const provider = anchor.AnchorProvider.env();
  // 设置 Anchor 的提供者，用于后续程序调用
  anchor.setProvider(provider);
  // 获取 Solana 区块链连接对象
  const connection = provider.connection;
  // 获取订单簿程序实例，类型为 Orderbook（来自 IDL）
  const program = anchor.workspace.Orderbook as Program<Orderbook>;
  // 获取测试的支付者钱包（Anchor 钱包实例）
  const payer = provider.wallet as anchor.Wallet;

  // --- 定义测试账户和变量 ---
  // 声明基础代币铸造账户的公钥（稍后初始化）
  let baseMint: PublicKey;
  // 声明报价代币铸造账户的公钥（稍后初始化）
  let quoteMint: PublicKey;
  // 声明订单簿的程序派生地址（PDA）
  let orderbookPDA: PublicKey;
  // 声明基础代币金库的 PDA
  let baseVaultPDA: PublicKey;
  // 声明报价代币金库的 PDA
  let quoteVaultPDA: PublicKey;

  // 生成用户 1 的密钥对（公钥和私钥）
  const user1 = Keypair.generate();
  // 生成用户 2 的密钥对
  const user2 = Keypair.generate();

  // 声明用户 1 的基础代币账户公钥（稍后初始化）
  let user1BaseTokenAccount: PublicKey;
  // 声明用户 1 的报价代币账户公钥
  let user1QuoteTokenAccount: PublicKey;
  // 声明用户 2 的基础代币账户公钥
  let user2BaseTokenAccount: PublicKey;
  // 声明用户 2 的报价代币账户公钥
  let user2QuoteTokenAccount: PublicKey;

  // 定义基础代币的小数位数（例如 USDC 通常为 6）
  const BASE_DECIMALS = 6;
  // 定义报价代币的小数位数
  const QUOTE_DECIMALS = 6;

  // 辅助函数：获取代币账户余额，返回 bigint 类型
  const getTokenBalance = async (tokenAccount: PublicKey): Promise<bigint> => {
    try {
      // 获取代币账户信息
      const accountInfo = await getAccount(connection, tokenAccount);
      // 返回账户的代币余额（amount 字段）
      return accountInfo.amount;
    } catch (e) {
      // 如果账户不存在（可能未初始化），返回 0
      return BigInt(0);
    }
  };

  // 辅助函数：将 UI 数量（例如 10.5）转换为代币最小单位（考虑小数位）
  const toTokenAmount = (amount: number, decimals: number): BN => {
    // 将金额乘以 10^decimals，转换为 BN（大整数）
    return new BN(amount * Math.pow(10, decimals));
  };

  // 辅助函数：将价格转换为合约所需的 u64 格式（BN 类型）
  const toPriceAmount = (price: number): BN => {
    // 直接将价格转换为 BN，无需考虑小数位
    return new BN(price);
  };

  // 定义测试用例：执行完整的订单簿生命周期，设置 60 秒超时
  it(
    "Executes the full orderbook lifecycle",
    async () => {
      // --- 1. 初始化设置 (Setup) ---
      // 打印日志，表示开始设置代币和账户
      console.log("--- 1. Setting up mints and accounts ---");

      // 为用户 1 空投 2 SOL，用于支付交易费用
      await provider.connection.requestAirdrop(user1.publicKey, 2 * LAMPORTS_PER_SOL);
      // 为用户 2 空投 2 SOL
      await provider.connection.requestAirdrop(user2.publicKey, 2 * LAMPORTS_PER_SOL);

      // 创建基础代币（Mint），由 payer 支付费用，权限归 payer
      baseMint = await createMint(connection, payer.payer, payer.publicKey, null, BASE_DECIMALS);
      // 创建报价代币（Mint），由 payer 支付费用
      quoteMint = await createMint(connection, payer.payer, payer.publicKey, null, QUOTE_DECIMALS);

      // 为用户 1 创建基础代币账户，关联 baseMint
      user1BaseTokenAccount = await createAccount(connection, payer.payer, baseMint, user1.publicKey);
      // 为用户 1 创建报价代币账户，关联 quoteMint
      user1QuoteTokenAccount = await createAccount(connection, payer.payer, quoteMint, user1.publicKey);
      // 为用户 2 创建基础代币账户
      user2BaseTokenAccount = await createAccount(connection, payer.payer, baseMint, user2.publicKey);
      // 为用户 2 创建报价代币账户
      user2QuoteTokenAccount = await createAccount(connection, payer.payer, quoteMint, user2.publicKey);

      // 为用户 1 的报价代币账户铸造 10000 单位代币（例如 USDC）
      await mintTo(connection, payer.payer, quoteMint, user1QuoteTokenAccount, payer.payer, toTokenAmount(10000, QUOTE_DECIMALS).toNumber());
      // 为用户 2 的基础代币账户铸造 100 单位代币（例如 BASE）
      await mintTo(connection, payer.payer, baseMint, user2BaseTokenAccount, payer.payer, toTokenAmount(100, BASE_DECIMALS).toNumber());

      // 计算订单簿的 PDA，种子为 "orderbook" + baseMint + quoteMint
      [orderbookPDA] = PublicKey.findProgramAddressSync([Buffer.from("orderbook"), baseMint.toBuffer(), quoteMint.toBuffer()], program.programId);
      // 计算基础代币金库的 PDA，种子为 "base_vault" + orderbookPDA
      [baseVaultPDA] = PublicKey.findProgramAddressSync([Buffer.from("base_vault"), orderbookPDA.toBuffer()], program.programId);
      // 计算报价代币金库的 PDA，种子为 "quote_vault" + orderbookPDA
      [quoteVaultPDA] = PublicKey.findProgramAddressSync([Buffer.from("quote_vault"), orderbookPDA.toBuffer()], program.programId);

      // --- 2. 初始化订单簿 (Initialize) ---
      // 打印日志，表示开始初始化订单簿
      console.log("--- 2. Initializing the orderbook ---");

      // 调用程序的 initialize 方法，初始化订单簿
      await program.methods
        .initialize()
        // 指定所需的账户
        .accounts({
          orderbook: orderbookPDA, // 订单簿 PDA
          baseMint: baseMint, // 基础代币铸造账户
          quoteMint: quoteMint, // 报价代币铸造账户
          baseVault: baseVaultPDA, // 基础代币金库
          quoteVault: quoteVaultPDA, // 报价代币金库
          payer: payer.publicKey, // 支付者账户
          systemProgram: SystemProgram.programId, // 系统程序
          tokenProgram: TOKEN_PROGRAM_ID, // SPL 代币程序
          rent: anchor.web3.SYSVAR_RENT_PUBKEY, // 租金系统变量
        })
        // 执行交易
        .rpc();

      // 获取订单簿账户数据，验证初始化结果
      let orderbookAccount = await program.account.orderbook.fetch(orderbookPDA);
      // 验证订单簿的基础代币是否正确
      expect(orderbookAccount.baseMint.equals(baseMint)).toBe(true);
      // 验证买单列表为空
      expect(orderbookAccount.bids).toEqual([]);
      // 验证卖单列表为空
      expect(orderbookAccount.asks).toEqual([]);

      // --- 3. 场景一：下达一个买单 (Maker) ---
      // 打印日志，表示用户 1 下买单
      console.log("--- 3. User1 places a buy order (Maker) ---");
      // 定义买单价格（10 单位）
      const buyPrice1 = toPriceAmount(10);
      // 定义买单数量（10 单位基础代币）
      const buyQuantity1 = toTokenAmount(10, BASE_DECIMALS);
      // 计算需锁定的报价代币总量（价格 × 数量）
      const totalQuoteToLock = buyPrice1.mul(buyQuantity1);

      // 调用 placeOrder 方法，下买单
      await program.methods
        .placeOrder({ buy: {} }, buyPrice1, buyQuantity1) // 指定买单、价格和数量
        .accounts({
          orderbook: orderbookPDA, // 订单簿 PDA
          owner: user1.publicKey, // 买单拥有者（user1）
          ownerBaseTokenAccount: user1BaseTokenAccount, // user1 的基础代币账户
          ownerQuoteTokenAccount: user1QuoteTokenAccount, // user1 的报价代币账户
          baseVault: baseVaultPDA, // 基础代币金库
          quoteVault: quoteVaultPDA, // 报价代币金库
          tokenProgram: TOKEN_PROGRAM_ID, // SPL 代币程序
        })
        .signers([user1]) // user1 签名交易
        .rpc(); // 执行交易

      // 获取更新后的订单簿数据
      orderbookAccount = await program.account.orderbook.fetch(orderbookPDA);
      // 验证买单列表有一个订单
      expect(orderbookAccount.bids.length).toBe(1);
      // 验证卖单列表为空
      expect(orderbookAccount.asks.length).toBe(0);
      // 验证买单的拥有者是 user1
      expect(orderbookAccount.bids[0].owner.equals(user1.publicKey)).toBe(true);
      // 验证买单价格正确
      expect(orderbookAccount.bids[0].price.eq(buyPrice1)).toBe(true);
      // 获取报价代币金库余额
      const quoteVaultBalance = await getTokenBalance(quoteVaultPDA);
      // 验证金库余额等于锁定的报价代币
      expect(quoteVaultBalance).toBe(BigInt(totalQuoteToLock.toString()));

      // --- 4. 场景二：下达一个卖单，完全撮合 (Taker) ---
      // 打印日志，表示用户 2 下卖单进行完全撮合
      console.log("--- 4. User2 places a sell order to fully match ---");
      // 定义卖单价格（10 单位，与买单匹配）
      const sellPrice1 = toPriceAmount(10);
      // 定义卖单数量（10 单位基础代币）
      const sellQuantity1 = toTokenAmount(10, BASE_DECIMALS);

      // 获取撮合前 user1 的基础代币余额
      const user1BaseBalanceBefore = await getTokenBalance(user1BaseTokenAccount);
      // 获取撮合前 user2 的报价代币余额
      const user2QuoteBalanceBefore = await getTokenBalance(user2QuoteTokenAccount);
      // 调用 placeOrder 方法，下卖单，动态传递 user1 的账户用于撮合
      await program.methods
        .placeOrder({ sell: {} }, sellPrice1, sellQuantity1) // 指定卖单、价格和数量
        .accounts({
          orderbook: orderbookPDA, // 订单簿 PDA
          owner: user2.publicKey, // 卖单拥有者（user2）
          ownerBaseTokenAccount: user2BaseTokenAccount, // user2 的基础代币账户
          ownerQuoteTokenAccount: user2QuoteTokenAccount, // user2 的报价代币账户
          baseVault: baseVaultPDA, // 基础代币金库
          quoteVault: quoteVaultPDA, // 报价代币金库
          tokenProgram: TOKEN_PROGRAM_ID, // SPL 代币程序
        })
        // 动态传递 maker（user1）的账户，用于撮合资金流动
        .remainingAccounts([
          { pubkey: user1BaseTokenAccount, isSigner: false, isWritable: true }, // user1 的基础代币账户
          { pubkey: user1QuoteTokenAccount, isSigner: false, isWritable: true }, // user1 的报价代币账户
        ])
        .signers([user2]) // user2 签名交易
        .rpc(); // 执行交易

      // 获取更新后的订单簿数据
      orderbookAccount = await program.account.orderbook.fetch(orderbookPDA);
      // 验证买单列表为空（已完全撮合）
      expect(orderbookAccount.bids.length).toBe(0);
      // 验证卖单列表为空
      expect(orderbookAccount.asks.length).toBe(0);

      // 获取撮合后 user1 的基础代币余额
      const user1BaseBalanceAfter = await getTokenBalance(user1BaseTokenAccount);
      // 获取撮合后 user2 的报价代币余额
      const user2QuoteBalanceAfter = await getTokenBalance(user2QuoteTokenAccount);

      // 验证 user1 收到基础代币（卖单数量）
      expect(user1BaseBalanceAfter - user1BaseBalanceBefore).toBe(BigInt(sellQuantity1.toString()));
      // 验证 user2 收到报价代币（买单锁定的总量）
      expect(user2QuoteBalanceAfter - user2QuoteBalanceBefore).toBe(BigInt(totalQuoteToLock.toString()));

      // --- 5. 场景三：部分成交，剩余部分成为新挂单 ---
      // 打印日志，表示测试部分撮合场景
      console.log("--- 5. A partial fill creating a new maker order ---");
      // 定义第二个买单价格（12 单位）
      const buyPrice2 = toPriceAmount(12);
      // 定义第二个买单数量（20 单位基础代币）
      const buyQuantity2 = toTokenAmount(20, BASE_DECIMALS);
      // 下第二个买单
      await program.methods
        .placeOrder({ buy: {} }, buyPrice2, buyQuantity2)
        .accounts({
          orderbook: orderbookPDA, // 订单簿 PDA
          owner: user1.publicKey, // 买单拥有者（user1）
          ownerBaseTokenAccount: user1BaseTokenAccount, // user1 的基础代币账户
          ownerQuoteTokenAccount: user1QuoteTokenAccount, // user1 的报价代币账户
          baseVault: baseVaultPDA, // 基础代币金库
          quoteVault: quoteVaultPDA, // 报价代币金库
          tokenProgram: TOKEN_PROGRAM_ID, // SPL 代币程序
        })
        .signers([user1]) // user1 签名
        .rpc(); // 执行交易

      // 定义第二个卖单价格（11 单位，可与买单撮合）
      const sellPrice2 = toPriceAmount(11);
      // 定义第二个卖单数量（5 单位基础代币，部分撮合）
      const sellQuantity2 = toTokenAmount(5, BASE_DECIMALS);
      // 下第二个卖单，部分撮合买单
      await program.methods
        .placeOrder({ sell: {} }, sellPrice2, sellQuantity2)
        .accounts({
          orderbook: orderbookPDA, // 订单簿 PDA
          owner: user2.publicKey, // 卖单拥有者（user2）
          ownerBaseTokenAccount: user2BaseTokenAccount, // user2 的基础代币账户
          ownerQuoteTokenAccount: user2QuoteTokenAccount, // user2 的报价代币账户
          baseVault: baseVaultPDA, // 基础代币金库
          quoteVault: quoteVaultPDA, // 报价代币金库
          tokenProgram: TOKEN_PROGRAM_ID, // SPL 代币程序
        })
        // 动态传递 user1 的账户用于撮合
        .remainingAccounts([
          { pubkey: user1BaseTokenAccount, isSigner: false, isWritable: true },
          { pubkey: user1QuoteTokenAccount, isSigner: false, isWritable: true },
        ])
        .signers([user2]) // user2 签名
        .rpc(); // 执行交易

      // 获取更新后的订单簿数据
      orderbookAccount = await program.account.orderbook.fetch(orderbookPDA);
      // 验证买单列表有一个剩余订单
      expect(orderbookAccount.bids.length).toBe(1);
      // 验证卖单列表为空
      expect(orderbookAccount.asks.length).toBe(0);

      // 计算剩余买单数量（20 - 5 = 15）
      const remainingBuyQuantity = buyQuantity2.sub(sellQuantity2);
      // 验证剩余买单数量正确
      expect(orderbookAccount.bids[0].quantity.eq(remainingBuyQuantity)).toBe(true);

      // 获取要取消的订单 ID
      const orderIdToCancel = orderbookAccount.bids[0].orderId;

      // --- 6. 场景四：取消订单 (Cancel Order) ---
      // 打印日志，表示测试取消订单
      console.log("--- 6. Cancelling the remaining order ---");
      // 获取取消前 user1 的报价代币余额
      const user1QuoteBalanceBeforeCancel = await getTokenBalance(user1QuoteTokenAccount);
      // 获取取消前报价代币金库余额
      const quoteVaultBalanceBeforeCancel = await getTokenBalance(quoteVaultPDA);

      // 调用 cancelOrder 方法，取消剩余买单
      await program.methods
        .cancelOrder(orderIdToCancel)
        .accounts({
          orderbook: orderbookPDA, // 订单簿 PDA
          owner: user1.publicKey, // 订单拥有者（user1）
          ownerBaseTokenAccount: user1BaseTokenAccount, // user1 的基础代币账户
          ownerQuoteTokenAccount: user1QuoteTokenAccount, // user1 的报价代币账户
          baseVault: baseVaultPDA, // 基础代币金库
          quoteVault: quoteVaultPDA, // 报价代币金库
          tokenProgram: TOKEN_PROGRAM_ID, // SPL 代币程序
        })
        .signers([user1]) // user1 签名
        .rpc(); // 执行交易

      // 获取更新后的订单簿数据
      orderbookAccount = await program.account.orderbook.fetch(orderbookPDA);
      // 验证买单列表为空（订单已取消）
      expect(orderbookAccount.bids.length).toBe(0);

      // 获取取消后 user1 的报价代币余额
      const user1QuoteBalanceAfterCancel = await getTokenBalance(user1QuoteTokenAccount);
      // 获取取消后报价代币金库余额
      const quoteVaultBalanceAfterCancel = await getTokenBalance(quoteVaultPDA);

      // 计算应退还的报价代币（价格 × 剩余数量）
      const quoteToRefund = buyPrice2.mul(remainingBuyQuantity);
      // 验证 user1 收到退还的报价代币
      expect(user1QuoteBalanceAfterCancel - user1QuoteBalanceBeforeCancel).toBe(BigInt(quoteToRefund.toString()));
      // 验证金库减少的代币等于退还量
      expect(quoteVaultBalanceBeforeCancel - quoteVaultBalanceAfterCancel).toBe(BigInt(quoteToRefund.toString()));

      // --- 7. 场景五：测试失败情况 (Error Handling) ---
      // 打印日志，表示测试错误处理
      console.log("--- 7. Testing failure cases ---");

      // 测试取消不存在的订单（ID 9999），预期抛出 OrderNotFound 错误
      await expect(
        program.methods
          .cancelOrder(new BN(9999))
          .accounts({
            orderbook: orderbookPDA,
            owner: user1.publicKey,
            ownerBaseTokenAccount: user1BaseTokenAccount,
            ownerQuoteTokenAccount: user1QuoteTokenAccount,
            baseVault: baseVaultPDA,
            quoteVault: quoteVaultPDA,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([user1])
          .rpc()
      ).rejects.toThrow(/OrderNotFound/);

      // 下达一个卖单（价格 15，数量 2）
      const sellPrice3 = toPriceAmount(15);
      const sellQuantity3 = toTokenAmount(2, BASE_DECIMALS);
      await program.methods
        .placeOrder({ sell: {} }, sellPrice3, sellQuantity3)
        .accounts({
          orderbook: orderbookPDA,
          owner: user2.publicKey,
          ownerBaseTokenAccount: user2BaseTokenAccount,
          ownerQuoteTokenAccount: user2QuoteTokenAccount,
          baseVault: baseVaultPDA,
          quoteVault: quoteVaultPDA,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user2])
        .rpc();

      // 获取订单簿数据，提取 user2 的卖单 ID
      orderbookAccount = await program.account.orderbook.fetch(orderbookPDA);
      const user2OrderId = orderbookAccount.asks[0].orderId;

      // 测试 user1 尝试取消 user2 的订单，预期抛出 OrderNotOwned 错误
      await expect(
        program.methods
          .cancelOrder(user2OrderId)
          .accounts({
            orderbook: orderbookPDA,
            owner: user1.publicKey,
            ownerBaseTokenAccount: user1BaseTokenAccount,
            ownerQuoteTokenAccount: user1QuoteTokenAccount,
            baseVault: baseVaultPDA,
            quoteVault: quoteVaultPDA,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([user1])
          .rpc()
      ).rejects.toThrow(/OrderNotOwned/);
    },
    60000 // 设置测试超时时间为 60 秒
  );
});