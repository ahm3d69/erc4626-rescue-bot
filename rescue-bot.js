/**
 * rescue-bot.js — Light & Clean
 * - ESM (Node 18+)
 * - ethers v6
 * - WS auto-reconnect (safe checks)
 * - Event-delta redeem (Option A)
 *
 * .env expected:
 * RPC_WS=...
 * RPC_HTTP=...
 * PRIVATE_KEY=0x...
 * OWNER_ADDRESS=0x...
 * VAULT_ADDRESS=0x...
 * TOKEN_ADDRESS=0x...    (optional)
 * DRY_RUN=true|false
 * MAX_RETRIES=6
 * INITIAL_GAS_GWEI=5
 * MAX_GAS_GWEI=80
 * RETRY_BASE_MS=10000
 */

import 'dotenv/config';
import { ethers } from 'ethers';

// -------------------- config (from .env) --------------------
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
  RETRY_BASE_MS = '10000'
} = process.env;

if (!RPC_WS || !RPC_HTTP || !PRIVATE_KEY || !OWNER_ADDRESS || !VAULT_ADDRESS) {
  console.error('Missing required env vars. Check .env (RPC_WS, RPC_HTTP, PRIVATE_KEY, OWNER_ADDRESS, VAULT_ADDRESS).');
  process.exit(1);
}

const dryRun = String(DRY_RUN).toLowerCase() === 'true';
const maxRetries = Number(MAX_RETRIES);
let gasGweiStart = Number(INITIAL_GAS_GWEI);
const gasGweiCap = Number(MAX_GAS_GWEI);
const retryBaseMs = Number(RETRY_BASE_MS);

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

// Vault contract (HTTP) - used for reads and sending tx via wallet/httpProvider
const vault = new ethers.Contract(VAULT_ADDRESS, ERC4626_ABI, httpProvider);

// Underlying token optional (for nicer logs)
const underlying = TOKEN_ADDRESS ? new ethers.Contract(TOKEN_ADDRESS, ERC20_ABI, httpProvider) : null;

// -------------------- WS provider with reconnect & event attach --------------------
let wsProvider = null;
let vaultWs = null;
let reconnectAttempts = 0;
let attached = false;

function safeLog(...args) { console.log(new Date().toISOString(), ...args); }

function createWsProvider() {
  safeLog('[WS] Creating WebSocketProvider ->', RPC_WS);
  try {
    wsProvider = new ethers.WebSocketProvider(RPC_WS);
  } catch (e) {
    safeLog('[WS] provider creation failed:', e?.message ?? e);
    scheduleReconnect();
    return;
  }

  // In some environments _websocket may not be exposed; guard access
  const rawWs = wsProvider?._websocket;

  if (rawWs && rawWs.addEventListener) {
    // modern websockets support
    rawWs.addEventListener('open', () => {
      safeLog('[WS] connected');
      reconnectAttempts = 0;
      attachVaultEventsSafe();
    });
    rawWs.addEventListener('close', (ev) => {
      safeLog('[WS] closed', ev?.code ?? '', ev?.reason ?? '');
      scheduleReconnect();
    });
    rawWs.addEventListener('error', (err) => {
      safeLog('[WS] error', err?.message ?? err);
      // attempt reconnect - provider may auto-reconnect, but schedule to be safe
      scheduleReconnect();
    });
  } else {
    // If internal websocket not accessible, still attempt to attach events - ethers v6 manages reconnect internally.
    safeLog('[WS] low-level websocket not exposed; attaching events and relying on provider auto-reconnect.');
    attachVaultEventsSafe();
  }
  // create contract bound to ws provider
  try {
    vaultWs = new ethers.Contract(VAULT_ADDRESS, ERC4626_ABI, wsProvider);
  } catch (e) {
    safeLog('[WS] cannot create vaultWs:', e?.message ?? e);
  }
}

function scheduleReconnect() {
  reconnectAttempts++;
  const delay = Math.min(30000, 1000 * Math.pow(2, reconnectAttempts)); // exponential backoff up to 30s
  safeLog(`[WS] scheduling reconnect attempt #${reconnectAttempts} in ${delay}ms`);
  setTimeout(() => {
    // Clean up previous provider if any
    try { wsProvider?._websocket?.close?.(); } catch {}
    createWsProvider();
  }, delay);
}

function clearVaultListeners() {
  try {
    if (vaultWs && attached) {
      // remove all listeners we added so duplicate handlers won't accumulate
      vaultWs.removeAllListeners('Deposit');
      vaultWs.removeAllListeners('Withdraw');
      vaultWs.removeAllListeners('Transfer');
      attached = false;
      safeLog('[WS] removed previous event listeners');
    }
  } catch (e) {
    safeLog('[WS] error removing listeners:', e?.message ?? e);
  }
}

function attachVaultEventsSafe() {
  // detach previous listeners first
  clearVaultListeners();
  if (!vaultWs) {
    // create the contract if it doesn't exist
    try { vaultWs = new ethers.Contract(VAULT_ADDRESS, ERC4626_ABI, wsProvider); } catch (e) {
      safeLog('[WS] failed to instantiate vaultWs:', e?.message ?? e);
      return;
    }
  }

  // Attach event handlers
  vaultWs.on('Deposit', async (caller, owner, assets, shares, ev) => {
    try {
      safeLog('[EVENT] Deposit detected: assets=', assets.toString(), 'shares=', shares.toString());
      // Use event-delta redeem: assets is amount added; convert to shares if possible
      await handleDepositEvent(assets);
    } catch (e) {
      safeLog('[EVENT] Deposit handler error:', e?.message ?? e);
    }
  });

  vaultWs.on('Transfer', async (from, to, value, ev) => {
    try {
      if (to && to.toLowerCase() === VAULT_ADDRESS.toLowerCase()) {
        safeLog('[EVENT] Inbound Transfer detected:', value.toString(), 'from=', from);
        await handleInboundTransfer(value);
      }
    } catch (e) {
      safeLog('[EVENT] Transfer handler error:', e?.message ?? e);
    }
  });

  vaultWs.on('Withdraw', async (caller, receiver, assets, shares, ev) => {
    try {
      safeLog('[EVENT] Withdraw detected - triggering standard rescue check');
      // On withdraw, re-run patrol logic to see if liquidity changed for us
      await patrolRescue();
    } catch (e) {
      safeLog('[EVENT] Withdraw handler error:', e?.message ?? e);
    }
  });

  attached = true;
  safeLog('[WS] event listeners attached');
}

// start WS provider initially
createWsProvider();

// -------------------- Small helpers --------------------
const sleep = (ms) => new Promise(res => setTimeout(res, ms));
const toBigInt = (v) => (typeof v === 'bigint' ? v : BigInt(v?.toString?.() ?? 0));
const formatUnitsSafe = (bn, d=18) => {
  try { return ethers.formatUnits(bn, d); } catch { return bn.toString(); }
};

// safe gas selection (prefer feeData.maxFeePerGas, fallback to gasPrice)
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

// -------------------- Event handlers: convert assets -> shares --------------------
async function assetsToShares(assets) {
  // Try convertToShares if available, otherwise approximate 1:1 (may be wrong but usable)
  try {
    if (typeof vault.convertToShares === 'function') {
      const s = await vault.convertToShares(assets);
      return toBigInt(s);
    }
  } catch (e) {
    // method may not exist or revert; fallback
  }
  // Fallback: attempt convert via calling preview functions or assume 1:1
  // Best-effort: if convertToShares not present, assume 1:1 (common for many vaults)
  return toBigInt(assets);
}

// -------------------- Core redeem logic --------------------
async function attemptRedeemShares(shares, reason = 'manual') {
  shares = toBigInt(shares);
  if (shares <= 0n) {
    safeLog('[REDEEM] zero shares requested, abort');
    return false;
  }

  const signer = await wallet.getAddress();
  let attempt = 0;
  let gasGwei = gasGweiStart;

  safeLog(`[REDEEM] Attempting redeem ${shares.toString()} shares (reason=${reason})`);

  while (attempt < maxRetries) {
    attempt++;
    try {
      const data = vault.interface.encodeFunctionData('redeem', [shares, OWNER_ADDRESS, signer]);
      const callReq = { to: VAULT_ADDRESS, data, from: signer };

      // simulate call to catch early reverts
      try { await httpProvider.call(callReq); } catch (simErr) { /* ok - may revert due to liquidity */ }

      // estimate gas
      let gasLimit;
      try {
        const est = await httpProvider.estimateGas(callReq);
        gasLimit = BigInt(Math.floor(Number(est) * 1.20));
      } catch {
        gasLimit = 600000n;
      }

      // pick gas
      let gasPrice = await getGasPrice(gasGwei);
      const cap = BigInt(Math.floor(gasGweiCap * 1e9));
      if (gasPrice > cap) gasPrice = cap;

      const tx = { to: VAULT_ADDRESS, data, gasLimit, gasPrice };

      if (dryRun) {
        safeLog('[DRY RUN] Would send redeem tx:', { shares: shares.toString(), gasPrice: gasPrice.toString() });
        return false;
      }

      const sent = await wallet.sendTransaction(tx);
      safeLog('[REDEEM] Sent tx:', sent.hash, 'attempt', attempt);

      const receipt = await sent.wait(1);
      if (receipt && receipt.status === 1n) {
        safeLog('[REDEEM] SUCCESS:', receipt.transactionHash, 'shares redeemed:', shares.toString());
        return true;
      } else {
        safeLog('[REDEEM] Tx mined but reverted (status != 1) - will retry if attempts remain');
      }
    } catch (err) {
      safeLog('[REDEEM] Attempt error:', err?.message ?? err);
    }

    // backoff & bump gas
    const waitMs = Math.min(60000, Math.floor(retryBaseMs * Math.pow(1.6, attempt)));
    safeLog(`[REDEEM] Waiting ${waitMs}ms before retry (attempt ${attempt}/${maxRetries}). Bumping gas from ${gasGwei}gwei`);
    await sleep(waitMs);
    gasGwei = Math.min(gasGweiCap, Math.round(gasGwei * 1.5));
  }

  safeLog('[REDEEM] All attempts exhausted for this redeem call');
  return false;
}

// -------------------- Event-driven operations --------------------

// When a Deposit event arrives - try to redeem the assets amount that was added
async function handleDepositEvent(assets) {
  const assetsBI = toBigInt(assets);
  if (assetsBI <= 0n) {
    safeLog('[EVENT] deposit assets is zero, ignoring');
    return;
  }

  // Convert assets -> shares to redeem
  let sharesToRedeem = assetsBI;
  try {
    sharesToRedeem = await assetsToShares(assetsBI);
  } catch (e) {
    safeLog('[EVENT] convertToShares failed, using assets as shares fallback');
    sharesToRedeem = assetsBI;
  }

  // But also cap by maxRedeem(signer) to avoid over-request
  try {
    const signer = await wallet.getAddress();
    const maxR = await vault.maxRedeem(signer);
    if (maxR === 0n) {
      safeLog('[EVENT] maxRedeem reports 0 (no withdrawable liquidity) - skipping redeem for now');
      return;
    }
    if (sharesToRedeem > maxR) sharesToRedeem = maxR;
  } catch (e) {
    safeLog('[EVENT] maxRedeem check failed; proceeding with computed sharesToRedeem:', sharesToRedeem.toString());
  }

  safeLog('[EVENT] Attempting event-delta redeem shares=', sharesToRedeem.toString());
  await attemptRedeemShares(sharesToRedeem, 'deposit-event');
}

// When an inbound Transfer (to vault) occurs
async function handleInboundTransfer(value) {
  const valueBI = toBigInt(value);
  if (valueBI <= 0n) return;
  // Convert to shares and attempt redeem similar to deposit
  let shares = valueBI;
  try {
    shares = await assetsToShares(valueBI);
  } catch {
    shares = valueBI;
  }

  try {
    const signer = await wallet.getAddress();
    const maxR = await vault.maxRedeem(signer);
    if (maxR === 0n) {
      safeLog('[EVENT] maxRedeem=0 after transfer - skipping');
      return;
    }
    if (shares > maxR) shares = maxR;
  } catch (e) {
    safeLog('[EVENT] maxRedeem check failed; proceeding with computed shares:', shares.toString());
  }

  safeLog('[EVENT] Attempting inbound-transfer redeem shares=', shares.toString());
  await attemptRedeemShares(shares, 'transfer-event');
}

// Periodic/manual patrol: check maxRedeem and redeem that amount (partial redeem mode)
async function patrolRescue() {
  try {
    const signer = await wallet.getAddress();
    const availableShares = await vault.maxRedeem(signer);
    if (availableShares > 0n) {
      safeLog('[PATROL] maxRedeem shows available shares:', availableShares.toString());
      await attemptRedeemShares(availableShares, 'patrol');
    } else {
      safeLog('[PATROL] No liquidity available on patrol');
    }
  } catch (e) {
    safeLog('[PATROL] patrol failed:', e?.message ?? e);
  }
}

// -------------------- Startup / initial check --------------------
(async function main() {
  try {
    const signer = await wallet.getAddress();
    safeLog('Starting rescue-bot (Light & Clean)');
    safeLog('Signer:', signer);
    safeLog('Vault:', VAULT_ADDRESS);
    if (underlying) {
      try {
        const sym = await underlying.symbol();
        const dec = Number(await underlying.decimals());
        safeLog('Underlying token:', sym, 'decimals=', dec);
      } catch {}
    }

    // initial check (patrol)
    await patrolRescue();
    safeLog('[STARTUP] waiting for events (Deposit / Transfer / Withdraw)');
  } catch (e) {
    safeLog('Fatal startup error:', e?.message ?? e);
    process.exit(1);
  }
})().catch(e => {
  safeLog('Unhandled main error', e?.message ?? e);
  process.exit(1);
});
