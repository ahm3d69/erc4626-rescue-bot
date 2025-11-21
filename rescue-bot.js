/**
 * rescue-bot.js
 * Light & Clean — Event-Delta + Patrol + WS reconnect (ethers v6)
 *
 * .env expected:
 * RPC_WS=
 * RPC_HTTP=
 * PRIVATE_KEY=
 * OWNER_ADDRESS=
 * VAULT_ADDRESS=
 * TOKEN_ADDRESS=    (optional)
 * DRY_RUN=true|false
 * MAX_RETRIES=6
 * INITIAL_GAS_GWEI=5
 * MAX_GAS_GWEI=80
 * RETRY_BASE_MS=10000
 * ENABLE_PATROL=true|false
 * PATROL_INTERVAL=5000
 */

import 'dotenv/config';
import { ethers } from 'ethers';

// -------------------- Config --------------------
const {
  RPC_WS,
  RPC_HTTP,
  PRIVATE_KEY,
  OWNER_ADDRESS,
  VAULT_ADDRESS,
  TOKEN_ADDRESS,

  DRY_RUN = 'true',
  MAX_RETRIES = '6',
  INITIAL_GAS_GWEI = '5',
  MAX_GAS_GWEI = '80',
  RETRY_BASE_MS = '10000',

  ENABLE_PATROL = 'true',
  PATROL_INTERVAL = '5000'
} = process.env;

if (!RPC_WS || !RPC_HTTP || !PRIVATE_KEY || !OWNER_ADDRESS || !VAULT_ADDRESS) {
  console.error('Missing required env vars. Check .env (RPC_WS,RPC_HTTP,PRIVATE_KEY,OWNER_ADDRESS,VAULT_ADDRESS)');
  process.exit(1);
}

const dryRun = String(DRY_RUN).toLowerCase() === 'true';
const maxRetries = Number(MAX_RETRIES);
let gasGweiStart = Number(INITIAL_GAS_GWEI);
const gasGweiCap = Number(MAX_GAS_GWEI);
const retryBaseMs = Number(RETRY_BASE_MS);

const patrolEnabled = String(ENABLE_PATROL).toLowerCase() === 'true';
const patrolMs = Number(PATROL_INTERVAL);

// -------------------- ABIs --------------------
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

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)"
];

// -------------------- HTTP provider & wallet --------------------
const httpProvider = new ethers.JsonRpcProvider(RPC_HTTP);
const wallet = new ethers.Wallet(PRIVATE_KEY, httpProvider);
const vault = new ethers.Contract(VAULT_ADDRESS, ERC4626_ABI, httpProvider);
const underlying = TOKEN_ADDRESS ? new ethers.Contract(TOKEN_ADDRESS, ERC20_ABI, httpProvider) : null;

// -------------------- WS provider wrapper (no _websocket access) --------------------
let wsProvider = null;
let vaultWs = null;
let wsRetryCount = 0;
const WS_RETRY_MAX_DELAY = 30000; // cap at 30s

const safeLog = (...args) => console.log(new Date().toISOString(), ...args);

function scheduleWsReconnect(delayMs = 2000) {
  const delay = Math.min(WS_RETRY_MAX_DELAY, delayMs);
  safeLog('[WS] scheduling reconnect in', delay, 'ms');
  setTimeout(() => {
    tryCreateWs();
  }, delay);
}

function tryCreateWs() {
  try {
    safeLog('[WS] creating WebSocketProvider ->', RPC_WS);
    // Create provider - ethers v6 handles reconnection internally to some extent.
    wsProvider = new ethers.WebSocketProvider(RPC_WS);

    // create vaultWs contract bound to WS provider
    vaultWs = new ethers.Contract(VAULT_ADDRESS, ERC4626_ABI, wsProvider);

    // Attach event listeners (safe attach)
    attachWsEventHandlers();

    // reset retry counter on successful create
    wsRetryCount = 0;
    safeLog('[WS] provider created and event handlers attached');
  } catch (err) {
    wsRetryCount++;
    safeLog('[WS] provider creation failed:', err?.message ?? err);
    // exponential backoff
    const nextDelay = Math.min(WS_RETRY_MAX_DELAY, 1000 * Math.pow(2, wsRetryCount));
    scheduleWsReconnect(nextDelay);
  }
}

function attachWsEventHandlers() {
  if (!vaultWs) {
    safeLog('[WS] vaultWs not available to attach events');
    return;
  }

  // remove previous handlers if present to avoid duplicates
  try {
    vaultWs.removeAllListeners('Deposit');
    vaultWs.removeAllListeners('Transfer');
    vaultWs.removeAllListeners('Withdraw');
  } catch (e) { /* ignore */ }

  vaultWs.on('Deposit', async (caller, owner, assets, shares, event) => {
    try {
      safeLog('[EVENT] Deposit detected: assets=', assets.toString(), 'shares=', shares.toString());
      await handleDepositEvent(assets);
    } catch (e) {
      safeLog('[EVENT] Deposit handler error:', e?.message ?? e);
    }
  });

  vaultWs.on('Transfer', async (from, to, value, event) => {
    try {
      if (to && to.toLowerCase() === VAULT_ADDRESS.toLowerCase()) {
        safeLog('[EVENT] Inbound Transfer detected:', value.toString(), 'from=', from);
        await handleInboundTransfer(value);
      }
    } catch (e) {
      safeLog('[EVENT] Transfer handler error:', e?.message ?? e);
    }
  });

  vaultWs.on('Withdraw', async (caller, receiver, assets, shares, event) => {
    try {
      safeLog('[EVENT] Withdraw detected - running patrol/rescue check');
      await patrolRescue();
    } catch (e) {
      safeLog('[EVENT] Withdraw handler error:', e?.message ?? e);
    }
  });

  // Optionally listen to provider 'error' (ethers may or may not emit)
  try {
    wsProvider.on?.('error', (err) => {
      safeLog('[WS] provider error:', err?.message ?? err);
      // schedule reconnect attempt (do not crash)
      scheduleWsReconnect(2000);
    });
  } catch (e) {
    // ignore if provider doesn't support .on
  }
}

// Start WS provider (attempt)
tryCreateWs();

// -------------------- Helpers --------------------
const sleep = (ms) => new Promise(res => setTimeout(res, ms));
const toBigInt = (v) => (typeof v === 'bigint' ? v : BigInt(v?.toString?.() ?? 0));
const formatUnitsSafe = (bn, d = 18) => {
  try { return ethers.formatUnits(bn, d); } catch { return bn.toString(); }
};

async function getGasPrice(preferredGwei) {
  try {
    const fee = await httpProvider.getFeeData();
    if (fee.maxFeePerGas) return toBigInt(fee.maxFeePerGas);
  } catch {}
  try {
    const gp = await httpProvider.getGasPrice();
    if (gp) return toBigInt(gp);
  } catch {}
  return BigInt(Math.floor(preferredGwei * 1e9));
}

// Try convert assets -> shares using convertToShares if contract exposes it
async function assetsToShares(assets) {
  try {
    if (vault.convertToShares) {
      const s = await vault.convertToShares(assets);
      return toBigInt(s);
    }
  } catch (e) {
    // ignore and fallback
  }
  // fallback 1:1
  return toBigInt(assets);
}

// -------------------- Core redeem logic --------------------
async function attemptRedeemShares(shares, reason = 'manual') {
  shares = toBigInt(shares);
  if (shares <= 0n) {
    safeLog('[REDEEM] zero shares requested - skipping');
    return false;
  }

  const signer = await wallet.getAddress();
  safeLog(`[REDEEM] try redeem ${shares.toString()} shares (reason=${reason})`);

  let attempt = 0;
  let gasGwei = gasGweiStart;

  while (attempt < maxRetries) {
    attempt++;
    try {
      const calldata = vault.interface.encodeFunctionData('redeem', [shares, OWNER_ADDRESS, signer]);
      const callReq = { to: VAULT_ADDRESS, data: calldata, from: signer };

      // simulate
      try { await httpProvider.call(callReq); } catch (simErr) { /* simulation may revert - ok */ }

      // estimate gas
      let gasLimit;
      try {
        const est = await httpProvider.estimateGas(callReq);
        gasLimit = BigInt(Math.floor(Number(est) * 1.2));
      } catch {
        gasLimit = 600000n;
      }

      let gasPrice = await getGasPrice(gasGwei);
      const cap = BigInt(Math.floor(gasGweiCap * 1e9));
      if (gasPrice > cap) gasPrice = cap;

      const tx = { to: VAULT_ADDRESS, data: calldata, gasLimit, gasPrice };

      if (dryRun) {
        safeLog('[DRY RUN] would send redeem tx', { shares: shares.toString(), gasPrice: gasPrice.toString() });
        return false;
      }

      const sent = await wallet.sendTransaction(tx);
      safeLog('[REDEEM] tx sent', sent.hash);
      const receipt = await sent.wait(1);

      if (receipt && receipt.status === 1n) {
        safeLog('[REDEEM] SUCCESS', receipt.transactionHash);
        return true;
      } else {
        safeLog('[REDEEM] tx reverted or failed (status != 1)');
      }
    } catch (err) {
      safeLog('[REDEEM] attempt error:', err?.message ?? err);
    }

    const waitMs = Math.min(60000, Math.floor(retryBaseMs * Math.pow(1.6, attempt)));
    safeLog(`[REDEEM] sleeping ${waitMs}ms before retry (attempt ${attempt}/${maxRetries})`);
    await sleep(waitMs);
    gasGwei = Math.min(gasGweiCap, Math.round(gasGwei * 1.5));
  }

  safeLog('[REDEEM] exhausted attempts for this redeem call');
  return false;
}

// -------------------- Event-Delta handlers --------------------
async function handleDepositEvent(assets) {
  const assetsBI = toBigInt(assets);
  if (assetsBI <= 0n) return safeLog('[EVENT] deposit assets 0, ignore');

  safeLog('[EVENT] deposit assets (raw):', assetsBI.toString());
  // convert assets -> shares if possible
  let shares = assetsBI;
  try {
    shares = await assetsToShares(assetsBI);
  } catch (e) {
    safeLog('[EVENT] convertToShares fallback, using assets as shares');
    shares = assetsBI;
  }

  // cap by maxRedeem for our signer
  try {
    const signer = await wallet.getAddress();
    const maxR = await vault.maxRedeem(signer);
    if (maxR === 0n) {
      safeLog('[EVENT] maxRedeem reports 0 - skipping redeem');
      return;
    }
    if (shares > maxR) shares = maxR;
  } catch (e) {
    safeLog('[EVENT] maxRedeem check failed - proceeding with shares computed');
  }

  safeLog('[EVENT] event-delta redeem shares=', shares.toString());
  await attemptRedeemShares(shares, 'deposit-event');
}

async function handleInboundTransfer(value) {
  const v = toBigInt(value);
  if (v <= 0n) return;
  safeLog('[EVENT] inbound transfer value=', v.toString());

  let shares = v;
  try { shares = await assetsToShares(v); } catch {}

  try {
    const signer = await wallet.getAddress();
    const maxR = await vault.maxRedeem(signer);
    if (maxR === 0n) {
      safeLog('[EVENT] maxRedeem=0 after transfer - skipping');
      return;
    }
    if (shares > maxR) shares = maxR;
  } catch (e) {
    safeLog('[EVENT] maxRedeem check failed; proceeding with shares:', shares.toString());
  }

  safeLog('[EVENT] inbound-transfer redeem shares=', shares.toString());
  await attemptRedeemShares(shares, 'transfer-event');
}

// -------------------- Patrol (periodic checks) --------------------
async function patrolRescue() {
  try {
    const signer = await wallet.getAddress();
    const available = await vault.maxRedeem(signer);
    if (available > 0n) {
      safeLog('[PATROL] redeemable shares found:', available.toString());
      await attemptRedeemShares(available, 'patrol');
    } else {
      safeLog('[PATROL] no liquidity currently');
    }
  } catch (e) {
    safeLog('[PATROL] error:', e?.message ?? e);
  }
}

async function startPatrolLoop() {
  if (!patrolEnabled) {
    safeLog('[PATROL] disabled via config');
    return;
  }
  safeLog('[PATROL] starting patrol every', patrolMs, 'ms');
  while (true) {
    try {
      await patrolRescue();
    } catch (e) {
      safeLog('[PATROL] unexpected error:', e?.message ?? e);
    }
    await sleep(patrolMs);
  }
}

// -------------------- Startup --------------------
(async function main() {
  try {
    const signer = await wallet.getAddress();
    safeLog('Starting rescue-bot (Light & Clean)');
    safeLog('Signer:', signer);
    safeLog('Vault:', VAULT_ADDRESS);
    if (underlying) {
      try {
        const sym = await underlying.symbol();
        const dec = await underlying.decimals();
        safeLog('Underlying token:', sym, 'decimals=', dec);
      } catch {}
    }

    // Kick off patrol loop (non-blocking)
    if (patrolEnabled) startPatrolLoop();

    safeLog('Waiting for Deposit / Transfer / Withdraw events (WS) + Patrol active');
  } catch (err) {
    safeLog('Fatal startup error:', err?.message ?? err);
    process.exit(1);
  }
})().catch(e => {
  safeLog('Unhandled main error', e?.message ?? e);
  process.exit(1);
});
