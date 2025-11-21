import 'dotenv/config';
import { ethers } from 'ethers';

// ---------------------------------------------------------
// ENV CONFIG
// ---------------------------------------------------------
const {
  RPC_WS,
  RPC_HTTP,
  PRIVATE_KEY,
  OWNER_ADDRESS,
  VAULT_ADDRESS,
  TOKEN_ADDRESS,

  DRY_RUN = "true",
  MAX_RETRIES = "12",
  INITIAL_GAS_GWEI = "5",
  MAX_GAS_GWEI = "80",
  RETRY_BASE_MS = "12000",

  ENABLE_PATROL = "true",
  PATROL_INTERVAL = "5000"
} = process.env;

if (!RPC_WS || !RPC_HTTP || !PRIVATE_KEY || !OWNER_ADDRESS || !VAULT_ADDRESS) {
  console.error("Missing required .env variables");
  process.exit(1);
}

const dryRun = DRY_RUN.toLowerCase() === "true";
const patrolEnabled = ENABLE_PATROL.toLowerCase() === "true";

// ---------------------------------------------------------
// CONSTANTS
// ---------------------------------------------------------
const maxRetries = Number(MAX_RETRIES);
const gasStart = Number(INITIAL_GAS_GWEI);
const gasCap = Number(MAX_GAS_GWEI);
const retryBaseMs = Number(RETRY_BASE_MS);
const patrolMs = Number(PATROL_INTERVAL);

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
  "function decimals() view returns (uint8)"
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)"
];

// ---------------------------------------------------------
// PROVIDERS & CONTRACTS
// ---------------------------------------------------------
const httpProvider = new ethers.JsonRpcProvider(RPC_HTTP);

let wsProvider;
let vaultWs;

function createWsProvider() {
  console.log(new Date().toISOString(), "[WS] Creating WebSocketProvider ->", RPC_WS);
  wsProvider = new ethers.WebSocketProvider(RPC_WS);
  vaultWs = new ethers.Contract(VAULT_ADDRESS, ERC4626_ABI, wsProvider);

  wsProvider._websocket.on("close", () => {
    console.log(new Date().toISOString(), "[WS] disconnected — retrying in 3s");
    setTimeout(createWsProvider, 3000);
  });

  attachWsEvents();
}

function attachWsEvents() {
  console.log(new Date().toISOString(), "[WS] Attaching event listeners");

  vaultWs.on("Deposit", () => triggerRescue("Deposit"));
  vaultWs.on("Withdraw", () => triggerRescue("Withdraw"));
  vaultWs.on("Transfer", () => triggerRescue("Transfer"));
}

createWsProvider();

const wallet = new ethers.Wallet(PRIVATE_KEY, httpProvider);
const vault = new ethers.Contract(VAULT_ADDRESS, ERC4626_ABI, httpProvider);

const underlying = TOKEN_ADDRESS
  ? new ethers.Contract(TOKEN_ADDRESS, ERC20_ABI, httpProvider)
  : null;

// ---------------------------------------------------------
// HELPERS
// ---------------------------------------------------------
const sleep = (ms) => new Promise(res => setTimeout(res, ms));

async function getSafeGas(gweiPreferred) {
  try {
    const fee = await httpProvider.getFeeData();
    if (fee.gasPrice) return fee.gasPrice;
  } catch {}

  try {
    const gp = await httpProvider.getGasPrice();
    if (gp) return gp;
  } catch {}

  return BigInt(gweiPreferred * 1e9);
}

// ---------------------------------------------------------
// RESCUE LOGIC
// ---------------------------------------------------------
let rescueRunning = false;
let rescueReason = "";

async function triggerRescue(reason) {
  rescueReason = reason;

  if (rescueRunning) return; // prevent spam

  rescueRunning = true;
  try {
    await rescueOnce(reason);
  } catch (err) {
    console.log("[RESCUE ERROR]", err.message);
  }
  rescueRunning = false;
}

async function rescueOnce(reason) {
  const signer = await wallet.getAddress();

  console.log(new Date().toISOString(),
    `--- Rescue triggered by: ${reason} ---`
  );

  // how much is redeemable right now?
  let redeemable;
  try {
    redeemable = await vault.maxRedeem(signer);
  } catch {
    console.log("Cannot read maxRedeem()");
    return;
  }

  if (redeemable === 0n) {
    console.log("No liquidity available — waiting…");
    return;
  }

  console.log(`→ Trying redeem: ${redeemable} shares`);
  await attemptRedeemLoop(redeemable);
}

async function attemptRedeemLoop(shares) {
  const signer = await wallet.getAddress();
  let attempt = 0;
  let gasGwei = gasStart;

  while (attempt < maxRetries) {
    attempt++;

    try {
      const data = vault.interface.encodeFunctionData("redeem", [
        shares,
        OWNER_ADDRESS,
        signer
      ]);

      const callReq = { to: VAULT_ADDRESS, data, from: signer };

      try { await httpProvider.call(callReq); } catch {}

      // gas estimate
      let gasLimit;
      try {
        const est = await httpProvider.estimateGas(callReq);
        gasLimit = est * 2n;
      } catch {
        gasLimit = 700000n;
      }

      let gasPrice = await getSafeGas(gasGwei);
      const cap = BigInt(gasCap * 1e9);
      if (gasPrice > cap) gasPrice = cap;

      const tx = { to: VAULT_ADDRESS, data, gasLimit, gasPrice };

      if (dryRun) {
        console.log(`[DRY RUN] Would send redeem(gas=${gasPrice})`);
        return;
      }

      const sent = await wallet.sendTransaction(tx);
      console.log("Sent redeem tx:", sent.hash);

      const rcpt = await sent.wait();
      if (rcpt.status === 1n) {
        console.log("Redeem SUCCESS:", rcpt.transactionHash);
        return;
      }

      console.log("Redeem failed, retrying…");

    } catch (err) {
      console.log(`Attempt ${attempt} error:`, err.message);
    }

    const wait = retryBaseMs * Math.pow(1.7, attempt);
    console.log(`Retry in ${wait}ms…`);

    await sleep(wait);
    gasGwei = Math.min(gasCap, Math.round(gasGwei * 1.4));
  }

  console.log("Max retries reached — giving up temporarily.");
}

// ---------------------------------------------------------
// PATROL MODE
// ---------------------------------------------------------
async function patrolLoop() {
  console.log(new Date().toISOString(),
    "[PATROL] Enabled, interval =", patrolMs, "ms"
  );

  const signer = await wallet.getAddress();

  while (patrolEnabled) {
    try {
      const redeemable = await vault.maxRedeem(signer);

      if (redeemable > 0n) {
        console.log(new Date().toISOString(),
          `[PATROL] Liquidity detected: ${redeemable} shares`
        );
        triggerRescue("patrol");
      }
    } catch (err) {
      console.log("[PATROL ERROR]", err.message);
    }

    await sleep(patrolMs);
  }
}

// ---------------------------------------------------------
// MAIN
// ---------------------------------------------------------
(async function main() {
  const signer = await wallet.getAddress();

  console.log(new Date().toISOString(), "Starting rescue-bot (Light + Clean)");
  console.log("Signer:", signer);
  console.log("Vault:", VAULT_ADDRESS);

  if (underlying) {
    const sym = await underlying.symbol();
    const dec = await underlying.decimals();
    console.log("Underlying:", sym, "decimals =", dec);
  }

  if (patrolEnabled) patrolLoop();

  console.log("[STARTUP] Waiting for Deposit / Withdraw / Transfer events");
  triggerRescue("startup");
})();
