
/**
 * rescue-bot.js
 *
 * Usage:
 * 1) Install dependencies:
 *    npm install
 * 2) Create a .env file (see .env.example) or set environment variables.
 * 3) Run:
 *    npm start
 *
 * WARNING: This script will submit transactions using your private key.
 */

import 'dotenv/config';
const providerWS = new ethers.WebSocketProvider(RPC_WS);
const providerHTTP = new ethers.JsonRpcProvider(RPC_HTTP);
const wallet = new ethers.Wallet(PRIVATE_KEY, providerHTTP);
const vault = new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);

// ---- CONFIG ----
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
  console.error('Missing required environment variables.');
  process.exit(1);
}

const dryRun = DRY_RUN.toLowerCase() === 'true';
const maxRetries = parseInt(MAX_RETRIES, 3);
const initialGasGwei = Number(INITIAL_GAS_GWEI);
const maxGasGwei = Number(MAX_GAS_GWEI);
const retryBaseMs = Number(RETRY_BASE_MS);

// ERC‑4626 and ERC‑20 ABIs
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

// Providers & Wallet
const wsProvider = new providers.WebSocketProvider(RPC_WS, { name: 'bsc', chainId: 56 });
const httpProvider = new providers.JsonRpcProvider(RPC_HTTP, { name: 'bsc', chainId: 56 });
const wallet = new Wallet(PRIVATE_KEY, httpProvider);
const signerAddressPromise = wallet.getAddress();

// Contracts
const vault = new Contract(VAULT_ADDRESS, ERC4626_ABI, httpProvider);
const vaultWs = new Contract(VAULT_ADDRESS, ERC4626_ABI, wsProvider);
const underlying = TOKEN_ADDRESS ? new Contract(TOKEN_ADDRESS, ERC20_ABI, httpProvider) : null;

async function main() {
  const signerAddress = await signerAddressPromise;
  console.log(`Bot signer: ${signerAddress}`);
  console.log(`Owner address: ${OWNER_ADDRESS}`);
  console.log(`Vault: ${VAULT_ADDRESS}`);

  if (underlying) {
    try {
      const sym = await underlying.symbol();
      const dec = await underlying.decimals();
      console.log(`Underlying token: ${sym} decimals=${dec}`);
    } catch {}
  }

  // Websocket event listeners
  wsProvider._websocket.on('open', () => console.log('WS connected.'));
  wsProvider._websocket.on('close', () => {
    console.warn('WS closed. Restart needed.');
    process.exit(1);
  });

  vaultWs.on('Deposit', () => triggerRescueAttempt('Deposit'));
  vaultWs.on('Withdraw', () => triggerRescueAttempt('Withdraw'));
  vaultWs.on('Transfer', () => triggerRescueAttempt('Transfer'));

  console.log('Startup – checking balances...');
  await triggerRescueAttempt('startup');
}

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
    console.error('Rescue loop error:', e);
  } finally {
    rescueInProgress = false;
  }
}

async function attemptRescueLoop() {
  const signerAddress = await wallet.getAddress();
  console.log(`--- RESCUE ATTEMPT: ${lastTriggerReason} ---`);

  let shares = 0n;
  let underlyingBalance = 0n;

  try { shares = await vault.balanceOf(signerAddress); } catch {}
  try { if (underlying) underlyingBalance = await underlying.balanceOf(signerAddress); } catch {}

  if (shares === 0n && underlyingBalance === 0n) {
    console.log('Nothing to rescue for this wallet.');
    return;
  }

  if (shares > 0n) {
    console.log(`Trying redeem(${shares}) repeatedly...`);
    await repeatedlyTry("redeem", shares);
  } else {
    console.log(`Trying withdraw(${underlyingBalance}) repeatedly...`);
    await repeatedlyTry("withdraw", underlyingBalance);
  }
}

async function repeatedlyTry(type, amount) {
  const signerAddress = await wallet.getAddress();
  let gasGwei = initialGasGwei;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(`${type} attempt ${attempt}/${maxRetries} amount=${amount} gas=${gasGwei} gwei`);

    try {
      const iface = vault.interface;
      const data = type === "redeem"
        ? iface.encodeFunctionData("redeem", [amount, OWNER_ADDRESS, signerAddress])
        : iface.encodeFunctionData("withdraw", [amount, OWNER_ADDRESS, signerAddress]);

      const tx = { to: VAULT_ADDRESS, data };

      // simulate
      try { await httpProvider.call({ ...tx, from: signerAddress }); } catch {}

      let gasLimit;
      try {
        const est = await httpProvider.estimateGas({ ...tx, from: signerAddress });
        gasLimit = Number(est) + Math.floor(Number(est) * 0.2);
      } catch {
        gasLimit = 600000;
      }

      const nonce = await httpProvider.getTransactionCount(signerAddress, 'latest');
      let gasPrice = await httpProvider.getGasPrice();
      const userGas = BigInt(Math.floor(gasGwei * 1e9));
      if (userGas > gasPrice) gasPrice = userGas;
      const cap = BigInt(Math.floor(maxGasGwei * 1e9));
      if (gasPrice > cap) gasPrice = cap;

      const txSend = { to: VAULT_ADDRESS, data, gasLimit, gasPrice, nonce };

      if (dryRun) {
        console.log('[DRY RUN] Tx:', txSend);
        return;
      }

      const signed = await wallet.signTransaction(txSend);
      const sent = await httpProvider.sendTransaction(signed);
      const receipt = await sent.wait(1);

      if (receipt && receipt.status === 1) {
        console.log(`${type} SUCCESS tx=${receipt.transactionHash}`);
        return;
      }
    } catch (e) {
      console.warn(`${type} error:`, e.message);
    }

    await new Promise(r => setTimeout(r, retryBaseMs * Math.pow(1.8, attempt - 1)));
    gasGwei = Math.min(maxGasGwei, Math.round(gasGwei * 1.6));
  }

  console.error(`${type} FAILED after ${maxRetries} attempts.`);
}

main().catch(err => console.error(err));
