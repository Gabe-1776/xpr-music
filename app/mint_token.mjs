import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
const { IdentityProof, IdentityV3 } = await import("@proton/signing-request/lib/proton-signing-request.m.js");
const { PrivateKey } = await import("@greymass/eosio");
const ACCOUNT = process.argv[2] || "vulcanwallet";
const BASE = process.env.BASE_URL || "http://127.0.0.1:8788";
const CHAIN_ID = "71ee83bcf52142d61019d95f9cc5427ba6a0d7ff8accd9e2088ae2abeaf3d3dd";
function loadPrivateKey(a){ const s=JSON.parse(fs.readFileSync(path.join(os.homedir(),".xpr-testnet","wallets.json"),"utf8")); const e=s.accounts?.[a]; if(!e?.private_key) throw new Error("no key "+a); return e.private_key; }
const proof = await IdentityProof.create({
  chainId: CHAIN_ID, account: ACCOUNT, permission: "active",
  signatureProvider: { sign: async ({transaction}) => { const priv = PrivateKey.from(loadPrivateKey(ACCOUNT)); return {signatures:[priv.sign(IdentityV3.hash(transaction, CHAIN_ID), true)]}; } },
  broadcast: false, expiry: new Date(Date.now()+300000), callback: "http://localhost:3000/auth", returnUrl: "http://localhost:3000", nonce: crypto.randomBytes(32).toString("hex"),
});
const payload = JSON.parse(await proof.poseidon());
const verify = await (await fetch(`${BASE}/api/auth/verify-proof`, {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({proof: payload})})).json();
if(verify.token) console.log(JSON.stringify({actor: ACCOUNT, token: verify.token}));
else console.log("ERROR", JSON.stringify(verify));
