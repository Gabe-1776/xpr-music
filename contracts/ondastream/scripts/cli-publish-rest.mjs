#!/usr/bin/env node
// Remaining catalog songs: dashboard POST /api/submissions then CLI setsong.
// Keeps songs already on the live catalog (Deep Devotion). No browser. No mainnet.
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { Api, JsonRpc, JsSignatureProvider } from "@proton/js";

const LIVE = process.env.ONDA_API || "https://music.project-testing.xyz";
const NAME = "ondastream";
const ARTIST = "felixpaw";
const PAYOUT = "felixpaw";
const TESTNET_CHAIN_ID = "71ee83bcf52142d61019d95f9cc5427ba6a0d7ff8accd9e2088ae2abeaf3d3dd";
const CATALOG = `${homedir()}/Developer/xpr-music/app/catalog/songs.json`;
const TODO = process.argv[2] || "/tmp/onda-todo-songs.json";

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
function stripView(song) {
  const row = { ...song };
  delete row.artist_bio;
  delete row.artist_photo;
  delete row.album_cover;
  row.owner = ARTIST;
  row.payout_account = PAYOUT;
  return row;
}

const env = loadEnv(`${homedir()}/.openclaw/workspace/.env.xpr`);
if (env.XPR_ACCOUNT !== ARTIST || env.XPR_NETWORK !== "testnet") process.exit(1);

const todo = JSON.parse(readFileSync(TODO, "utf8"));
if (!Array.isArray(todo) || !todo.length) {
  console.error("todo empty");
  process.exit(1);
}

const existing = JSON.parse(readFileSync(CATALOG, "utf8"));
const haveFiles = new Set(existing.map((s) => s.file));

const published = [];
for (const s of todo) {
  if (haveFiles.has(s.file)) {
    console.log("SKIP already cataloged", s.file);
    continue;
  }
  const res = await fetch(`${LIVE}/api/submissions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: s.title,
      artist: s.artist,
      category: s.category,
      subcategory: s.subcategory || "",
      album_id: s.album_id || "",
      payout_account: PAYOUT,
      splits: Array.isArray(s.splits) ? s.splits : [],
      actor: ARTIST,
      file: s.file,
      cover: s.cover || "",
      video: s.video || "",
      color: s.color || "#6d8bff",
    }),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch {
    console.error("POST non-json", s.title, res.status, text.slice(0, 200));
    process.exit(1);
  }
  if (!res.ok || !data.song || !data.song.id) {
    console.error("POST FAIL", s.title, res.status, data.error || text.slice(0, 200));
    process.exit(1);
  }
  const song = stripView(data.song);
  if (s.duration_s) song.duration_s = s.duration_s;
  if (s.lyrics) song.lyrics = s.lyrics;
  if (s.track_number != null) song.track_number = s.track_number;
  if (s.license) song.license = s.license;
  published.push(song);
  haveFiles.add(s.file);
  console.log("PUBLISH", s.id, "->", song.id, s.title);
}

const catalog = [...existing.map(stripView), ...published];
writeFileSync(CATALOG, `${JSON.stringify(catalog, null, 2)}\n`);
console.log("catalog n", catalog.length);

const rpc = new JsonRpc([env.XPR_RPC_ENDPOINT || "https://tn1.protonnz.com"], { fetch });
const info = await rpc.get_info();
if (info.chain_id !== TESTNET_CHAIN_ID) process.exit(1);
const api = new Api({ rpc, signatureProvider: new JsSignatureProvider([env.XPR_PRIVATE_KEY]) });

function bandwidth() {
  return {
    account: "eosio.token", name: "transfer",
    authorization: [{ actor: ARTIST, permission: "active" }],
    data: { from: ARTIST, to: NAME, quantity: "0.0001 XPR", memo: "bandwidth" },
  };
}

const newIds = published.map((s) => s.id);
for (const id of newIds) {
  const r = await api.transact({
    actions: [
      bandwidth(),
      {
        account: NAME, name: "setsong",
        authorization: [{ actor: ARTIST, permission: "active" }],
        data: { artist: ARTIST, songId: id, payout: PAYOUT },
      },
    ],
  }, { blocksBehind: 3, expireSeconds: 90 });
  console.log("SETSONG", id, r.transaction_id);
}

const { rows } = await rpc.get_table_rows({ code: NAME, scope: NAME, table: "songs", json: true, limit: 200 });
const chain = new Set((rows || []).map((r) => r.songId));
const missing = catalog.map((s) => s.id).filter((id) => !chain.has(id));
if (missing.length) {
  console.error("CHAIN MISSING", missing);
  process.exit(1);
}
console.log("CLI PUBLISH REST PASS", newIds.length, "catalog", catalog.length);
