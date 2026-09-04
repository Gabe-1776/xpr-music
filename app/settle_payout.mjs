/**
 * Testnet settlement proof: pay one artist what they have accrued.
 *
 * Lives in app/ because that is where @proton/js resolves. Run:
 *   node settle_payout.mjs <artist-public-stats-url> <payer-account>
 * The payer needs staked NET/CPU — `xprmusic` has none (net 0/0) and fails
 * with "transaction net usage is too high"; `ondastream` is the app's own
 * funded account and is the correct treasury.
 *
 * Deliberately a LOCAL script, not a server endpoint — settling requires a
 * signing key, and the web server must never hold one. In production the payer
 * is a treasury account signing on a schedule (or an on-chain recorder
 * contract), never the API process.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { JsonRpc, Api, JsSignatureProvider } from "@proton/js";

const ENDPOINT = "https://testnet.protonchain.com";
const USD_PER_XPR = 0.0018;            // real XPR price (matches the app peg)
const [, , ARTIST_URL, PAYER] = process.argv;

const key = JSON.parse(readFileSync(`${homedir()}/.xpr-testnet/${PAYER}.key.json`, "utf8"));
const rpc = new JsonRpc([ENDPOINT]);
const api = new Api({ rpc, signatureProvider: new JsSignatureProvider([key.private_key]) });

const balance = async (a) =>
  (await rpc.get_currency_balance("eosio.token", a, "XPR"))[0] || "0.0000 XPR";

const stats = await (await fetch(ARTIST_URL)).json();
const payee = stats.payout_account;

// Resolve the payee set. If the artist's songs carry `splits` (multi-wallet
// percent), distribute to those wallets; otherwise the whole amount goes to
// the primary payout_account. Fetch the catalog to find this artist's splits.
let splitSet = [];
try {
  const cat = await (await fetch(new URL("/api/catalog", ARTIST_URL).toString())).json();
  const songs = (cat.songs || []).filter((s) => s.artist === stats.artist);
  const withSplits = songs.filter((s) => Array.isArray(s.splits) && s.splits.length);
  if (withSplits.length) {
    // Use the first song that declares splits as the split template.
    const src_ = withSplits[0];
    const total = src_.splits.reduce((a, x) => a + (x.pct || 0), 0);
    splitSet = src_.splits
      .filter((x) => x.wallet && x.pct > 0)
      .map((x) => ({ wallet: x.wallet, pct: (total > 0 ? x.pct / total : 0) }));
  }
} catch (_) {}

if (!payee && !splitSet.length) throw new Error(`${stats.artist} has no payout_account or splits set`);

// XPR is 4dp. Round UP so a tiny accrual never settles to zero and stall forever.
const owedXpr = Math.max(0.0001, Math.ceil((stats.accrued_usd / USD_PER_XPR) * 10000) / 10000);

console.log(`artist   : ${stats.artist}`);
console.log(`accrued  : $${stats.accrued_usd}  (${stats.plays} plays, ${stats.listen_seconds}s)`);

// Build the transfer list. Round each share up to 4dp; the last recipient
// absorbs the remainder so the sum is exact.
const recipients = splitSet.length ? splitSet : [{ wallet: payee, pct: 1 }];
const qty = (usd) => `${Math.max(0.0001, Math.ceil((usd / USD_PER_XPR) * 10000) / 10000).toFixed(4)} XPR`;
const transfers = recipients.map((r, i, arr) => {
  const isLast = i === arr.length - 1;
  const usd = isLast
    ? owedXpr * USD_PER_XPR - arr.slice(0, -1).reduce((a, x) => a + x.pct * owedXpr * USD_PER_XPR, 0)
    : r.pct * owedXpr * USD_PER_XPR;
  return { to: r.wallet, quantity: qty(usd) };
}).filter((t) => parseFloat(t.quantity) > 0);

for (const t of transfers) console.log(`pay      : ${PAYER} -> ${t.to}  ${t.quantity}`);
const beforeBal = [`${PAYER} ${await balance(PAYER)}`];
for (const t of transfers) beforeBal.push(`${t.to} ${await balance(t.to)}`);
console.log(`before   : ${beforeBal.join(" | ")}`);

const result = await api.transact({
  actions: transfers.map((t) => ({
    account: "eosio.token",
    name: "transfer",
    authorization: [{ actor: PAYER, permission: "active" }],
    data: { from: PAYER, to: t.to, quantity: t.quantity, memo: `onda:stream-settlement:${stats.artist}` },
  })),
}, { blocksBehind: 3, expireSeconds: 60 });

console.log(`tx       : ${result.transaction_id}`);
await new Promise((r) => setTimeout(r, 2500));
const afterBal = [`${PAYER} ${await balance(PAYER)}`];
for (const t of transfers) afterBal.push(`${t.to} ${await balance(t.to)}`);
console.log(`after    : ${afterBal.join(" | ")}`);
