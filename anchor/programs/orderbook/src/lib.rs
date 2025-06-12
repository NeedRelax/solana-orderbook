// 允许 clippy 忽略大型错误类型的警告，优化编译
#![allow(clippy::result_large_err)]

// 导入 Anchor 框架核心模块，提供账户管理、错误处理等功能
use anchor_lang::prelude::*;
// 导入 Anchor 的 SPL Token 模块，支持代币操作（如转移、铸造）
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
// 导入 Peekable 迭代器，用于预览 remaining_accounts 中的账户
use std::iter::Peekable;
// 导入 Iter，用于遍历 remaining_accounts
use std::slice::Iter;
// 导入 Account 类型，用于手动反序列化账户信息
use anchor_lang::accounts::account::Account;

// 声明程序 ID，与部署的程序 ID 保持一致
declare_id!("2LoSwHzHBVco5nzB6gFyF17DEtd8BhtAwEduHDyv6Nsv");

// 定义 orderbook 程序模块
#[program]
pub mod orderbook {
    use super::*;

    // 初始化订单簿，设置基础代币、报价代币及初始订单数据
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let orderbook = &mut ctx.accounts.orderbook;
        orderbook.base_mint = ctx.accounts.base_mint.key(); // 设置基础代币公钥
        orderbook.quote_mint = ctx.accounts.quote_mint.key(); // 设置报价代币公钥
        orderbook.bids = Vec::new(); // 初始化买单列表
        orderbook.asks = Vec::new(); // 初始化卖单列表
        orderbook.order_id_counter = 0; // 初始化订单 ID 计数器
        Ok(())
    }

    // 下单函数，处理买入或卖出订单
    pub fn place_order<'info>(
        ctx: Context<'_, '_, 'info, 'info, PlaceOrder<'info>>,
        side: Side,    // 订单方向（买/卖）
        price: u64,    // 订单价格
        quantity: u64, // 订单数量
    ) -> Result<()> {
        let orderbook = &mut ctx.accounts.orderbook; // 可变引用订单簿
        let owner = &ctx.accounts.owner; // 订单拥有者
        let token_program = &ctx.accounts.token_program; // 代币程序

        // 创建 taker 订单，初始化订单信息
        let mut taker_order = Order {
            owner: owner.key(),
            price,
            quantity,
            order_id: 0,
        };

        // 1. 锁定资金
        match side {
            Side::Buy => {
                // 计算买入订单需锁定的报价代币总量
                let total_quote_to_lock = taker_order
                    .price
                    .checked_mul(taker_order.quantity)
                    .ok_or(DexError::CalculationError)?;
                // 执行代币转移，从用户账户到报价金库
                token::transfer(
                    CpiContext::new(
                        token_program.to_account_info(),
                        Transfer {
                            from: ctx.accounts.owner_quote_token_account.to_account_info(),
                            to: ctx.accounts.quote_vault.to_account_info(),
                            authority: owner.to_account_info(),
                        },
                    ),
                    total_quote_to_lock,
                )?;
            }
            Side::Sell => {
                // 执行代币转移，从用户账户到基础金库
                token::transfer(
                    CpiContext::new(
                        token_program.to_account_info(),
                        Transfer {
                            from: ctx.accounts.owner_base_token_account.to_account_info(),
                            to: ctx.accounts.base_vault.to_account_info(),
                            authority: owner.to_account_info(),
                        },
                    ),
                    taker_order.quantity,
                )?;
            }
        }

        // 设置订单簿种子和签名者
        let base_mint_key = orderbook.base_mint;
        let quote_mint_key = orderbook.quote_mint;
        let orderbook_bump = ctx.bumps.orderbook;
        let orderbook_seeds = &[
            b"orderbook".as_ref(),
            base_mint_key.as_ref(),
            quote_mint_key.as_ref(),
            &[orderbook_bump],
        ];
        let signer = &[&orderbook_seeds[..]];

        // 2. 核心撮合逻辑
        match side {
            Side::Buy => {
                // 循环处理买单撮合
                while taker_order.quantity > 0 {
                    // 获取最佳卖单价格
                    let best_ask_price = match orderbook.asks.last() {
                        Some(order) => order.price,
                        None => break, // 无卖单，退出
                    };

                    // 如果买单价格低于最佳卖单价格，退出
                    if taker_order.price < best_ask_price {
                        break;
                    }

                    // 弹出最佳卖单进行撮合
                    let mut maker_order = orderbook.asks.pop().unwrap();
                    let maker_accounts =
                        get_next_maker_accounts(&mut ctx.remaining_accounts.iter().peekable())?;

                    // 验证 maker 账户所有者匹配
                    require_keys_eq!(
                        maker_accounts.owner_token_account.owner,
                        maker_order.owner,
                        DexError::MakerAccountMismatch
                    );

                    // 计算交易数量（取最小值）
                    let trade_quantity = taker_order.quantity.min(maker_order.quantity);
                    let trade_price = maker_order.price;
                    // 计算报价代币转移总量
                    let total_quote_transfer = trade_price
                        .checked_mul(trade_quantity)
                        .ok_or(DexError::CalculationError)?;

                    // 转移基础代币给 taker
                    token::transfer(
                        CpiContext::new_with_signer(
                            token_program.to_account_info(),
                            Transfer {
                                from: ctx.accounts.base_vault.to_account_info(),
                                to: ctx.accounts.owner_base_token_account.to_account_info(),
                                authority: orderbook.to_account_info(),
                            },
                            signer,
                        ),
                        trade_quantity,
                    )?;

                    // 转移报价代币给 maker
                    token::transfer(
                        CpiContext::new_with_signer(
                            token_program.to_account_info(),
                            Transfer {
                                from: ctx.accounts.quote_vault.to_account_info(),
                                to: maker_accounts.quote_token_account.to_account_info(),
                                authority: orderbook.to_account_info(),
                            },
                            signer,
                        ),
                        total_quote_transfer,
                    )?;

                    // 触发交易事件
                    emit!(TradeEvent {
                        taker: owner.key(),
                        maker: maker_order.owner,
                        base_mint: base_mint_key,
                        quote_mint: quote_mint_key,
                        quantity: trade_quantity,
                        price: trade_price,
                    });

                    // 更新订单数量
                    taker_order.quantity -= trade_quantity;
                    maker_order.quantity -= trade_quantity;

                    // 如果 maker 订单仍有剩余，重新加入订单簿
                    if maker_order.quantity > 0 {
                        orderbook.asks.push(maker_order);
                    }
                }
            }
            Side::Sell => {
                // 循环处理卖单撮合
                while taker_order.quantity > 0 {
                    // 获取最佳买单价格
                    let best_bid_price = match orderbook.bids.last() {
                        Some(order) => order.price,
                        None => break, // 无买单，退出
                    };

                    // 如果卖单价格高于最佳买单价格，退出
                    if taker_order.price > best_bid_price {
                        break;
                    }

                    // 弹出最佳买单进行撮合
                    let mut maker_order = orderbook.bids.pop().unwrap();
                    let maker_accounts =
                        get_next_maker_accounts(&mut ctx.remaining_accounts.iter().peekable())?;

                    // 验证 maker 账户所有者匹配
                    require_keys_eq!(
                        maker_accounts.owner_token_account.owner,
                        maker_order.owner,
                        DexError::MakerAccountMismatch
                    );

                    // 计算交易数量（取最小值）
                    let trade_quantity = taker_order.quantity.min(maker_order.quantity);
                    let trade_price = maker_order.price;
                    // 计算报价代币转移总量
                    let total_quote_transfer = trade_price
                        .checked_mul(trade_quantity)
                        .ok_or(DexError::CalculationError)?;

                    // 转移基础代币给 maker
                    token::transfer(
                        CpiContext::new_with_signer(
                            token_program.to_account_info(),
                            Transfer {
                                from: ctx.accounts.base_vault.to_account_info(),
                                to: maker_accounts.owner_token_account.to_account_info(),
                                authority: orderbook.to_account_info(),
                            },
                            signer,
                        ),
                        trade_quantity,
                    )?;

                    // 转移报价代币给 taker
                    token::transfer(
                        CpiContext::new_with_signer(
                            token_program.to_account_info(),
                            Transfer {
                                from: ctx.accounts.quote_vault.to_account_info(),
                                to: ctx.accounts.owner_quote_token_account.to_account_info(),
                                authority: orderbook.to_account_info(),
                            },
                            signer,
                        ),
                        total_quote_transfer,
                    )?;

                    // 触发交易事件
                    emit!(TradeEvent {
                        taker: owner.key(),
                        maker: maker_order.owner,
                        base_mint: base_mint_key,
                        quote_mint: quote_mint_key,
                        quantity: trade_quantity,
                        price: trade_price,
                    });

                    // 更新订单数量
                    taker_order.quantity -= trade_quantity;
                    maker_order.quantity -= trade_quantity;

                    // 如果 maker 订单仍有剩余，重新加入订单簿
                    if maker_order.quantity > 0 {
                        orderbook.bids.push(maker_order);
                    }
                }
            }
        }

        // 3. 添加剩余订单到订单簿
        if taker_order.quantity > 0 {
            orderbook.order_id_counter += 1; // 增加订单 ID
            let new_maker_order = Order {
                owner: taker_order.owner,
                price: taker_order.price,
                quantity: taker_order.quantity,
                order_id: orderbook.order_id_counter,
            };
            match side {
                Side::Buy => orderbook.bids.push(new_maker_order), // 添加到买单列表
                Side::Sell => orderbook.asks.push(new_maker_order), // 添加到卖单列表
            };
        }

        // 4. 重新排序订单簿，买单按价格降序，卖单按价格升序
        orderbook.bids.sort_by(|a, b| b.price.cmp(&a.price));
        orderbook.asks.sort_by(|a, b| a.price.cmp(&b.price));

        Ok(())
    }

    // 取消订单，退还锁定资金
    pub fn cancel_order(ctx: Context<CancelOrder>, order_id: u64) -> Result<()> {
        let orderbook = &mut ctx.accounts.orderbook; // 可变引用订单簿
        let owner = &ctx.accounts.owner; // 订单拥有者

        // 设置订单簿种子和签名者
        let orderbook_seeds = &[
            b"orderbook".as_ref(),
            orderbook.base_mint.as_ref(),
            orderbook.quote_mint.as_ref(),
            &[ctx.bumps.orderbook],
        ];
        let signer = &[&orderbook_seeds[..]];

        // 查找并取消买单
        if let Some(index) = orderbook.bids.iter().position(|o| o.order_id == order_id) {
            let order_to_cancel = &orderbook.bids[index];
            // 验证订单拥有者
            require!(
                order_to_cancel.owner == owner.key(),
                DexError::OrderNotOwned
            );

            // 计算需退还的报价代币总量
            let total_quote_amount = order_to_cancel
                .price
                .checked_mul(order_to_cancel.quantity)
                .ok_or(DexError::CalculationError)?;

            // 退还报价代币
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.quote_vault.to_account_info(),
                        to: ctx.accounts.owner_quote_token_account.to_account_info(),
                        authority: orderbook.to_account_info(),
                    },
                    signer,
                ),
                total_quote_amount,
            )?;

            orderbook.bids.remove(index); // 从买单列表移除
            return Ok(());
        }

        // 查找并取消卖单
        if let Some(index) = orderbook.asks.iter().position(|o| o.order_id == order_id) {
            let order_to_cancel = &orderbook.asks[index];
            // 验证订单拥有者
            require!(
                order_to_cancel.owner == owner.key(),
                DexError::OrderNotOwned
            );

            // 退还基础代币
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.base_vault.to_account_info(),
                        to: ctx.accounts.owner_base_token_account.to_account_info(),
                        authority: orderbook.to_account_info(),
                    },
                    signer,
                ),
                order_to_cancel.quantity,
            )?;

            orderbook.asks.remove(index); // 从卖单列表移除
            return Ok(());
        }

        // 订单未找到，返回错误
        Err(DexError::OrderNotFound.into())
    }
}

// 从 remaining_accounts 获取 maker 账户信息
fn get_next_maker_accounts<'info>(
    iter: &mut Peekable<Iter<'info, AccountInfo<'info>>>,
) -> Result<MakerAccounts<'info>> {
    let owner_token_account_info = next_account_info(iter)?; // 获取下一个账户
    let quote_token_account_info = next_account_info(iter)?; // 获取下一个账户

    // 手动反序列化为 TokenAccount
    let owner_token_account = Account::try_from(owner_token_account_info)?;
    let quote_token_account = Account::try_from(quote_token_account_info)?;

    // 返回 maker 账户结构体
    Ok(MakerAccounts {
        owner_token_account,
        quote_token_account,
    })
}

// 定义 maker 账户结构体，包含基础和报价代币账户
struct MakerAccounts<'info> {
    owner_token_account: Account<'info, TokenAccount>,
    quote_token_account: Account<'info, TokenAccount>,
}

// 定义初始化指令的账户结构体
#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + 32 + 32 + 8 + 4 + (56 * 50) + 4 + (56 * 50), // 分配空间
        seeds = [b"orderbook".as_ref(), base_mint.key().as_ref(), quote_mint.key().as_ref()],
        bump
    )]
    pub orderbook: Account<'info, Orderbook>, // 订单簿账户
    pub base_mint: Account<'info, Mint>,  // 基础代币
    pub quote_mint: Account<'info, Mint>, // 报价代币
    #[account(
        init,
        payer = payer,
        token::mint = base_mint,
        token::authority = orderbook,
        seeds = [b"base_vault".as_ref(), orderbook.key().as_ref()],
        bump
    )]
    pub base_vault: Account<'info, TokenAccount>, // 基础代币金库
    #[account(
        init,
        payer = payer,
        token::mint = quote_mint,
        token::authority = orderbook,
        seeds = [b"quote_vault".as_ref(), orderbook.key().as_ref()],
        bump
    )]
    pub quote_vault: Account<'info, TokenAccount>, // 报价代币金库
    #[account(mut)]
    pub payer: Signer<'info>, // 支付者

    pub system_program: Program<'info, System>, // 系统程序
    pub token_program: Program<'info, Token>, // 代币程序
    //链上内置的“租金数据”，主要用于创建新账户时 → 计算租金豁免额度 → 防止新建账户被回收。
    pub rent: Sysvar<'info, Rent>,        // 租金系统变量
}

// 定义下单指令的账户结构体
#[derive(Accounts)]
pub struct PlaceOrder<'info> {
    #[account(
        mut,
        seeds = [b"orderbook".as_ref(), orderbook.base_mint.as_ref(), orderbook.quote_mint.as_ref()],
        bump,
    )]
    pub orderbook: Account<'info, Orderbook>, // 订单簿账户
    #[account(mut)]
    pub owner: Signer<'info>, // 订单拥有者
    #[account(
        mut,
        constraint = owner_base_token_account.mint == orderbook.base_mint,
        constraint = owner_base_token_account.owner == owner.key()
    )]
    pub owner_base_token_account: Account<'info, TokenAccount>, // 用户基础代币账户
    #[account(
        mut,
        constraint = owner_quote_token_account.mint == orderbook.quote_mint,
        constraint = owner_quote_token_account.owner == owner.key()
    )]
    pub owner_quote_token_account: Account<'info, TokenAccount>, // 用户报价代币账户
    #[account(
        mut,
        seeds = [b"base_vault".as_ref(), orderbook.key().as_ref()],
        bump
    )]
    pub base_vault: Account<'info, TokenAccount>, // 基础代币金库
    #[account(
        mut,
        seeds = [b"quote_vault".as_ref(), orderbook.key().as_ref()],
        bump
    )]
    pub quote_vault: Account<'info, TokenAccount>, // 报价代币金库
    pub token_program: Program<'info, Token>, // 代币程序  就是告诉 Anchor：我要去找“官方 SPL Token 程序”，帮我干转账、铸币这些事。
}

// 定义取消订单指令的账户结构体
#[derive(Accounts)]
pub struct CancelOrder<'info> {
    #[account(
        mut,
        seeds = [b"orderbook".as_ref(), orderbook.base_mint.as_ref(), orderbook.quote_mint.as_ref()],
        bump,
    )]
    pub orderbook: Account<'info, Orderbook>, // 订单簿账户
    #[account(mut)]
    pub owner: Signer<'info>, // 订单拥有者
    #[account(
        mut,
        constraint = owner_base_token_account.mint == orderbook.base_mint
    )]
    pub owner_base_token_account: Account<'info, TokenAccount>, // 用户基础代币账户
    #[account(
        mut,
        constraint = owner_quote_token_account.mint == orderbook.quote_mint
    )]
    pub owner_quote_token_account: Account<'info, TokenAccount>, // 用户报价代币账户
    #[account(
        mut,
        seeds = [b"base_vault".as_ref(), orderbook.key().as_ref()],
        bump
    )]
    pub base_vault: Account<'info, TokenAccount>, // 基础代币金库
    #[account(
        mut,
        seeds = [b"quote_vault".as_ref(), orderbook.key().as_ref()],
        bump
    )]
    pub quote_vault: Account<'info, TokenAccount>, // 报价代币金库
    pub token_program: Program<'info, Token>, // 代币程序
}

// 定义订单簿数据结构，存储代币对和订单信息
#[account]
pub struct Orderbook {
    pub base_mint: Pubkey,     // 基础代币公钥
    pub quote_mint: Pubkey,    // 报价代币公钥
    pub bids: Vec<Order>,      // 买单列表
    pub asks: Vec<Order>,      // 卖单列表
    pub order_id_counter: u64, // 订单 ID 计数器
}

// 定义订单数据结构，存储订单详细信息
#[derive(Debug, AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct Order {
    pub owner: Pubkey, // 订单拥有者公钥
    pub price: u64,    // 订单价格
    pub quantity: u64, // 订单数量
    pub order_id: u64, // 订单 ID
}

// 定义订单方向枚举（买入/卖出）
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub enum Side {
    Buy,
    Sell,
}

// 定义交易事件，记录交易信息
#[event]
pub struct TradeEvent {
    pub taker: Pubkey,      // 主动方公钥
    pub maker: Pubkey,      // 被动方公钥
    pub base_mint: Pubkey,  // 基础代币公钥
    pub quote_mint: Pubkey, // 报价代币公钥
    pub quantity: u64,      // 交易数量
    pub price: u64,         // 交易价格
}

// 定义错误代码，处理可能出现的错误
#[error_code]
pub enum DexError {
    #[msg("The specified order could not be found.")]
    OrderNotFound, // 订单未找到
    #[msg("You are not authorized to cancel this order.")]
    OrderNotOwned, // 无权取消订单
    #[msg("The provided maker account does not match the order owner.")]
    MakerAccountMismatch, // maker 账户不匹配
    #[msg("An error occurred during a mathematical calculation.")]
    CalculationError, // 计算错误
}
