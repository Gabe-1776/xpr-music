import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { Api, JsonRpc, JsSignatureProvider } from "@proton/js";

const NAME = "ondastream";
const FUNDER = "felixpaw";
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
const wallets = JSON.parse(readFileSync(`${homedir()}/.xpr-testnet/wallets.json`, "utf8"));
const contract = wallets.accounts[NAME];
const xprmusic = wallets.accounts.xprmusic;
const musictesting = wallets.accounts.musictesting;
const rpc = new JsonRpc([env.XPR_RPC_ENDPOINT || "https://tn1.protonnz.com"], { fetch });

const api = new Api({
  rpc,
  signatureProvider: new JsSignatureProvider([
    contract.private_key, env.XPR_PRIVATE_KEY, xprmusic.private_key, musictesting.private_key,
  ]),
});

function bandwidth() {
  return {
    account: "eosio.token", name: "transfer",
    authorization: [{ actor: FUNDER, permission: "active" }],
    data: { from: FUNDER, to: NAME, quantity: "0.0001 XPR", memo: "bandwidth" },
  };
}

async function tx(label, actions) {
  try {
    const r = await api.transact({ actions: [bandwidth(), ...actions] }, { blocksBehind: 3, expireSeconds: 60 });
    console.log(label, "OK", r.transaction_id);
    return r;
  } catch (e) {
    console.error(label, "FAIL", redact(JSON.stringify(e.json || e.message)).slice(0, 500));
    throw e;
  }
}

try {
  await tx("init", [{
    account: NAME, name: "init", authorization: [{ actor: NAME, permission: "active" }],
    data: { owner: NAME },
  }]);
} catch (e) {
  if (!String(e.json?.error?.details?.[0]?.message || e.message).includes("already initialized")) throw e;
  console.log("init already done");
}

await tx("setsong", [{
  account: NAME, name: "setsong", authorization: [{ actor: "xprmusic", permission: "active" }],
  data: { artist: "xprmusic", songId: "signal-bloom", payout: "xprmusic" },
}]);

await tx("stream-start", [{
  account: "eosio.token", name: "transfer", authorization: [{ actor: "musictesting", permission: "active" }],
  data: { from: "musictesting", to: NAME, quantity: "0.0002 XPR", memo: "s:signal-bloom" },
}]);

const { rows } = await rpc.get_table_rows({ code: NAME, scope: NAME, table: "streams", json: true });
console.log("streams", JSON.stringify(rows));

await tx("stopstream", [{
  account: NAME, name: "stopstream", authorization: [{ actor: "musictesting", permission: "active" }],
  data: { listener: "musictesting" },
}]);

const after = await rpc.get_table_rows({ code: NAME, scope: NAME, table: "streams", json: true });
console.log("streams after stop", JSON.stringify(after.rows));
const claimed = await rpc.get_table_rows({ code: NAME, scope: NAME, table: "claimed", json: true });
console.log("claimed", JSON.stringify(claimed.rows));
const songs = await rpc.get_table_rows({ code: NAME, scope: NAME, table: "songs", json: true });
console.log("songs", JSON.stringify(songs.rows));
const cfg = await rpc.get_table_rows({ code: NAME, scope: NAME, table: "config", json: true });
console.log("config", JSON.stringify(cfg.rows));
