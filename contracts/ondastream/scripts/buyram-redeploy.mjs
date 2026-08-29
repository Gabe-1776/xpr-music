import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { Api, JsonRpc, JsSignatureProvider, Serialize } from "@proton/js";

const NAME = "ondastream";
const FUNDER = "felixpaw";
const ENVFILE = `${homedir()}/.openclaw/workspace/.env.xpr`;
const WALLETS = `${homedir()}/.xpr-testnet/wallets.json`;
const WASM = new URL("../assembly/target/ondastream.contract.wasm", import.meta.url);
const ABI = new URL("../assembly/target/ondastream.contract.abi", import.meta.url);
const TESTNET_CHAIN_ID = "71ee83bcf52142d61019d95f9cc5427ba6a0d7ff8accd9e2088ae2abeaf3d3dd";

function redact(s) { return String(s).replace(/PVT_[A-Za-z0-9_]+/g, "[REDACTED]"); }
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

const env = loadEnv(ENVFILE);
if (env.XPR_ACCOUNT !== FUNDER || env.XPR_NETWORK !== "testnet") process.exit(1);
const rpc = new JsonRpc([env.XPR_RPC_ENDPOINT || "https://tn1.protonnz.com"], { fetch });
const info = await rpc.get_info();
if (info.chain_id !== TESTNET_CHAIN_ID) process.exit(1);

const saved = JSON.parse(readFileSync(WALLETS, "utf8")).accounts[NAME];
const acct = await rpc.get_account(NAME);
console.log("ram before", acct.ram_quota, "used", acct.ram_usage);

const free = (acct.ram_quota || 0) - (acct.ram_usage || 0);
if (free < 200000) {
  const extra = 120000;
  const funderApi = new Api({ rpc, signatureProvider: new JsSignatureProvider([env.XPR_PRIVATE_KEY]) });
  const buy = await funderApi.transact({
    actions: [
      { account: "eosio", name: "buyrambytes", authorization: [{ actor: FUNDER, permission: "active" }],
        data: { payer: FUNDER, receiver: NAME, bytes: extra } },
    ],
  }, { blocksBehind: 3, expireSeconds: 60 });
  console.log("bought", extra, "tx", buy.transaction_id);
} else {
  console.log("ram free", free, "skip buy");
}

const api = new Api({ rpc, signatureProvider: new JsSignatureProvider([saved.private_key, env.XPR_PRIVATE_KEY]) });
const wasm = readFileSync(WASM);
const wasmHex = wasm.toString("hex");
console.log("wasm sha256", createHash("sha256").update(wasm).digest("hex"));

function abiToHex(abiJson) {
  const abiDef = api.abiTypes.get("abi_def");
  const buffer = new Serialize.SerialBuffer({ textEncoder: api.textEncoder, textDecoder: api.textDecoder });
  const filled = Object.assign(
    {}, { version: "eosio::abi/1.1", types: [], structs: [], actions: [], tables: [], ricardian_clauses: [], error_messages: [], abi_extensions: [], variants: [] },
    abiJson,
  );
  abiDef.serialize(buffer, filled);
  return Buffer.from(buffer.asUint8Array()).toString("hex");
}
const abiHex = abiToHex(JSON.parse(readFileSync(ABI, "utf8")));

try {
  const r = await api.transact({
    actions: [
      { account: "eosio.token", name: "transfer", authorization: [{ actor: FUNDER, permission: "active" }],
        data: { from: FUNDER, to: NAME, quantity: "0.0001 XPR", memo: "bandwidth: setcode" } },
      { account: "eosio", name: "setcode", authorization: [{ actor: NAME, permission: "active" }],
        data: { account: NAME, vmtype: 0, vmversion: 0, code: wasmHex } },
      { account: "eosio", name: "setabi", authorization: [{ actor: NAME, permission: "active" }],
        data: { account: NAME, abi: abiHex } },
    ],
  }, { blocksBehind: 3, expireSeconds: 120 });
  console.log("DEPLOYED tx", r.transaction_id);
} catch (e) {
  console.error("DEPLOY FAILED", redact(JSON.stringify(e.json || e.message)).slice(0, 700));
  process.exit(1);
}

try {
  const r = await api.transact({
    actions: [{
      account: "eosio", name: "updateauth", authorization: [{ actor: NAME, permission: "owner" }],
      data: {
        account: NAME, permission: "active", parent: "owner",
        auth: {
          threshold: 1,
          keys: [{ key: saved.public_key, weight: 1 }],
          accounts: [{ permission: { actor: NAME, permission: "eosio.code" }, weight: 1 }],
          waits: [],
        },
      },
    }],
  }, { blocksBehind: 3, expireSeconds: 60 });
  console.log("eosio.code tx", r.transaction_id);
} catch (e) {
  console.error("eosio.code", redact(JSON.stringify(e.json || e.message)).slice(0, 300));
}

try {
  const r = await api.transact({
    actions: [{ account: NAME, name: "init", authorization: [{ actor: NAME, permission: "active" }], data: { owner: NAME } }],
  }, { blocksBehind: 3, expireSeconds: 60 });
  console.log("init tx", r.transaction_id);
} catch (e) {
  const msg = redact(JSON.stringify(e.json || e.message));
  if (msg.includes("already initialized")) console.log("init already done");
  else console.error("init", msg.slice(0, 400));
}
