// TESTNET only. Persist key BEFORE broadcast. Never prints PVT.
import { readFileSync, writeFileSync, copyFileSync, chmodSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { Api, JsonRpc, JsSignatureProvider, Key, Numeric, Serialize } from "@proton/js";

const TESTNET_CHAIN_ID = "71ee83bcf52142d61019d95f9cc5427ba6a0d7ff8accd9e2088ae2abeaf3d3dd";
const NAME = "ondastream";
const RAM_BYTES = 200_000;
const FUND_XPR = "20.0000";
const WALLETS = `${homedir()}/.xpr-testnet/wallets.json`;
const KEYFILE = `${homedir()}/.xpr-testnet/${NAME}.key.json`;
const ENVFILE = `${homedir()}/.openclaw/workspace/.env.xpr`;
const FUNDER = "felixpaw";
const WASM = new URL("../assembly/target/ondastream.contract.wasm", import.meta.url);
const ABI = new URL("../assembly/target/ondastream.contract.abi", import.meta.url);

function redact(s) {
  return String(s).replace(/PVT_[A-Za-z0-9_]+/g, "[REDACTED]");
}
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
if (env.XPR_ACCOUNT !== FUNDER || env.XPR_NETWORK !== "testnet") {
  console.error("REFUSE: funder env is not felixpaw testnet");
  process.exit(1);
}
const rpc = new JsonRpc([env.XPR_RPC_ENDPOINT || "https://tn1.protonnz.com", "https://test.proton.eosusa.io"], { fetch });
const info = await rpc.get_info();
if (info.chain_id !== TESTNET_CHAIN_ID) {
  console.error("REFUSE: not testnet", info.chain_id);
  process.exit(1);
}

async function exists(name) {
  try {
    await rpc.get_account(name);
    return true;
  } catch {
    return false;
  }
}

function persistKey(priv, pub) {
  const now = new Date().toISOString();
  if (existsSync(WALLETS)) {
    const bak = `${WALLETS}.bak-${Date.now()}`;
    copyFileSync(WALLETS, bak);
    chmodSync(bak, 0o600);
  }
  const keyDoc = {
    account: NAME, network: "testnet", chain: "proton-test",
    public_key: pub, private_key: priv, created: now,
    note: "Onda custom stream vest contract TESTNET. 2s window + song registry.",
  };
  writeFileSync(KEYFILE, JSON.stringify(keyDoc, null, 2));
  chmodSync(KEYFILE, 0o600);
  const wallets = JSON.parse(readFileSync(WALLETS, "utf8"));
  wallets.accounts[NAME] = {
    public_key: pub, private_key: priv,
    purpose: "Onda ondastream TESTNET contract",
    created: now, funded_xpr: FUND_XPR,
  };
  wallets._updated = now;
  writeFileSync(WALLETS, JSON.stringify(wallets, null, 1));
  chmodSync(WALLETS, 0o600);
  console.log("key PERSISTED", NAME, "pub", pub);
}

function loadSaved() {
  const w = JSON.parse(readFileSync(WALLETS, "utf8"));
  const row = w.accounts[NAME];
  if (!row?.private_key) throw new Error("no saved key for " + NAME);
  return row;
}

if (!(await exists(NAME))) {
  const { privateKey, publicKey } = Key.generateKeyPair(Numeric.KeyType.k1, { secureEnv: true });
  persistKey(privateKey.toString(), publicKey.toString());
  const pub = publicKey.toString();
  const auth = { threshold: 1, keys: [{ key: pub, weight: 1 }], accounts: [], waits: [] };
  const api = new Api({ rpc, signatureProvider: new JsSignatureProvider([env.XPR_PRIVATE_KEY]) });
  const r = await api.transact({
    actions: [
      { account: "eosio", name: "newaccount", authorization: [{ actor: FUNDER, permission: "active" }],
        data: { creator: FUNDER, name: NAME, owner: auth, active: auth } },
      { account: "eosio", name: "buyrambytes", authorization: [{ actor: FUNDER, permission: "active" }],
        data: { payer: FUNDER, receiver: NAME, bytes: RAM_BYTES } },
      { account: "eosio.proton", name: "newaccres", authorization: [{ actor: FUNDER, permission: "active" }],
        data: { account: NAME } },
      { account: "eosio.token", name: "transfer", authorization: [{ actor: FUNDER, permission: "active" }],
        data: { from: FUNDER, to: NAME, quantity: `${FUND_XPR} XPR`, memo: "onda stream contract seed" } },
    ],
  }, { blocksBehind: 3, expireSeconds: 60 });
  console.log("CREATED", NAME, "tx", r.transaction_id);
} else {
  console.log(NAME, "already on chain");
  if (!JSON.parse(readFileSync(WALLETS, "utf8")).accounts[NAME]) {
    console.error("account exists but no key in wallets.json — abort");
    process.exit(1);
  }
}

const saved = loadSaved();
const wasm = readFileSync(WASM);
const wasmHex = wasm.toString("hex");
const wantHash = createHash("sha256").update(wasm).digest("hex");
console.log("wasm sha256", wantHash, "bytes", wasm.length);

const api = new Api({
  rpc,
  signatureProvider: new JsSignatureProvider([saved.private_key, env.XPR_PRIVATE_KEY]),
});

function abiToHex(abiJson) {
  const abiDef = api.abiTypes.get("abi_def");
  const buffer = new Serialize.SerialBuffer({ textEncoder: api.textEncoder, textDecoder: api.textDecoder });
  const filled = Object.assign(
    {},
    { version: "eosio::abi/1.1", types: [], structs: [], actions: [], tables: [], ricardian_clauses: [], error_messages: [], abi_extensions: [], variants: [] },
    abiJson,
  );
  abiDef.serialize(buffer, filled);
  return Buffer.from(buffer.asUint8Array()).toString("hex");
}

const abiJson = JSON.parse(readFileSync(ABI, "utf8"));
const abiHex = abiToHex(abiJson);

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
  console.error("DEPLOY FAILED", redact(JSON.stringify(e.json || e.message)).slice(0, 600));
  process.exit(1);
}

try {
  const r = await api.transact({
    actions: [
      { account: "eosio", name: "updateauth", authorization: [{ actor: NAME, permission: "owner" }],
        data: {
          account: NAME, permission: "active", parent: "owner",
          auth: {
            threshold: 1,
            keys: [{ key: saved.public_key, weight: 1 }],
            accounts: [{ permission: { actor: NAME, permission: "eosio.code" }, weight: 1 }],
            waits: [],
          },
        } },
    ],
  }, { blocksBehind: 3, expireSeconds: 60 });
  console.log("eosio.code tx", r.transaction_id);
} catch (e) {
  console.error("eosio.code FAILED", redact(JSON.stringify(e.json || e.message)).slice(0, 400));
}

try {
  const r = await api.transact({
    actions: [
      { account: NAME, name: "init", authorization: [{ actor: NAME, permission: "active" }],
        data: { owner: NAME } },
    ],
  }, { blocksBehind: 3, expireSeconds: 60 });
  console.log("init tx", r.transaction_id);
} catch (e) {
  const msg = redact(JSON.stringify(e.json || e.message));
  if (msg.includes("already initialized")) console.log("init already done");
  else console.error("init FAILED", msg.slice(0, 400));
}

console.log(JSON.stringify({
  account: NAME,
  network: "testnet",
  wasm_sha256: wantHash,
  explorer: `https://testnet.explorer.xprnetwork.org/account/${NAME}`,
}));
