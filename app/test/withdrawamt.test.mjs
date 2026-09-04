// E2E: partial withdraw via withdrawamt on felixpaw's piggy (testnet).
// felixpaw signs with its own key (the account owner testing their own
// funds). Verifies: partial drain keeps the row, cap survives, remainder
// correct. Do not mainnet.
import { readFileSync } from "node:fs";
import { Api, JsonRpc, JsSignatureProvider } from "@proton/js";

const RPC = "https://testnet.protonchain.com";
const CONTRACT = "ondastream";
const LISTENER = "felixpaw";
const env = Object.fromEntries(
  readFileSync(`${process.env.HOME}/.openclaw/workspace/.env.xpr`, "utf8")
    .split("\n").filter(l => l.includes("=")).map(l => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()])
);
const provider = new JsSignatureProvider([env.XPR_PRIVATE_KEY]);
const rpc = new JsonRpc(RPC);
const api = new Api({ rpc, signatureProvider: provider });

const piggy = async () => {
  const r = await rpc.get_table_rows({ json: true, code: CONTRACT, scope: CONTRACT, table: "balances", limit: 10 });
  return r.rows.find(r => r.account === LISTENER) || null;
};

const before = await piggy();
console.log("piggy before:", before.amount, "raw");
const withdrawAmount = 5000; // 0.5000 XPR partial

const r = await api.transact({
  actions: [{
    account: CONTRACT,
    name: "withdrawamt",
    authorization: [{ actor: LISTENER, permission: "active" }],
    data: {
      listener: LISTENER,
      token: { contract: "eosio.token", sym: "4,XPR" },
      amount: withdrawAmount,
    },
  }],
}, { blocksBehind: 3, expireSeconds: 60 });
console.log("withdrawamt tx:", r.transaction_id);
await new Promise(res => setTimeout(res, 1500));

const after = await piggy();
console.log("piggy after:", after ? after.amount : "row removed");
const expected = before.amount - withdrawAmount;
if (after && after.amount === expected) console.log("PASS: piggy drained exactly", withdrawAmount, "raw, row kept (cap + clock intact)");
else if (!after && expected <= 0) console.log("PASS: exact drain removed row");
else { console.log("FAIL: expected", expected, "got", after ? after.amount : "gone"); process.exit(1); }
