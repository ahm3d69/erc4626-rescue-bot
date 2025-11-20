# ERC-4626 Rescue Bot

A Node.js bot designed to automatically attempt **redeem/withdraw** from a low-liquidity ERC‑4626 vault. It listens to **Deposit**, **Withdraw**, and **Transfer** events using WebSocket RPC and continuously retries withdrawing your full balance whenever liquidity becomes available.

This is useful when:
- A vault has **insufficient liquidity**.
- You want to automatically claim your USDT the **moment liquidity returns**.
- You want automatic retries with gas price backoff and event‑based triggers.

Supports: **Any ERC‑4626 vault**, including the example vault on BNB Chain:
```
0x69a93dbab609266af96f05658b2e22d020de2e19
```

---

## ✨ Features
- 🔄 **Continuous redeem attempts** until successful
- 👀 **Live event listener** for `Deposit`, `Withdraw`, `Transfer`
- ⚡ Gas price auto‑increment on each retry
- ⏳ Exponential backoff between attempts
- 🟢 WebSocket RPC for instant reaction
- 🧪 Dry‑run mode (no transactions sent)
- 🔐 Secure `.env` configuration

---

## 📦 Installation
```bash
git clone https://github.com/ahm3d69/erc4626-rescue-bot
cd erc4626-rescue-bot
npm install
```

---

## ⚙️ Configuration
Copy the example env file:
```bash
cp .env.example .env
```

Fill in these values:
```
RPC_WS=wss://your-ws-endpoint
RPC_HTTP=https://your-http-endpoint
PRIVATE_KEY=0xYOUR_PRIVATE_KEY
OWNER_ADDRESS=0xYOUR_WALLET_ADDRESS
VAULT_ADDRESS=0x69a93dbab609266af96f05658b2e22d020de2e19
TOKEN_ADDRESS=0xUSDT_OR_ASSET_TOKEN
DRY_RUN=false
MAX_RETRIES=12
INITIAL_GAS_GWEI=5
MAX_GAS_GWEI=80
RETRY_BASE_MS=15000
```

### Required RPC
- WebSocket: for event listening
- HTTP: for sending transactions

BNB Chain example:
```
RPC_WS=wss://bsc-ws-node.nariox.org:443
RPC_HTTP=https://bsc-dataseed.binance.org
```

---

## ▶️ Running the Bot
```bash
npm start
```

Two loops will run:
1. **Event listener** → tries withdraw on liquidity events
2. **Retry loop** → every X seconds tries again with updated gas

---

## 📁 Project Structure
```
├── rescue-bot.js        # Main bot logic
├── package.json
├── .env.example
└── README.md
```

---

## 🛠 How It Works
### 1. Listens to: Deposits / Withdraws / Transfers
Whenever someone deposits, repays, or withdraws, it may free liquidity.

### 2. Automatically calculates your shares
```js
const shares = await vault.balanceOf(owner);
```

### 3. Attempts withdraw with increasing gas
```js
await vault.redeem(shares, owner, owner, { gasPrice });
```

### 4. Retries until success
A success is detected by:
- transaction status = success
- or share balance becomes zero

---

## 💬 Notes
- Keep your RPC stable; WebSocket disconnect will pause event listening.
- For safety, run in `DRY_RUN=true` first.
- Adjust `MAX_GAS_GWEI` so you don’t exceed your limits.

---

## 🧯 Troubleshooting
**Bot not triggering withdraws?**
- Ensure WebSocket endpoint supports logs
- Ensure correct vault address
- Check if vault has liquidity

**Transactions stuck?**
- Increase `INITIAL_GAS_GWEI`

---

## 📝 License
MIT
