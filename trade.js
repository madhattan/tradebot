import {
    Connection,
    PublicKey,
    Keypair,
    SystemProgram,
    TransactionExpiredBlockheightExceededError,
    Transaction,
    sendAndConfirmTransaction,
    ComputeBudgetProgram,
    TransactionMessage,
    VersionedTransaction,
} from "@solana/web3.js";
import fs from "fs";
import { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction } from "@solana/spl-token";
import BN from "bn.js";
import dotenv from "dotenv";
import bs58 from 'bs58';
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import fetch from 'node-fetch'; // Ensure correct import style
import { LIQUIDITY_STATE_LAYOUT_V4 } from '@raydium-io/raydium-sdk'; // Example for Raydium SDK import

let walletKeypair; // ✅ Declare globally so it can be used everywhere
dotenv.config();


const SHYFT_API_KEY = process.env.SHYFT_API_KEY
const rugPullLogFile = "rugged_tokens.json";
const RAYDIUM_PUBLIC_KEY = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const HTTP_URL = process.env.RPC_URL; // Add your RPC URL here
const WSS_URL = process.env.WSS_URL; // Add your WebSocket URL here
const RAYDIUM = new PublicKey(RAYDIUM_PUBLIC_KEY);
const INSTRUCTION_NAME = "initialize2";
const connection = new Connection(HTTP_URL, { wsEndpoint: WSS_URL });
const processedPools = new Set(); // Set to track processed pools
const targetMintSubstring = "pump";  // Target substring for "pump" tokens or mints
const JUP_API_QUOTE = "https://quote-api.jup.ag/v6/quote";
const JUP_API_SWAP = "https://quote-api.jup.ag/v6/swap";
const JUP_PRICE_API = "https://price.jup.ag/v4/price";
const activeTrades = {}; // 🛠️ Track each trade separately
// 🟢 Fetch best quote from Jupiter

async function getQuoteResponse(inputMint, outputMint, amount) {
    try {
        console.log(📡 Fetching best quote: ${inputMint} → ${outputMint} | Amount: ${amount});

        const url = https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=50;
        const response = await fetch(url);
        const data = await response.json();

        if (!data || !data.outAmount) {
            console.error("❌ Failed to get a valid Jupiter quote!");
            return null;
        }

        //console.log(✅ Best Quote Found:, data);
        return data;
    } catch (error) {
        console.error("❌ Failed to get Jupiter quote:", error);
        return null;
    }
}

async function ensureTokenAccountExists(mint, owner) {
    const ata = await getAssociatedTokenAddress(new PublicKey(mint), owner);

    // ✅ Faster: Use getMultipleAccountsInfo for batch checking
    const accountInfo = await connection.getAccountInfo(ata);

    if (!accountInfo) {
        console.log(🚀 Creating Associated Token Account for: ${mint});

        const transaction = new Transaction().add(
            createAssociatedTokenAccountInstruction(
                walletKeypair.publicKey, ata, owner, new PublicKey(mint)
            )
        );

        // ✅ Use sendTransaction instead of sendAndConfirmTransaction
        const signature = await connection.sendTransaction(transaction, [walletKeypair], {
            skipPreflight: true,  // ✅ Speeds up by skipping redundant checks
            maxRetries: 3         // ✅ Ensures faster retry if failure
        });

        console.log(✅ Token Account Created: ${ata.toBase58()} | TX: https://solscan.io/tx/${signature});
    }

    return ata;
}

let tradeHistory = {};  

function logTrade({ contractAddress, amount, transactionHash, price, isSell }) {
    const timestamp = new Date().toISOString();
    const tradeType = isSell ? "SELL" : "BUY";

    // ✅ Track buy trades
    if (!isSell) {
        if (!tradeHistory[contractAddress]) {
            tradeHistory[contractAddress] = [];
        }
        tradeHistory[contractAddress].push({ price, amount });
    }

    let pnl = null;

    // ✅ If it's a sell, calculate PnL
    if (isSell && tradeHistory[contractAddress] && tradeHistory[contractAddress].length > 0) {
        let totalBuyCost = 0;
        let totalBuyAmount = 0;

        // ✅ Aggregate buy price and amounts
        tradeHistory[contractAddress].forEach((buy) => {
            totalBuyCost += buy.price * buy.amount;
            totalBuyAmount += buy.amount;
        });

        const avgBuyPrice = totalBuyCost / totalBuyAmount;  
        const sellRevenue = price * amount;  
        const buyCostForSold = avgBuyPrice * amount;
        pnl = sellRevenue - buyCostForSold;  

        // ✅ Remove sold amount from trade history (FIFO method)
        let remainingAmount = amount;
        tradeHistory[contractAddress] = tradeHistory[contractAddress].filter((buy) => {
            if (remainingAmount <= 0) return true;  

            if (buy.amount > remainingAmount) {
                buy.amount -= remainingAmount;
                remainingAmount = 0;
                return true;
            } else {
                remainingAmount -= buy.amount;
                return false;
            }
        });

        if (tradeHistory[contractAddress].length === 0) {
            delete tradeHistory[contractAddress];
        }
    }

    const pnlText = pnl !== null ?  | PnL: ${pnl.toFixed(6)} SOL : "";
    const logEntry = ${timestamp} | ${tradeType} | CA: ${contractAddress} | Amount: ${amount.toFixed(6)} SOL | Price: ${price.toFixed(6)} SOL | TX: ${transactionHash}${pnlText}\n;

    // ✅ Append trade details to trade_log.txt
    fs.appendFile("trade_log.txt", logEntry, (err) => {
        if (err) console.error("❌ Error logging trade:", err);
    });

    console.log(📝 Trade logged: ${logEntry});
}

async function monitorPrices() {
    console.log(📊 Monitoring prices for all active trades...);

    while (true) {
        try {
            if (Object.keys(activeTrades).length === 0) {
               // console.log("⚠️ No active trades. Waiting...");
                await new Promise(res => setTimeout(res, 3000));
                continue;
            }

            console.log(🔍 Active Trades:, Object.keys(activeTrades));

            for (const tokenMint in activeTrades) {
                const trade = activeTrades[tokenMint];
                console.log(🔹 Checking Trade: ${tokenMint});

                let currentPrice = null;
                let retryCount = 0;

                // ✅ Retry fetching price up to 3 times
                while (retryCount < 3 && currentPrice === null) {
                    const latestQuote = await getQuoteResponse(tokenMint, "So11111111111111111111111111111111111111112", trade.amount);

                    if (latestQuote && latestQuote.outAmount) {
                        currentPrice = parseFloat(latestQuote.outAmount) / parseFloat(latestQuote.inAmount);
                        console.log(💰 ${tokenMint} Current Price: ${currentPrice.toFixed(6)} SOL);
                    } else {
                        console.warn(⚠️ Failed to fetch quote for ${tokenMint} (Attempt ${retryCount + 1}/3).);
                        retryCount++;
                        await new Promise(res => setTimeout(res, 1000));
                    }
                }

                if (currentPrice === null) {
                    console.error(❌ Completely failed to get price for ${tokenMint}. Skipping this round.);
                    continue;
                }

                // ✅ Store price history for pump speed tracking
                if (!trade.priceHistory) {
                    trade.priceHistory = [];
                }
                trade.priceHistory.push({ time: Date.now(), price: currentPrice });

                // ✅ Remove old prices (Keep only last 60 seconds of data)
                trade.priceHistory = trade.priceHistory.filter(p => Date.now() - p.time < 60000);

                // ✅ Calculate Pump Speed: % Increase Over Last 60s
                if (trade.priceHistory.length > 1) {
                    const firstPrice = trade.priceHistory[0].price;
                    const priceChange = ((currentPrice - firstPrice) / firstPrice) * 100;

                    console.log(⚡ Pump Speed for ${tokenMint}: ${priceChange.toFixed(2)}% in last 60s);

                    // ✅ Adjust TP based on Pump Speed
                    if (priceChange >= 50) {  
                        trade.takeProfit2x = trade.highestPrice * 2.5;
                    } else if (priceChange >= 30) {
                        trade.takeProfit2x = trade.highestPrice * 2.2;
                    } else {
                        trade.takeProfit2x = trade.highestPrice * 1.8;
                    }
                }

                // ✅ Ensure highestPrice starts correctly
                if (!trade.highestPrice) {
                    trade.highestPrice = currentPrice;
                    console.log(📈 Initialized highest price: ${trade.highestPrice.toFixed(6)} SOL);
                }

                // ✅ Update highest price when price increases
                if (currentPrice > trade.highestPrice) {
                    trade.highestPrice = currentPrice;
                    console.log(🔼 New High: ${trade.highestPrice.toFixed(6)} SOL);
                }

                // ✅ Move Stop-Loss to Break-Even at 1.3x
                if (currentPrice >= trade.entryPrice * 1.3 && !trade.breakEvenMoved) {
                    trade.stopLoss = trade.entryPrice;
                    trade.breakEvenMoved = true;
                    console.log(🔹 Moved stop-loss to break-even for ${tokenMint});
                }

                // ✅ Apply Trailing Stop-Loss **ONLY after a 1.3x price move**
                if (trade.breakEvenMoved) {
                    trade.stopLoss = Math.max(trade.stopLoss, trade.highestPrice * 0.70);
                    console.log(🔹 Trailing Stop-Loss Adjusted: ${trade.stopLoss.toFixed(6)} SOL);
                }

                // ✅ SELL if Stop-Loss is Hit
                if (currentPrice <= trade.stopLoss) {
                    console.log(🚨 Selling ${tokenMint} at ${currentPrice.toFixed(6)} SOL due to Stop-Loss.);

                    const tokenAccount = await getAssociatedTokenAddress(new PublicKey(tokenMint), walletKeypair.publicKey);
                    const tokenBalanceInfo = await connection.getTokenAccountBalance(tokenAccount);
                    const availableAmount = parseFloat(tokenBalanceInfo.value.amount);

                    console.log(💰 Available Balance for ${tokenMint}: ${availableAmount});

                    if (availableAmount > 0) {
                        const txHash = await executeSwapJupiter(
                            tokenMint,
                            "So11111111111111111111111111111111111111112",
                            availableAmount,
                            walletKeypair
                        );

                        if (txHash) {
                            logTrade({ contractAddress: tokenMint, amount: availableAmount, transactionHash: txHash, isSell: true });
                        }

                        console.log(✅ Sold ${tokenMint} at stop-loss!);
                    } else {
                        console.log(⚠️ No tokens available for ${tokenMint}, skipping sell.);
                    }

                    delete activeTrades[tokenMint];
                    continue;
                }

                // ✅ SELL if Take-Profit (Dynamically Adjusted TP) is Reached
                if (currentPrice >= trade.takeProfit2x) {
                    console.log(🚀 Take-Profit Reached for ${tokenMint} at ${currentPrice.toFixed(6)} SOL! Selling ALL.);

                    const tokenAccount = await getAssociatedTokenAddress(new PublicKey(tokenMint), walletKeypair.publicKey);
                    const tokenBalanceInfo = await connection.getTokenAccountBalance(tokenAccount);
                    const availableAmount = parseFloat(tokenBalanceInfo.value.amount);

                    console.log(💰 Available Balance for ${tokenMint}: ${availableAmount});

                    if (availableAmount > 0) {
                        const txHash = await executeSwapJupiter(
                            tokenMint,
                            "So11111111111111111111111111111111111111112",
                            availableAmount,
                            walletKeypair
                        );

                        if (txHash) {
                            logTrade({ contractAddress: tokenMint, amount: availableAmount, transactionHash: txHash, isSell: true });
                        }

                        console.log(✅ Sold ${tokenMint} at take-profit!);
                    } else {
                        console.log(⚠️ No tokens available for ${tokenMint}, skipping sell.);
                    }

                    delete activeTrades[tokenMint];
                    continue;
                }
            }

            await new Promise(res => setTimeout(res, 5000));

        } catch (error) {
            console.error("❌ Error monitoring prices:", error);
            await new Promise(res => setTimeout(res, 3000));
        }
    }
}

async function executeSwapJupiter(inputMint, outputMint, amount, walletKeypair, retries = 10, isSell = false) {
    try {
        console.log(🔄 Preparing Swap: ${inputMint} → ${outputMint} | Amount: ${amount} | Type: ${isSell ? "SELL" : "BUY"});

        for (let i = 0; i < retries; i++) {
            const quoteResponse = await getQuoteResponse(inputMint, outputMint, amount);
            if (!quoteResponse || !quoteResponse.outAmount) {
                console.error(❌ No valid swap quote found for ${inputMint}. Retrying... (${i + 1}/${retries}));
                await new Promise(res => setTimeout(res, 2000)); // Wait 2 sec before retrying
                continue;
            }

            console.log(🔍 Best Quote Found for ${inputMint}:, quoteResponse);

            const response = await fetch("https://api.jup.ag/swap/v1/swap", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    quoteResponse,
                    userPublicKey: walletKeypair.publicKey.toBase58(),
                    dynamicComputeUnitLimit: true, 
                    dynamicSlippage: true,
                    prioritizationFeeLamports: { 
                        priorityLevelWithMaxLamports: { 
                            maxLamports: 500_000, 
                            priorityLevel: "veryHigh"
                        } 
                    }
                }),
            });

            const swapTransactionData = await response.json();

            if (!swapTransactionData.swapTransaction) {
                console.error("❌ No swap transaction returned! Retrying...");
                await new Promise(res => setTimeout(res, 2000));
                continue;
            }

            console.log(📝 Swap Transaction Response:, swapTransactionData);

            const transactionBase64 = swapTransactionData.swapTransaction;
            const transaction = VersionedTransaction.deserialize(Buffer.from(transactionBase64, 'base64'));

            transaction.sign([walletKeypair]);

            const transactionBinary = transaction.serialize();
            const txSignature = await connection.sendRawTransaction(transactionBinary, {
                maxRetries: 3,  
                skipPreflight: true
            });

            const confirmation = await connection.confirmTransaction({ signature: txSignature }, "finalized");

            if (confirmation.value.err) {
                console.error(❌ Swap failed: ${JSON.stringify(confirmation.value.err)});
                
                if (i < retries - 1) {
                    console.log(⚠️ Retrying swap with a **smaller** amount... (${i + 1}/${retries}));
                    amount = Math.floor(amount * 1); // Reduce trade size by 50%
                    continue;
                } else {
                    console.log(🚨 Swap failed after ${retries} attempts. Marking ${inputMint} as "stuck".);
                    activeTrades[inputMint].stuck = true; // Mark trade as stuck instead of deleting
                    return null;
                }
            } else {
                console.log(✅ Swap Successful! TX: https://solscan.io/tx/${txSignature});

                // ✅ Log trade details
                logTrade({
                    contractAddress: inputMint,
                    amount: amount / 1e9,  // Convert lamports to SOL
                    transactionHash: txSignature,
                    price: parseFloat(quoteResponse.inAmount) / parseFloat(quoteResponse.outAmount), 
                    isSell: isSell,
                });

                delete activeTrades[inputMint];  // ✅ Remove successful trades
                return txSignature;
            }
        }
    } catch (error) {
        console.error("❌ Swap failed:", error);
        activeTrades[inputMint].stuck = true; // Mark as stuck
        return null;
    }
}

async function startConnection(connection, programAddress, searchInstruction) {
    console.log(🖥️ [START] Monitoring logs for program: ${programAddress.toString()});
    console.log(🔍 Listening for instruction: '${searchInstruction}');
    
    connection.onLogs(
        programAddress,
        async ({ logs, err, signature }) => {
          //  console.log(📡 [LOG EVENT] Received new logs from WebSocket...);

            // Log if there's an error
            if (err) {
              //  console.error(❌ [ERROR] WebSocket Error detected:, err);
                return;
            }

            // Log raw logs received
            if (!logs || logs.length === 0) {
             //   console.warn(⚠️ [WARNING] No logs found in this event.);
                return;
            }

          //  console.log(📜 [LOGS] Raw Logs from WebSocket:\n, logs);

            // Check if any log contains the instruction we're monitoring
            const matchingLogs = logs.filter(log => log.toLowerCase().includes(searchInstruction.toLowerCase()));
            if (matchingLogs.length > 0) {
                console.log(✅ [MATCH FOUND] Detected '${searchInstruction}' in transaction.);
                console.log(🔗 Transaction Link: https://solscan.io/tx/${signature});
                console.log(📜 [MATCHING LOGS]:\n, matchingLogs);

                try {
                    //console.log(🚀 Fetching Raydium Mints for signature: ${signature}...);
                    await fetchRaydiumMints(signature, connection);
                  //  console.log(✅ [SUCCESS] Successfully fetched Raydium mint data.);
                } catch (fetchError) {
                  //  console.error(❌ [FETCH ERROR] Failed to process Raydium Mints for ${signature}:, fetchError);
                }
            } else {
              //  console.log(🚫 [NO MATCH] This log does not contain '${searchInstruction}');
            }
        },
        "finalized"
    );

    console.log("✅ [READY] WebSocket log monitoring is active.");
}

async function fetchRaydiumMints(txId, connection) {
    try {
        const tx = await connection.getParsedTransaction(txId, {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed'
        });

        const instructions = tx?.transaction.message.instructions;
        const raydiumInstruction = instructions.find(
            ix => ix.programId.toBase58() === RAYDIUM_PUBLIC_KEY
        );

        if (!raydiumInstruction) {
          //  console.log("No Raydium instructions found in the transaction.");
            return;
        }

        const accounts = raydiumInstruction.accounts;
        if (!accounts) {
            console.log("No accounts found in the transaction.");
            return;
        }

        const ammIndex = 4;
        const poolCoinTokenAccountIndex = 10;
        const poolPcTokenAccountIndex = 11;

        const ammPoolKey = accounts[ammIndex];
        const poolCoinTokenAccount = accounts[poolCoinTokenAccountIndex];
        const poolPcTokenAccount = accounts[poolPcTokenAccountIndex];

        const poolData = await connection.getAccountInfo(ammPoolKey);
        const decodedData = LIQUIDITY_STATE_LAYOUT_V4.decode(poolData.data);
        const poolQuoteMint = new PublicKey(decodedData.quoteMint);

        if (poolQuoteMint.toBase58().includes(targetMintSubstring)) {
            console.log(✅ Found relevant pool: ${ammPoolKey.toBase58()});

            const displayData = [
                {
                    "Category": "Pool Information",
                    "Account Type": "AMM Pool",
                    "Address": ammPoolKey.toBase58()
                },
                {
                    "Category": "Token Accounts",
                    "Account Type": "Pool Coin Account",
                    "Address": poolCoinTokenAccount.toBase58()
                },
                {
                    "Category": "Token Accounts",
                    "Account Type": "Pool PC Account",
                    "Address": poolPcTokenAccount.toBase58()
                }
            ];

            console.log("\n=== New Liquidity Pool Details ===");
            console.table(displayData, ["Category", "Account Type", "Address"]);
            console.log(Pool Key: ${ammPoolKey.toBase58()});
            console.log(Base Mint: ${new PublicKey(decodedData.baseMint).toBase58()});
            console.log(Quote Mint: ${poolQuoteMint.toBase58()});

            // Include the pool version (e.g. 4) so the SDK can process the pool correctly.
            await autoTrade({
                poolKey: ammPoolKey,
                baseMint: new PublicKey(decodedData.baseMint),
                quoteMint: poolQuoteMint,
                version: 4  // <-- Added version property
            });
        }
    } catch (error) {
        console.log("Error fetching transaction:", txId, error);
    }
}

startConnection(connection, RAYDIUM, INSTRUCTION_NAME).catch(console.error);

async function getKeypairFromPrivateKey() {
    try {
        console.log("🔍 Loading private key from .env...");

        // Ensure the PRIVATE_KEY is set in .env
        if (!process.env.PRIVATE_KEY) {
            throw new Error("❌ PRIVATE_KEY is missing in .env!");
        }

        // Convert the stored key from Base58 or Uint8Array format
        let secretKey;

        if (process.env.PRIVATE_KEY.includes(",")) {
            // If stored as a Uint8Array string (comma-separated)
            secretKey = Uint8Array.from(process.env.PRIVATE_KEY.split(",").map(n => parseInt(n, 10)));
        } else {
            // If stored as a Base58 string (Phantom format)
            const bs58 = (await import("bs58")).default;
            secretKey = bs58.decode(process.env.PRIVATE_KEY);
        }

        // Generate Keypair from private key
        const keypair = Keypair.fromSecretKey(secretKey);

        console.log("✅ Private key loaded successfully.");
        console.log(🔹 Loaded Wallet Address: ${keypair.publicKey.toBase58()}); // ✅ Print the wallet address

        return keypair;
    } catch (error) {
        console.error("❌ Error loading private key:", error);
        return null;
    }
}
async function fetchDexScreenerData(tokenMint) {
    try {
        const url = https://api.dexscreener.com/latest/dex/tokens/${tokenMint};
        console.log(📡 Fetching token data from DexScreener: ${url});

        const response = await fetch(url);
        const data = await response.json();

        // ✅ Log full DexScreener response for debugging
        //console.log("🔍 FULL DexScreener RESPONSE:", JSON.stringify(data, null, 2));

        if (!data || !data.pairs || data.pairs.length === 0) {
            console.error(❌ No trading data found for ${tokenMint});
            return null;
        }

        const pair = data.pairs[0]; // Get first trading pair data

        // ✅ Use 24-hour transactions for Buy/Sell Ratio
        const buys = pair.txns?.h24?.buys ?? 0;
        const sells = pair.txns?.h24?.sells ?? 1; // Avoid divide by zero
        const buySellRatio = buys / sells;

        // ✅ Fetch holder count from Solana
        const holderCount = await fetchSolanaHolderCount(tokenMint);

        return {
            price: parseFloat(pair.priceUsd),  // Token price in USD
            volume: parseFloat(pair.volume.h24),  // 24-hour volume
            holderCount: holderCount,  // Unique holders (from Solana)
            buySellRatio: buySellRatio, // Buy/Sell ratio
        };
    } catch (error) {
        console.error(❌ Failed to fetch DexScreener data for ${tokenMint}:, error);
        return null;
    }
}

// ✅ Fetch holder count from Solana blockchain
async function fetchSolanaHolderCount(tokenMint) {
    try {
        console.log(📡 Fetching holder count for ${tokenMint}...);

        // ✅ Query all token accounts associated with the mint
        const accounts = await connection.getProgramAccounts(TOKEN_PROGRAM_ID, {
            filters: [
                { dataSize: 165 }, // Filter for token accounts
                { memcmp: { offset: 0, bytes: tokenMint } } // Match the mint address
            ]
        });

        const holderCount = accounts.length; // Each account represents a unique holder

        console.log(✅ Holder Count for ${tokenMint}: ${holderCount});
        return holderCount;
    } catch (error) {
        console.error(❌ Failed to fetch holders for ${tokenMint}:, error);
        return 0; // Default to 0 if RPC fails
    }
}

async function checkTokenHolders(tokenMint) {
    console.log(🔍 Checking holders for ${tokenMint}...);

    const url = https://api.shyft.to/sol/v1/wallet/all_tokens?network=mainnet-beta&wallet=${tokenMint};

    try {
        const response = await fetch(url, {
            method: "GET",
            headers: { "x-api-key": SHYFT_API_KEY },
        });

        const data = await response.json();

        if (data.success && data.result) {
            return data.result;
        } else {
            console.error(❌ Failed to fetch token holders:, data.message);
            return null;
        }
    } catch (error) {
        console.error(❌ Error checking token holders:, error);
        return null;
    }
}

async function detectBundledToken(tokenMint) {
    const holders = await checkTokenHolders(tokenMint);
    
    if (!holders || holders.length === 0) {
        console.log(⚠️ No holder data available for ${tokenMint});
        return false;
    }

    // ✅ Group wallets by token amount
    let amountMap = {};
    holders.forEach(holder => {
        let amount = holder.amount.toFixed(6);  // Round to 6 decimal places to avoid float issues
        if (!amountMap[amount]) {
            amountMap[amount] = 0;
        }
        amountMap[amount]++;
    });

    // ✅ Check for suspicious patterns
    let bundledDetected = false;
    Object.keys(amountMap).forEach(amount => {
        if (amountMap[amount] >= 10 && amountMap[amount] <= 50) {
            console.log(🚨 Bundled Detected! ${amountMap[amount]} wallets hold exactly ${amount} tokens.);
            bundledDetected = true;
        }
    });

    if (bundledDetected) {
        console.log(🚨 ${tokenMint} is likely a bundled token!);
        return true;
    } else {
        console.log(✅ ${tokenMint} seems safe.);
        return false;
    }
}

const trackedTokens = {};  // Stores tokens being monitored

async function monitorTokenForBuy(tokenMint, baseMint) {
    console.log(🔍 Monitoring ${tokenMint} for buy conditions...);

    // ✅ **Step 1: Check if the token is bundled BEFORE running other logic**
    const isBundled = await detectBundledToken(tokenMint);
    if (isBundled) {
        console.log(🚨 ${tokenMint} is bundled! Removing from tracking.);
        return false; // ❌ Exit immediately if it's bundled
    }

    // ✅ **Step 2: Initialize tracking data**
    trackedTokens[tokenMint] = {
        entryTime: Date.now(),  // **Tracks start time**
        checked: false,
        priceHistory: [],
        highestPrice: null, // Store highest price seen
        lastHolderCount: null, // Track last holder count
        lastVolume: null, // Track last volume
        stagnantCounter: 0, // Track how many cycles it has been stagnant
    };

    while (true) {
        try {
            if (!trackedTokens[tokenMint]) return false; // Stop if removed

            const elapsedTime = (Date.now() - trackedTokens[tokenMint].entryTime) / 1000; // Convert to seconds

            // ❌ **If it runs longer than 10 minutes (600 seconds), remove from tracking**
            if (elapsedTime >= 600) {
                console.log(🚨 ${tokenMint} has been monitored for 10 minutes without meeting conditions! Removing from tracking.);
                delete trackedTokens[tokenMint];
                return false;
            }

            const tokenStats = await fetchDexScreenerData(tokenMint);
            if (!tokenStats) {
                console.log(⚠️ No data found for ${tokenMint}. Skipping.);
                return false;
            }

            // ✅ **Ensure price history updates correctly**
            if (trackedTokens[tokenMint].priceHistory.length >= 5) {
                trackedTokens[tokenMint].priceHistory.shift(); // ✅ Remove oldest price to maintain last 5 entries
            }
            trackedTokens[tokenMint].priceHistory.push(tokenStats.price); // ✅ Add latest price

            // ✅ **Track highest price**
            if (!trackedTokens[tokenMint].highestPrice || tokenStats.price > trackedTokens[tokenMint].highestPrice) {
                trackedTokens[tokenMint].highestPrice = tokenStats.price;
            }

            console.log(📊 Monitoring ${tokenMint} - Holders: ${tokenStats.holderCount}, Volume: ${tokenStats.volume}, Buy/Sell: ${tokenStats.buySellRatio}, Price: ${tokenStats.price});
            console.log(🔄 Price History: ${trackedTokens[tokenMint].priceHistory.join(" -> ")});

            // ❌ **Check for Rug Pull (-70% Price Drop from Peak)**
            const priceDrop = ((trackedTokens[tokenMint].highestPrice - tokenStats.price) / trackedTokens[tokenMint].highestPrice) * 100;
            if (priceDrop >= 70) {
                console.log(🚨 RUG DETECTED! ${tokenMint} price dropped -${priceDrop.toFixed(2)}%! Removing from tracking.);
                delete trackedTokens[tokenMint];
                return false;
            }

            // ❌ **Check if Buy/Sell Ratio Reverses (More Sells than Buys)**
            if (tokenStats.buySellRatio < 0.8) { // Less than 0.8 means sellers are dominating
                console.log(🚨 SELLERS DOMINATING! ${tokenMint} Buy/Sell Ratio dropped below 0.8. Removing from tracking.);
                delete trackedTokens[tokenMint];
                return false;
            }

            // ❌ **Check if Volume Suddenly Drops**
            if (tokenStats.volume < 500) { // If volume drops too low, token is dead
                console.log(🚨 VOLUME DROP! ${tokenMint} volume is too low. Removing from tracking.);
                delete trackedTokens[tokenMint];
                return false;
            }

            // ✅ **Detect Stagnant Tokens**
            if (
                trackedTokens[tokenMint].lastHolderCount !== null &&
                trackedTokens[tokenMint].lastVolume !== null
            ) {
                const noHolderChange = trackedTokens[tokenMint].lastHolderCount === tokenStats.holderCount;
                const noVolumeChange = trackedTokens[tokenMint].lastVolume === tokenStats.volume;
                const noPriceChange = trackedTokens[tokenMint].priceHistory.every(p => p === tokenStats.price);

                if (noHolderChange && noVolumeChange && noPriceChange) {
                    trackedTokens[tokenMint].stagnantCounter++;
                    console.log(⚠️ ${tokenMint} has been stagnant for ${trackedTokens[tokenMint].stagnantCounter} cycles.);

                    // Remove if stagnant for too many cycles
                    if (trackedTokens[tokenMint].stagnantCounter >= 7) { // ✅ Reduced from 10 to 7 cycles
                        console.log(🚨 ${tokenMint} is stagnant (no growth, no movement). Removing from tracking.);
                        delete trackedTokens[tokenMint];
                        return false;
                    }
                } else {
                    // Reset counter if activity is detected
                    trackedTokens[tokenMint].stagnantCounter = 0;
                }
            }

            // ✅ **Re-check if token becomes bundled during tracking**
            const isNowBundled = await detectBundledToken(tokenMint);
            if (isNowBundled) {
                console.log(🚨 ${tokenMint} has been flagged as bundled! Removing from tracking.);
                delete trackedTokens[tokenMint];
                return false;
            }

            // ✅ Update last values for next cycle
            trackedTokens[tokenMint].lastHolderCount = tokenStats.holderCount;
            trackedTokens[tokenMint].lastVolume = tokenStats.volume;

            // ✅ **Define buy conditions**
            const meetsConditions =
                tokenStats.holderCount >= 300 &&  // Minimum Holders
                tokenStats.volume >= 25000 &&  // Minimum Volume (24h)
                tokenStats.buySellRatio > 1.5;  // Strong Buy Pressure (More Buys Than Sells)

            if (meetsConditions) {
                console.log(🚀 ${tokenMint} meets conditions! Signaling autoTrade to execute swap...);
                delete trackedTokens[tokenMint]; // Stop monitoring after buying
                return true; // ✅ Signal autoTrade to execute swap
            }

            await new Promise(res => setTimeout(res, 5000)); // Check every 5s
        } catch (error) {
            console.error(❌ Error monitoring ${tokenMint}:, error);
            await new Promise(res => setTimeout(res, 3000));
        }
    }
}


const processedTrades = new Set(); // Store already attempted trades

async function autoTrade(poolDetails) {
    try {
        const tradeKey = poolDetails.quoteMint.toBase58();
        if (processedTrades.has(tradeKey)) {
            console.log(⚠️ Skipping duplicate trade: ${tradeKey});
            return; // ✅ Prevent duplicate buys
        }

        processedTrades.add(tradeKey);

        console.log(📡 Monitoring ${tradeKey} for buy conditions...);

        // ✅ Start monitoring and WAIT for confirmation before executing
        const shouldBuy = await monitorTokenForBuy(tradeKey, poolDetails.baseMint);
        
        if (!shouldBuy) {
            console.log(🚫 Conditions not met for ${tradeKey}, skipping trade.);
            return;
        }

        console.log(🚀 Buy conditions met for ${tradeKey}! Executing Swap...);

        const tokenAccount = await ensureTokenAccountExists(poolDetails.quoteMint, walletKeypair.publicKey);
        console.log(✅ Token Account Ready: ${tokenAccount.toBase58()});

        const balanceLamports = await connection.getBalance(walletKeypair.publicKey);
        const solBalance = balanceLamports / 1e9;
        if (solBalance < 0.1) {
            console.log("⚠️ Insufficient balance. Skipping trade.");
            return;
        }

        const tradeAmountSOL = solBalance * 0.05;
        const tradeAmountLamports = Math.floor(tradeAmountSOL * 1e9);

        console.log(🚀 Initiating trade with ${tradeAmountSOL.toFixed(3)} SOL for ${tradeKey}...);

        let quoteResponse;
        let attempts = 0;
        while (attempts < 3) {
            quoteResponse = await getQuoteResponse(poolDetails.baseMint, poolDetails.quoteMint, tradeAmountLamports);
            if (quoteResponse && quoteResponse.outAmount) break;

            console.warn(⚠️ Quote fetch failed (Attempt ${attempts + 1}/3). Retrying...);
            attempts++;
            await new Promise(res => setTimeout(res, 1500));
        }

        if (!quoteResponse || !quoteResponse.outAmount) {
            console.error("❌ Failed to fetch a valid quote after 3 attempts! Skipping trade.");
            return;
        }

        const entryPrice = parseFloat(quoteResponse.inAmount) / parseFloat(quoteResponse.outAmount);
        if (!entryPrice || entryPrice <= 0) {
            console.error("❌ Invalid entry price calculated, skipping trade.");
            return;
        }

        const swapSignature = await executeSwapJupiter(
            poolDetails.baseMint,
            poolDetails.quoteMint,
            tradeAmountLamports,
            walletKeypair
        );

        if (!swapSignature) {
            console.error(❌ Swap failed for Pool: ${poolDetails.poolKey.toBase58()});
            return;
        }

        console.log(✅ Swap Successful! Transaction: https://solscan.io/tx/${swapSignature});

        activeTrades[tradeKey] = {
            entryPrice: entryPrice,
            stopLoss: entryPrice * 0.7,
            takeProfit2x: entryPrice * 2,
            amount: tradeAmountLamports,
        };

        console.log("📊 Trade Added to Active Trades:", activeTrades);

    } catch (error) {
        console.error("❌ Error in autoTrade:", error);
    }
}


const startServer = async () => {
    try {
        console.log("🚀 Initializing Bot...");
        
        // Load Keypair from Private Key instead of Mnemonic
        walletKeypair = await getKeypairFromPrivateKey();
      
        if (!walletKeypair) {
            throw new Error("❌ Failed to generate wallet keypair.");
        }

        console.log(✅ Wallet Initialized: ${walletKeypair.publicKey.toBase58()});

        monitorPrices();
    } catch (error) {
        console.error("❌ Fatal Error:", error);
    }
};

startServer();
