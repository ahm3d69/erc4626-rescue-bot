/**
 * rescue-bot.js
 * ESM / Node 18+ / ethers v6
 *
 * Usage:
 * - Ensure package.json has: "type": "module"
 * - npm install
 * - Copy .env from .env.example and fill values
 * - npm start
 *
 * NOTES:
 * - Keep your PRIVATE_KEY only in .env on your server.
 * - DRY_RUN=true to test without sending transactions.
 */

import 'dotenv/config';
import { ethers } from 'ethers';

// ---------- Config (from .env) ----------
const {
  RPC_WS,
  RPC_HTTP,
  PRIVATE_KEY,
  OWNER_ADDRESS,
  VAULT_ADDRESS,
  TOKEN_ADDRESS,
  DRY_RUN = 'true',
  MAX_RETRIES = '3',
  INITIAL_GAS_GWEI = '0.1',
  MAX_GAS_GWEI = '1.5',
  RETRY_BASE_MS = '15000'
} = process.env;

if (!RPC_WS || !RPC_HTTP || !PRIVATE_KEY || !OWNER_ADDRESS || !VAULT_ADDRESS) {
  console.error('Missing required env vars. Please set RPC_WS, RPC_HTTP, PRIVATE_KEY, OWNER_ADDRESS, VAULT_ADDRESS.');
  process.exit(1);
}

const dryRun = String(DRY_RUN).toLowerCase() === 'true';
const maxRetries = Number(MAX_RETRIES);
let gasGweiStart = Number(INITIAL_GAS_GWEI);
const gasGweiCap = Number(MAX_GAS_GWEI);
const retryBaseMs = Number(RETRY_BASE_MS);

// ---------- ABIs ----------
const ERC4626_ABI = [
  // events
  "event Deposit(address indexed caller, address indexed owner, uint256 assets, uint256 shares)",
  "event Withdraw(address indexed caller, address indexed receiver, uint256 assets, uint256 shares)",
  // methods
  "function maxWithdraw(address owner) external view returns (uint256)",
  "function maxRedeem(address owner) external view returns (uint256)",
  "function previewWithdraw(uint256 assets) external view returns (uint256)",
  "function withdraw(uint256 assets, address receiver, address owner) external returns (uint256)",
  "function redeem(uint256 shares, address receiver, address owner) external returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function totalAssets() view returns (uint256)",
  "function decimals() view returns (uint8)"
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)"
];

// ---------- Providers & wallet (ethers v6) ----------
const wsProvider = new ethers.WebSocketProvider(RPC_WS);
const httpProvider = new ethers.JsonRpcProvider(RPC_HTTP);
const wallet = new ethers.Wallet(PRIVATE_KEY, httpProvider);

// ---------- Contracts ----------
const vault = new ethers.Contract(VAULT_ADDRESS, ERC4626_ABI, httpProvider);
const vaultWs = new ethers.Contract(VAULT_ADDRESS, ERC4626_ABI, wsProvider);
const underlying = TOKEN_ADDRESS ? new ethers.Contract(TOKEN_ADDRESS, ERC20_ABI, httpProvider) : null;

// ---------- Helper utilities ----------
const sleep = (ms) => new Promise(res => setTimeout(res, ms));
const toBigInt = (v) => (typeof v === 'bigint' ? v : BigInt(v?.toString?.() ?? 0));
const formatWei = (bn, decimals=18) => {
  try {
    return ethers.formatUnits(bn, decimals);
  } catch {
    return bn.toString();
  }
};

async function currentGasPriceOrFallback(preferredGwei) {
  // Try provider.getFeeData() first (handles EIP-1559 chains); fall back to getGasPrice if present.
  try {
    const feeData = await httpProvider.getFeeData();
    // If maxFeePerGas exists, prefer it (return as BigInt)
    if (feeData.maxFeePerGas) return toBigInt(feeData.maxFeePerGas);
  } catch {}
  // fallback
  try {
    const gp = await httpProvider.getGasPrice();
    if (gp) return toBigInt(gp);
  } catch {}
  // fallback to user-provided gwei
  return BigInt(Math.floor(preferredGwei * 1e9));
}

// ---------- Main ----------
(async function main() {
  const signerAddress = await wallet.getAddress();
  console.log('--- ERC-4626 Rescue Bot (ESM / ethers v6) ---');
  console.log('Signer:', signerAddress);
  console.log('Owner (destination):', OWNER_ADDRESS);
  console.log('Vault:', VAULT_ADDRESS);
  if (underlying) {
    try {
      const sym = await underlying.symbol();
      const dec = await underlying.decimals();
      console.log(`Underlying token: ${sym} (decimals ${dec})`);
    } catch (e) {
      console.log('Underlying token read failed:', e?.message ?? e);
    }
  }
  console.log('Dry run:', dryRun);
  console.log('Max retries per trigger:', maxRetries);
  console.log('Initial gas (gwei):', gasGweiStart, 'Cap (gwei):', gasGweiCap);

  // WS connection events
  wsProvider._websocket.on('open', () => console.log('WebSocket connected.'));
  wsProvider._websocket.on('close', (code, reason) => {
    console.warn('WebSocket closed:', code, reason?.toString?.());
    // Exit so systemd / pm2 / docker can restart the process (safer than silent reconnect attempts).
    process.exit(1);
  });

  // subscribe to events
  vaultWs.on('Deposit', (caller, owner, assets, shares, ev) => {
    console.log(`[Event] Deposit caller=${caller} owner=${owner} assets=${assets.toString()} shares=${shares.toString()}`);
    triggerRescueAttempt('Deposit event');
  });

  vaultWs.on('Withdraw', (caller, receiver, assets, shares, ev) => {
    console.log(`[Event] Withdraw caller=${caller} receiver=${receiver} assets=${assets.toString()} shares=${shares.toString()}`);
    triggerRescueAttempt('Withdraw event');
  });

  // Many vaults are ERC20 shares; listen to Transfer too
  vaultWs.on('Transfer', (from, to, value, ev) => {
    console.log(`[Event] Transfer from=${from} to=${to} value=${value.toString()}`);
    triggerRescueAttempt('Transfer event');
  });

  // initial trigger on startup
  console.log('Checking initial balances and attempting rescue if needed...');
  await triggerRescueAttempt('startup');
})().catch(e => {
  console.error('Fatal error in main():', e);
  process.exit(1);
});

// Prevent reentrancy: only one rescue loop runs at a time
let rescueInProgress = false;
let lastTriggerReason = null;

async function triggerRescueAttempt(reason = 'unknown') {
  if (rescueInProgress) {
    lastTriggerReason = reason;
    console.log('Rescue already running. Recorded last trigger reason:', reason);
    return;
  }
  rescueInProgress = true;
  lastTriggerReason = reason;
  try {
    await attemptRescueLoop();
  } catch (e) {
    console.error('Rescue loop error:', e);
  } finally {
    rescueInProgress = false;
  }
}

async function attemptRescueLoop() {
  const signerAddress = await wallet.getAddress();
  console.log(`--- Rescue attempt started (trigger: ${lastTriggerReason}) ---`);

  // Read share balance on vault (many vaults are ERC20 shares)
  let shareBalance = 0n;
  let vaultDecimals = 18;
  try {
    const b = await vault.balanceOf(signerAddress);
    shareBalance = toBigInt(b);
    try { vaultDecimals = Number(await vault.decimals()); } catch {}
    console.log(`Vault shares: ${formatWei(shareBalance, vaultDecimals)} (raw ${shareBalance.toString()})`);
  } catch (e) {
    console.log('Could not read vault shares:', e?.message ?? e);
  }

  // Read underlying balance (optional)
  let underlyingBalance = 0n;
  let underlyingDecimals = 18;
  if (underlying) {
    try {
      const ub = await underlying.balanceOf(signerAddress);
      underlyingBalance = toBigInt(ub);
      try { underlyingDecimals = Number(await underlying.decimals()); } catch {}
      console.log(`Underlying token balance: ${formatWei(underlyingBalance, underlyingDecimals)} (raw ${underlyingBalance.toString()})`);
    } catch (e) {
      console.log('Could not read underlying balance:', e?.message ?? e);
    }
  }

  if (shareBalance === 0n && underlyingBalance === 0n) {
    console.log('No shares and no underlying tokens to rescue. Exiting attempt.');
    return;
  }

  // Determine action: prefer redeem(shares) when we have shares; otherwise try withdraw(assets)
  if (shareBalance > 0n) {
    console.log('Attempting repeated redeem(shares)...');
    await repeatedlyTryRedeem(shareBalance);
  } else {
    console.log('No shares; attempting repeated withdraw(assets)...');
    await repeatedlyTryWithdraw(underlyingBalance);
  }
}

async function repeatedlyTryRedeem(shares) {
  const signerAddress = await wallet.getAddress();
  let attempt = 0;
  let gasGwei = gasGweiStart;

  while (attempt < maxRetries) {
    attempt++;
    console.log(`redeem attempt ${attempt}/${maxRetries} shares=${shares.toString()} gasGwei=${gasGwei}`);

    try {
      const data = vault.interface.encodeFunctionData('redeem', [shares, OWNER_ADDRESS, signerAddress]);
      const txForCall = { to: VAULT_ADDRESS, data, from: signerAddress };

      // simulate call to get faster revert reason (won't change chain state)
      try {
        await httpProvider.call(txForCall);
      } catch (callErr) {
        // eth_call may revert for insufficient liquidity; we still attempt on-chain
        console.log('Call simulation reverted or returned error (ok):', callErr?.message ?? callErr);
      }

      // estimate gas
      let gasLimit;
      try {
        const est = await httpProvider.estimateGas(txForCall);
        gasLimit = BigInt(Math.floor(Number(est) * 1.20)); // bump 20%
      } catch (estErr) {
        console.warn('Gas estimate failed, using fallback gasLimit 600000:', estErr?.message ?? estErr);
        gasLimit = 600000n;
      }

      // determine gas price (legacy or maxFee approach)
      let gasPrice = await currentGasPriceOrFallback(gasGwei);

      // cap gas price
      const cap = BigInt(Math.floor(gasGweiCap * 1e9));
      if (gasPrice > cap) gasPrice = cap;

      const tx = {
        to: VAULT_ADDRESS,
        data,
        gasLimit,
        gasPrice
