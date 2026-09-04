// TESTNET only. Redeploy ondastream with the withdrawamt (partial withdraw)
// action. Signed by felixpaw@active (the contract owner) via .env.xpr.
// Prints tx id. Never prints PVT.
import { readFileSync } from "node:fs";
import { Api, JsonRpc, JsSignatureProvider, Serialize } from "@proton/js";

const TESTNET_CHAIN_ID = "71ee83bcf52142d61019d95f9cc5427ba6a0d7ff8accd9e2088ae2abeaf3d3dd";
const NAME = "ondastream";
const ENVFILE = `${process.env.HOME}/.openclaw/workspace/.env.xpr`;
const WASM = new URL("../assembly/target/ondastream.contract.wasm", import.meta.url);
const ABI = new URL("../assembly/target/ondastream.contract.abi", import.meta.url);

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
if (env.XPR_ACCOUNT !== "felixpaw" || env.XPR_NETWORK !== "testnet") {
  console.error("REFUSE: not felixpaw testnet");
  process.exit(1);
}
const rpc = new JsonRpc([env.XPR_RPC_ENDPOINT || "https://test.proton.eosusa.io"]);
const info = await rpc.get_info();
if (info.chain_id !== TESTNET_CHAIN_ID) {
  console.error("REFUSE: not testnet", info.chain_id);
  process.exit(1);
}
const ondaKeys = JSON.parse(readFileSync(`${process.env.HOME}/.xpr-testnet/ondastream.key.json`, "utf8"));
const provider = new JsSignatureProvider([env.XPR_PRIVATE_KEY, ondaKeys.private_key]);
const api = new Api({ rpc, signatureProvider: provider });

const wasm = new Uint8Array(readFileSync(WASM));
const abi = readFileSync(ABI, "utf8");
const api2 = new Api({ rpc });
function abiToHex(abiJson) {
  const abiDef = api2.abiTypes.get("abi_def");
  const buffer = new Serialize.SerialBuffer({ textEncoder: api2.textEncoder, textDecoder: api2.textDecoder });
  const filled = Object.assign(
    {},
    { version: "eosio::abi/1.1", types: [], structs: [], actions: [], tables: [], ricardian_clauses: [], error_messages: [], abi_extensions: [], variants: [] },
    abiJson,
  );
  abiDef.serialize(buffer, filled);
  return Buffer.from(buffer.asUint8Array()).toString("hex");
}
const abiHex = abiToHex(JSON.parse(abi));
const wasmHex = Buffer.from(wasm).toString("hex");

try {
  const r = await api.transact({
    actions: [
      { account: "eosio", name: "setcode", authorization: [{ actor: NAME, permission: "active" }],
        data: { account: NAME, vmtype: 0, vmversion: 0, code: wasmHex } },
      { account: "eosio", name: "setabi", authorization: [{ actor: NAME, permission: "active" }],
        data: { account: NAME, abi: abiHex } },
    ],
  }, { blocksBehind: 3, expireSeconds: 120 });
  console.log("REDEPLOYED tx", r.transaction_id);
} catch (e) {
  console.error("DEPLOY FAILED", JSON.stringify(e.json || e.message).slice(0, 600));
  process.exit(1);
}
