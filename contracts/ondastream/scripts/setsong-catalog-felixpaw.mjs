import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { Api, JsonRpc, JsSignatureProvider } from "@proton/js";

const NAME = "ondastream";
const ARTIST = "felixpaw";
const PAYOUT = "felixpaw";
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
function redact(s) { return String(s).replace(/PVT_[A-Za-z0-9_]+/g, "[REDACTED]"); }

const env = loadEnv(`${homedir()}/.openclaw/workspace/.env.xpr`);
if (env.XPR_ACCOUNT !== ARTIST || env.XPR_NETWORK !== "testnet") process.exit(1);
const rpc = new JsonRpc([env.XPR_RPC_ENDPOINT || "https://tn1.protonnz.com"], { fetch });
const info = await rpc.get_info();
if (info.chain_id !== TESTNET_CHAIN_ID) process.exit(1);

const songs = JSON.parse(readFileSync(`${homedir()}/Developer/xpr-music/app/catalog/songs.json`, "utf8"));
const ids = songs.map((s) => s.id);
const api = new Api({ rpc, signatureProvider: new JsSignatureProvider([env.XPR_PRIVATE_KEY]) });

function bandwidth() {
  return {
    account: "eosio.token", name: "transfer",
    authorization: [{ actor: ARTIST, permission: "active" }],
    data: { from: ARTIST, to: NAME, quantity: "0.0001 XPR", memo: "bandwidth" },
  };
}

async function tx(label, actions) {
  const r = await api.transact({ actions: [bandwidth(), ...actions] }, { blocksBehind: 3, expireSeconds: 90 });
  console.log(label, "OK", r.transaction_id);
  return r;
}

for (const id of ids) {
  try {
    await tx(`setsong ${id}`, [{
      account: NAME, name: "setsong",
      authorization: [{ actor: ARTIST, permission: "active" }],
      data: { artist: ARTIST, songId: id, payout: PAYOUT },
    }]);
  } catch (e) {
    console.error(`setsong ${id} FAIL`, redact(JSON.stringify(e.json || e.message)).slice(0, 400));
    process.exit(1);
  }
}

const { rows } = await rpc.get_table_rows({ code: NAME, scope: NAME, table: "songs", json: true, limit: 100 });
console.log("on-chain songs", rows.length, rows.map((r) => r.songId).join(","));
console.log("SETSONG CATALOG PASS", ids.length);
