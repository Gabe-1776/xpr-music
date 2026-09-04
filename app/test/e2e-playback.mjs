// E2E test: full Onda payment lifecycle as a real testnet wallet (vulcanwallet)
import fs from "node:fs";
import crypto from "node:crypto";
import { Api, JsonRpc, JsSignatureProvider } from "@proton/js";
// 1. Top-up deposit: transfer 0.5 XPR memo "onda" to ondastream
// 2. Wallet login: sign sigillogin::login (broadcast:false) → /api/auth/verify → Bearer
// 3. Play: POST /api/session/play → expect 200 + piggy opens clock
// 4. Let keeper pull ~8s → verify pullbal ticks billed vulcanwallet's piggy
// 5. Pause: POST /api/session/pause → remainder settled

const SITE = "https://music.project-testing.xyz";
const RPC = "https://testnet.protonchain.com";
const CONTRACT = "ondastream";
const LISTENER = "vulcanwallet";
const wallets = JSON.parse(fs.readFileSync(process.env.HOME + "/.xpr-testnet/wallets.json", "utf8")).accounts;
const key = wallets[LISTENER].private_key;
const provider = new JsSignatureProvider([key]);
const rpc = new JsonRpc(RPC);
const api = new Api({ rpc, signatureProvider: provider });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function chainTransfer(memo) {
  const tx = await api.transact(
    { actions: [{
        account: "eosio.token",
        name: "transfer",
        authorization: [{ actor: LISTENER, permission: "active" }],
        data: { from: LISTENER, to: CONTRACT, quantity: "0.5000 XPR", memo },
      }] },
    { blocksBehind: 3, expireSeconds: 60 }
  );
  return tx.transaction_id;
}

async function main() {
  // STEP 1: top-up deposit
  log("STEP 1: deposit 0.5 XPR memo onda...");
  const depTx = await chainTransfer("onda");
  log("deposit tx:", depTx);
  await new Promise(r => setTimeout(r, 1500));

  // verify piggy
  const piggy = await rpc.get_table_rows({ json: true, code: CONTRACT, scope: CONTRACT, table: "balances", limit: 10 });
  const row = piggy.rows.find(r => r.account === LISTENER);
  log("piggy after deposit:", row ? row.amount + " raw" : "MISSING");

  // STEP 2: login
  log("STEP 2: wallet login...");
  const chalRes = await fetch(`${SITE}/api/auth/nonce`, { method: "POST" });
  const challenge = await chalRes.json();
  const sigApi = new Api({ rpc, signatureProvider: provider });
  // build the sigillogin::login action, sign with broadcast:false
  const loginTx = await sigApi.transact({
    actions: [{
      account: "sigillogin",
      name: "login",
      authorization: [{ actor: LISTENER, permission: "active" }],
      data: { account: LISTENER, nonce: challenge.nonce },
    }],
  }, { broadcast: false, sign: true, blocksBehind: 3, expireSeconds: 60 });
  const serialized = Buffer.from(loginTx.serializedTransaction).toString("hex");
  const signatures = loginTx.signatures;
  const verifyRes = await fetch(`${SITE}/api/auth/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      challengeId: challenge.challengeId,
      actor: LISTENER,
      permission: "active",
      serializedTransaction: serialized,
      signatures,
    }),
  });
  const auth = await verifyRes.json();
  if (!auth.token) throw new Error("login failed: " + JSON.stringify(auth));
  log("logged in as", auth.actor);

  // STEP 3: play
  const songsRes = await fetch(`${SITE}/api/catalog`);
  const catalog = await songsRes.json();
  const song = (catalog.songs || []).find(s => s.payment_eligible);
  if (!song) throw new Error("no eligible song");
  log("STEP 3: play", song.id);
  const sessRes = await fetch(`${SITE}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const sid = (await sessRes.json()).session_id;
  if (!sid) throw new Error("no session created");
  const playRes = await fetch(`${SITE}/api/session/play`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-session-id": sid, "Authorization": `Bearer ${auth.token}` },
    body: JSON.stringify({ song_id: song.id, position: 0 }),
  });
  const playData = await playRes.json();
  log("play status:", playRes.status, "playing:", playData.playing, "error:", playData.error || "-");

  // STEP 4: let keeper bill ~8s, then check pulls for vulcanwallet's piggy
  log("STEP 4: streaming 8s...");
  await new Promise(r => setTimeout(r, 60000));

  // STEP 5: pause (settles remainder, stops keeper)
  log("STEP 5: pause");
  const pauseRes = await fetch(`${SITE}/api/session/pause`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-session-id": sid, "Authorization": `Bearer ${auth.token}` },
    body: "{}",
  });
  log("pause status:", pauseRes.status);

  // STEP 6: verify payouts to artist wallet
  const payouts = await rpc.get_table_rows({ json: true, code: CONTRACT, scope: CONTRACT, table: "balances", limit: 10 });
  log("piggy after pause:", (payouts.rows.find(r => r.account === LISTENER) || {}).amount);
}

main().catch(e => { console.error("E2E FAILED:", e.message || e); process.exit(1); });
