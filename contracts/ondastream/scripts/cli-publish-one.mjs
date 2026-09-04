#!/usr/bin/env node
// One song through the artist-dashboard API (POST /api/submissions) then
// ondastream::setsong via @proton/js (felixpaw testnet key). No browser.
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { Api, JsonRpc, JsSignatureProvider } from "@proton/js";

const LIVE = "https://music.project-testing.xyz";
const NAME = "ondastream";
const ARTIST = "felixpaw";
const PAYOUT = "felixpaw";
const TESTNET_CHAIN_ID = "71ee83bcf52142d61019d95f9cc5427ba6a0d7ff8accd9e2088ae2abeaf3d3dd";
const CATALOG = `${homedir()}/Developer/xpr-music/app/catalog/songs.json`;

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

const post = await fetch(`${LIVE}/api/submissions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    title: "Deep Devotion",
    artist: "Chapel Deep",
    category: "Electronic",
    subcategory: "House",
    album_id: "b9a51d7c-3f4e-4c0a-9d21-0c6f5a2e18bb",
    payout_account: PAYOUT,
    actor: ARTIST,
    file: "Deep_Devotion.mp3",
    cover: "/web/assets/covers/basement-gospel.jpg",
    color: "#c86bff",
  }),
});
const text = await post.text();
let data;
try { data = JSON.parse(text); } catch {
  console.error("POST non-json", post.status, text.slice(0, 300));
  process.exit(1);
}
if (!post.ok || !data.song || !data.song.id) {
  console.error("POST FAIL", post.status, data.error || text.slice(0, 300));
  process.exit(1);
}
const song = data.song;
console.log("DASHBOARD POST", song.id, song.title, "owner", song.owner, "payout", song.payout_account);

const row = {
  ...song,
  duration_s: 180,
  owner: ARTIST,
  payout_account: PAYOUT,
};
delete row.artist_bio;
delete row.artist_photo;
delete row.album_cover;
writeFileSync(CATALOG, `${JSON.stringify([row], null, 2)}\n`);

const rpc = new JsonRpc([env.XPR_RPC_ENDPOINT || "https://tn1.protonnz.com"], { fetch });
const info = await rpc.get_info();
if (info.chain_id !== TESTNET_CHAIN_ID) process.exit(1);
const api = new Api({ rpc, signatureProvider: new JsSignatureProvider([env.XPR_PRIVATE_KEY]) });

const r = await api.transact({
  actions: [
    {
      account: "eosio.token", name: "transfer",
      authorization: [{ actor: ARTIST, permission: "active" }],
      data: { from: ARTIST, to: NAME, quantity: "0.0001 XPR", memo: "bandwidth" },
    },
    {
      account: NAME, name: "setsong",
      authorization: [{ actor: ARTIST, permission: "active" }],
      data: { artist: ARTIST, songId: song.id, payout: PAYOUT },
    },
  ],
}, { blocksBehind: 3, expireSeconds: 90 });
console.log("SETSONG OK", r.transaction_id);

const { rows } = await rpc.get_table_rows({
  code: NAME, scope: NAME, table: "songs", json: true, limit: 200,
  lower_bound: song.id, upper_bound: song.id,
});
const hit = (rows || []).find((x) => x.songId === song.id) || rows[0];
console.log("CHAIN", hit);
if (!hit || hit.payout !== PAYOUT || !hit.active) {
  console.error("setsong row missing/inactive", redact(JSON.stringify(hit)));
  process.exit(1);
}
console.log("CLI PUBLISH PASS", song.id);
