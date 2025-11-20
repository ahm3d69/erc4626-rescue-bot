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
  MAX_RETRIES = '12',
  INITIAL_GAS_GWEI = '5',
  MAX_GAS_GWEI = '80',
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
  "event Deposit(address indexed caller, address indexed owner, uint256 assets, uint256 shares)",
  "event Withdraw(address indexed caller, address indexed receiver, uint256 assets, uint256 shares)",
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

// ---------- Helpers ----------
const sleep = (ms) => new Promise(res => setTimeout(res, ms));
const toBigInt = (v) => (typeof v === 'bigint' ? v : BigInt(v?.toString?.() ?? 0));
const formatWei = (bn, decimals = 18) => ethers.formatUnits(bn, decimals);

async function currentGasPriceOrFallback(preferredGwei) {
  try {
    const fee = await httpProvider.getFeeData();
    if (fee.maxFeePerGas) return fee.maxFeePerGas;
  } catch {}
  try {
    const gp = await httpProvider.getGasPrice();
    if (gp) return gp;
  } catch {}
  return BigInt(Math.floor(preferredGwei * 1e9));
}

// ---------- Main ----------
(async function main() {
  const signer = await wallet.getAddress();
  console.log(`Running Rescue Bot for: ${signer}`);

  wsProvider._websocket.on('open', () => console.log('WS connected.'));
  wsProvider._websocket.on('close', () => {
    console.error('WS closed. Exit.');
    process.exit(1);
  });

  vaultWs.on('Deposit', () => triggerRescueAttempt('Deposit'));
  vaultWs.on('Withdraw', () => triggerRescueAttempt('Withdraw'));
  vaultWs.on('Transfer', () => triggerRescueAttempt('Transfer'));

  await triggerRescueAttempt('startup');
})();

let rescueInProgress = false;
let lastTriggerReason = null;

async function triggerRescueAttempt(reason) {
  if (rescueInProgress) {
    lastTriggerReason = reason;
    return;
  }
  rescueInProgress = true;
  lastTriggerReason = reason;

  try {
    await attemptRescueLoop();
  } catch (e) {
    console.error(e);
  } finally {
    rescueInProgress = false;
  }
}

async function attemptRescueLoop() {
  const signer = await wallet.getAddress();
  console.log(`--- Rescue triggered by: ${lastTriggerReason} ---`);

  let shares = 0n;
  try {
    shares = await vault.balanceOf(signer);
  } catch {}

  if (shares === 0n) {
    console.log("No vault shares to rescue.");
    return;
  }

  console.log(`Attempting redeem of ${shares}`);

  await repeatedlyTryRedeem(shares);
}

async function repeatedlyTryRedeem(shares) {
  const signer = await wallet.getAddress();
  let attempt = 0;
  let gasGwei = gasGweiStart;

  while (attempt < maxRetries) {
    attempt++;

    try {
      const data = vault.interface.encodeFunctionData("redeem", [
        shares,
        OWNER_ADDRESS,
        signer
      ]);

      const call = { to: VAULT_ADDRESS, data, from: signer };

      try { await httpProvider.call(call); } catch {}

      let gasLimit;
      try {
        const est = await httpProvider.estimateGas(call);
        gasLimit = BigInt(Math.floor(Number(est) * 1.2));
      } catch {
        gasLimit = 600000n;
      }

      let gasPrice = await currentGasPriceOrFallback(gasGwei);
      const cap = BigInt(Math.floor(gasGweiCap * 1e9));
      if (gasPrice > cap) gasPrice = cap;

      const tx = { to: VAULT_ADDRESS, data, gasLimit, gasPrice };

      if (dryRun) {
        console.log("[DRY RUN] redeem tx prepared");
        return;
      }

      const sent = await wallet.sendTransaction(tx);
      console.log("Sent redeem tx:", sent.hash);
      const receipt = await sent.wait(1);

      if (receipt.status === 1n) {
        console.log("Redeem successful:", receipt.transactionHash);
        return;
      }
    } catch (err) {
      console.error("redeem error:", err.message);
    }

    const wait = retryBaseMs * Math.pow(1.8, attempt);
    console.log(`Retry ${attempt}/${maxRetries}, wait ${wait}ms`);
    await sleep(wait);
    gasGwei = Math.min(gasGweiCap, Math.round(gasGwei * 1.6));
  }

  console.error("Redeem attempts exhausted.");
}
