#!/usr/bin/env node
/**
 * Scheduled settlement runner — pays every artist their accrued-but-unpaid
 * streaming earnings, on the testnet treasury's schedule.
 *
 *   node settle_all.mjs <payer-account> [--dry]
 *
 * Payer needs staked NET/CPU + its key in ~/.xpr-testnet/<payer>.key.json.
 * `ondastream` is the app treasury.
 *
 * Double-pay protection: catalog/settlements.json records how much each
 * artist has already been paid. The runner pays only the DELTA between the
 * live accrual and the settled ledger, then records what it paid.
 *
 * Artists without a payout_account (and without splits) are skipped with a
 * note — safe to run before every artist has configured a wallet.
 *
 * Deliberately a LOCAL script (signing key must never live in the web
 * server). Wire it to a systemd timer / cron on the treasury host.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { JsonRpc, Api, JsSignatureProvider } from "@proton/js";

const ENDPOINT = "https://testnet.protonchain.com";
const SITE = process.env.SITE_URL || "https://music.project-testing.xyz";
const USD_PER_XPR = 0.0018;            // real XPR price (matches the app peg)
const LEDGER_FILE = new URL("./catalog/settlements.json", import.meta.url).pathname;
const [, , PAYER, ...rest] = process.argv;
const DRY = rest.includes("--dry");

if (!PAYER) { console.error("usage: node settle_all.mjs <payer-account> [--dry]"); process.exit(1); }

const keyPath = `${homedir()}/.xpr-testnet/${PAYER}.key.json`;
if (!existsSync(keyPath)) { console.error(`no key file: ${keyPath}`); process.exit(1); }
const key = JSON.parse(readFileSync(keyPath, "utf8"));
const rpc = new JsonRpc([ENDPOINT]);
const api = new Api({ rpc, signatureProvider: new JsSignatureProvider([key.private_key]) });

const balance = async (a) =>
  (await rpc.get_currency_balance("eosio.token", a, "XPR"))[0] || "0.0000 XPR";

// ---- settled ledger -------------------------------------------------------
function loadLedger() {
  try { return JSON.parse(readFileSync(LEDGER_FILE, "utf8")); } catch { return {}; }
}
function saveLedger(l) { writeFileSync(LEDGER_FILE, JSON.stringify(l, null, 2)); }

// ---- artists --------------------------------------------------------------
const catalog = await (await fetch(`${SITE}/api/catalog`)).json();
const songs = catalog.songs || catalog;
const byArtist = new Map();
songs.forEach((s) => {
  const name = s.artist || "Unknown";
  if (!byArtist.has(name)) byArtist.set(name, { songs: [], payout: s.payout_account || "", splits: [] });
  const row = byArtist.get(name);
  row.songs.push(s);
  if (s.payout_account && !row.payout) row.payout = s.payout_account;
  if (Array.isArray(s.splits) && s.splits.length && !row.splits.length) row.splits = s.splits;
});

// accrual per artist (public stats endpoint = the same source the UI shows)
const artists = [];
for (const [name, info] of byArtist.entries()) {
  try {
    const st = await (await fetch(`${SITE}/api/metrics/artist-public/${encodeURIComponent(name)}`)).json();
    if (st.error) continue;
    artists.push({
      name,
      accrued_usd: st.accrued_usd || 0,
      payout: st.payout_account || info.payout || "",
      splits: info.splits || [],
    });
  } catch {}
}

const ledger = loadLedger();
const payable = artists.filter((a) => {
  const settled = ledger[a.name]?.settled_usd || 0;
  return a.accrued_usd - settled > 0.0001 && (a.payout || a.splits.length);
});
const skipped = artists.filter((a) => !payable.includes(a) && a.accrued_usd > 0);

console.log(`settle_all ${DRY ? "(DRY RUN)" : ""} — payer ${PAYER}`);
console.log(`treasury balance before: ${await balance(PAYER)}`);
console.log(`artists with accrual: ${artists.length} | payable now: ${payable.length} | skipped (no payout wallet): ${skipped.length}`);
skipped.forEach((a) => console.log(`  skip ${a.name}: $${a.accrued_usd} accrued, no payout wallet configured`));

let actions = [];
for (const a of payable) {
  const settled = ledger[a.name]?.settled_usd || 0;
  const deltaUsd = +(a.accrued_usd - settled).toFixed(6);
  if (!(deltaUsd > 0)) continue;
  const owedXpr = Math.max(0.0001, Math.ceil((deltaUsd / USD_PER_XPR) * 10000) / 10000);

  // recipients: per-song splits (first song that declares them) else payout wallet
  const recipients = a.splits.length
    ? a.splits.filter((x) => x.wallet && x.pct > 0).map((x) => ({ wallet: x.wallet, pct: x.pct }))
    : [{ wallet: a.payout, pct: 1 }];
  const pctTotal = recipients.reduce((s, r) => s + r.pct, 0) || 1;

  const parts = recipients.map((r, i) => {
    const isLast = i === recipients.length - 1;
    const usd = isLast
      ? deltaUsd - recipients.slice(0, -1).reduce((s, x) => s + (x.pct / pctTotal) * deltaUsd, 0)
      : (r.pct / pctTotal) * deltaUsd;
    const q = Math.max(0.0001, Math.ceil((usd / USD_PER_XPR) * 10000) / 10000).toFixed(4);
    return { to: r.wallet, quantity: `${q} XPR`, usd };
  }).filter((p) => parseFloat(p.quantity) > 0);

  console.log(`\n${a.name}: accrued $${a.accrued_usd} | settled $${settled} | paying $${deltaUsd} (${owedXpr.toFixed(4)} XPR)`);
  parts.forEach((p) => console.log(`   -> ${p.to}  ${p.quantity}`));

  for (const p of parts) {
    actions.push({
      account: "eosio.token", name: "transfer",
      authorization: [{ actor: PAYER, permission: "active" }],
      data: { from: PAYER, to: p.to, quantity: p.quantity, memo: `onda:stream-settlement:${a.name}` },
    });
  }
  ledger[a.name] = {
    settled_usd: +a.accrued_usd.toFixed(6),
    last_settled_at: new Date().toISOString(),
    last_amount_usd: deltaUsd,
    tx_ids: ledger[a.name]?.tx_ids || [],
  };
}

if (!actions.length) { console.log("\nnothing to settle."); process.exit(0); }
if (DRY) { console.log(`\nDRY RUN — would send ${actions.length} transfer(s). No transactions signed.`); process.exit(0); }

const BATCH = 10;
for (let i = 0; i < actions.length; i += BATCH) {
  const batch = actions.slice(i, i + BATCH);
  const result = await api.transact({ actions: batch }, { blocksBehind: 3, expireSeconds: 90 });
  console.log(`tx (${i / BATCH + 1}): ${result.transaction_id} [${batch.length} transfer(s)]`);
  ledger.__tx = [...(ledger.__tx || []), result.transaction_id].slice(-50);
  saveLedger(ledger);
  await new Promise((r) => setTimeout(r, 2500));
}
saveLedger(ledger);
console.log(`\ntreasury balance after: ${await balance(PAYER)}`);
console.log("done.");
