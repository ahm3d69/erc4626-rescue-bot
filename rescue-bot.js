// Updated rescue-bot.js with Option A: redeem only available liquidity

import 'dotenv/config';
import { ethers } from 'ethers';

// ---------------------------------------------------------
// ENV VARS
// ---------------------------------------------------------
const {
  RPC_WS,
  RPC_HTTP,
  PRIVATE_KEY,
  OWNER_ADDRESS,
  VAULT_ADDRESS,
  TOKEN_ADDRESS,
  DRY_RUN = 'true',
  MAX_RETRIES = '12',
  INITIAL_GAS_GWEI = '5',
  MAX_GAS_GWEI = '80',
  RETRY_BASE_MS = '15000'
} = process.env;

if (!RPC_WS || !RPC_HTTP || !PRIVATE_KEY || !OWNER_ADDRESS || !VAULT_ADDRESS) {
  console.error("Missing environment variables. Check .env");
  process.exit(1);
}

const dryRun = DRY_RUN.toLowerCase() === "true";
const maxRetries = Number(MAX_RETRIES);
const gasStart = Number(INITIAL_GAS_GWEI);
const gasCap = Number(MAX_GAS_GWEI);
const retryBaseMs = Number(RETRY_BASE_MS);

// ---------------------------------------------------------
// ABIs
// ---------------------------------------------------------
const ERC4626_ABI = [
  "event Deposit(address indexed caller, address indexed owner, uint256 assets, uint256 shares)",
  "event Withdraw(address indexed caller, address indexed receiver, uint256 assets, uint256 shares)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",

  "function redeem(uint256 shares, address receiver, address owner) external returns (uint256)",
  "function maxRedeem(address owner) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function convertToShares(uint256 assets) view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function decimals() view returns (uint8)"
];

// ---------------------------------------------------------
// Providers
// ---------------------------------------------------------
const wsProvider = new ethers.WebSocketProvider(RPC_WS);
const httpProvider = new ethers.JsonRpcProvider(RPC_HTTP);

// wallet (signer)
const wallet = new ethers.Wallet(PRIVATE_KEY, httpProvider);

// Contracts
const vault = new ethers.Contract(VAULT_ADDRESS, ERC4626_ABI, httpProvider);
const vaultWs = new ethers.Contract(VAULT_ADDRESS, ERC4626_ABI, wsProvider);

// ---------------------------------------------------------
// Helpers
// ---------------------------------------------------------
const sleep = (ms) => new Promise(res => setTimeout(res, ms));

async function getSafeGasPrice(gweiPreferred) {
  try {
    const fee = await httpProvider.getFeeData();
    if (fee.maxFeePerGas) return fee.maxFeePerGas;
  } catch {}

  try {
    const gp = await httpProvider.getGasPrice();
    if (gp) return gp;
  } catch {}

  return BigInt(Math.floor(gweiPreferred * 1e9));
}

// ---------------------------------------------------------
// Rescue Logic Option A: redeem exact available liquidity
// ---------------------------------------------------------
let rescueRunning = false;
let rescueReason = "startup";

async function triggerRescue(reason) {
  if (rescueRunning) return;
  rescueRunning = true;
  rescueReason = reason;

  try {
    await rescueAvailableLiquidity();
  } catch (e) {
    console.error("RESCUE ERROR:", e);
  } finally {
    rescueRunning = false;
  }
}

async function rescueAvailableLiquidity() {
  const signer = await wallet.getAddress();
  console.log(`\n--- Rescue triggered by: ${rescueReason} ---`);

  let maxShares;
  try {
    maxShares = await vault.maxRedeem(signer);
  } catch {
    console.error("Cannot read maxRedeem");
    return;
  }

  if (maxShares === 0n) {
    console.log("No liquidity available yet — waiting for next event");
    return;
  }

  console.log(`Liquidity available! Trying redeem of ${maxShares.toString()} shares.`);

  await attemptRedeem(maxShares);
}

// ---------------------------------------------------------
// Core redeem engine
// ---------------------------------------------------------
async function attemptRedeem(shares) {
  const signer = await wallet.getAddress();
  let gasGwei = gasStart;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const data = vault.interface.encodeFunctionData("redeem", [
        shares,
        OWNER_ADDRESS,
        signer
      ]);

      const callRequest = { to: VAULT_ADDRESS, data, from: signer };

      try { await httpProvider.call(callRequest); } catch {}

      let gasLimit;
      try {
        const est = await httpProvider.estimateGas(callRequest);
        gasLimit = BigInt(Math.floor(Number(est) * 1.25));
      } catch {
        gasLimit = 600000n;
      }

      let gasPrice = await getSafeGasPrice(gasGwei);
      const cap = BigInt(Math.floor(gasCap * 1e9));
      if (gasPrice > cap) gasPrice = cap;

      const tx = { to: VAULT_ADDRESS, data, gasLimit, gasPrice };

      if (dryRun) {
        console.log(`[DRY RUN] Would redeem available shares: ${shares}`);
        return;
      }

      const sent = await wallet.sendTransaction(tx);
      console.log("Sent redeem tx:", sent.hash);

      const rcpt = await sent.wait(1);
      if (rcpt.status === 1n) {
        console.log("Redeem SUCCESS:", rcpt.transactionHash);
        return;
      }

      console.warn("Redeem failed — retrying...");

    } catch (err) {
      console.warn(`Attempt #${attempt} error: ${err.message}`);
    }

    const delay = retryBaseMs * Math.pow(1.8, attempt);
    console.log(`Retry ${attempt}/${maxRetries}, waiting ${delay}ms ...`);
    await sleep(delay);
    gasGwei = Math.min(gasCap, Math.round(gasGwei * 1.5));
  }

  console.error("Max retries reached — stopping rescue for this event.");
}

// ---------------------------------------------------------
// MAIN
// ---------------------------------------------------------
(async function main() {
  const signer = await wallet.getAddress();
  console.log(`Running Rescue Bot for wallet: ${signer}`);
  console.log(`Vault: ${VAULT_ADDRESS}`);

  // Event-driven rescue
  vaultWs.on("Deposit", () => triggerRescue("Deposit"));
  vaultWs.on("Transfer", () => triggerRescue("Transfer"));
  vaultWs.on("Withdraw", () => triggerRescue("Withdraw"));

  // First attempt on startup
  await triggerRescue("startup");
})();
