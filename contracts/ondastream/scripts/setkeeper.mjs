import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { Api, JsonRpc, JsSignatureProvider } from "@proton/js";

const NAME = "ondastream";
const FUNDER = "felixpaw";
const KEEPER = process.argv[2] || "xprmusic";
const TESTNET_CHAIN_ID = "71ee83bcf52142d61019d95f9cc5427ba6a0d7ff8accd9e2088ae2abeaf3d3dd";

function loadEnv(path) {
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const s = line.trim();
    if (!s || s.startsWith("#") || !s.includes("=")) continue;
    const i = s.indexOf("=");
    out[s.slice(0, i)] = s.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

const env = loadEnv(`${homedir()}/.openclaw/workspace/.env.xpr`);
if (env.XPR_ACCOUNT !== FUNDER || env.XPR_NETWORK !== "testnet") process.exit(1);
const rpc = new JsonRpc([env.XPR_RPC_ENDPOINT || "https://tn1.protonnz.com"], { fetch });
const info = await rpc.get_info();
if (info.chain_id !== TESTNET_CHAIN_ID) process.exit(1);
const contract = JSON.parse(readFileSync(`${homedir()}/.xpr-testnet/wallets.json`, "utf8")).accounts[NAME];
const api = new Api({ rpc, signatureProvider: new JsSignatureProvider([contract.private_key, env.XPR_PRIVATE_KEY]) });
const r = await api.transact({
  actions: [
    {
      account: "eosio.token", name: "transfer",
      authorization: [{ actor: FUNDER, permission: "active" }],
      data: { from: FUNDER, to: NAME, quantity: "0.0001 XPR", memo: "bandwidth" },
    },
    {
      account: NAME, name: "setkeeper",
      authorization: [{ actor: NAME, permission: "active" }],
      data: { keeper: KEEPER },
    },
  ],
}, { blocksBehind: 3, expireSeconds: 90 });
console.log("setkeeper", KEEPER, r.transaction_id);
const rows = await rpc.get_table_rows({ code: NAME, scope: NAME, table: "ops", json: true });
console.log("ops", rows.rows);
