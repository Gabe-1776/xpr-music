#!/usr/bin/env node
// Re-add the wiped demo catalog through the same POST /api/submissions
// path the artist dashboard uses (actor + payout = felixpaw). Reuses
// existing media/songs files — no re-upload. Do not mainnet.
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

const ROOT = `${homedir()}/Developer/xpr-music`;
const LIVE = process.env.ONDA_API || "https://music.project-testing.xyz";
// Owner/payout are overridable so the catalog can be re-added under a wallet
// that is NOT the listener — a pull is untested until it crosses accounts.
const ACTOR = process.env.ONDA_ACTOR || "felixpaw";
const PAYOUT = process.env.ONDA_PAYOUT || ACTOR;
const SOURCE = process.argv[2];
if (!SOURCE) {
  console.error("usage: node republish-via-submissions.mjs <source-songs.json>");
  process.exit(1);
}

const src = JSON.parse(readFileSync(SOURCE, "utf8"));
if (!Array.isArray(src) || !src.length) {
  console.error("source empty");
  process.exit(1);
}

async function postSong(s) {
  const body = {
    title: s.title,
    artist: s.artist,
    category: s.category,
    subcategory: s.subcategory || "",
    album_id: s.album_id || "",
    payout_account: PAYOUT,
    splits: Array.isArray(s.splits) ? s.splits : [],
    actor: ACTOR,
    file: s.file,
    cover: s.cover || "",
    video: s.video || "",
    color: s.color || "#6d8bff",
  };
  const res = await fetch(`${LIVE}/api/submissions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch {
    throw new Error(`HTTP ${res.status} non-json: ${text.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${s.title}: ${data.error || text.slice(0, 200)}`);
  if (!data.song || !data.song.id) throw new Error(`no song id for ${s.title}`);
  return data.song;
}

const published = [];
for (const s of src) {
  const song = await postSong(s);
  // Keep listen-time fields the dashboard POST does not copy.
  song.duration_s = s.duration_s;
  if (s.lyrics) song.lyrics = s.lyrics;
  if (s.track_number != null) song.track_number = s.track_number;
  if (s.license) song.license = s.license;
  if (s.video) song.video = s.video;
  song.owner = ACTOR;
  song.payout_account = PAYOUT;
  published.push({ old_id: s.id, song });
  console.log("PUBLISH", s.id, "->", song.id, s.title);
}

const catalogPath = `${ROOT}/app/catalog/songs.json`;
const liveSongs = published.map((p) => {
  const row = { ...p.song };
  delete row.artist_bio;
  delete row.artist_photo;
  delete row.album_cover;
  row.owner = ACTOR;
  row.payout_account = PAYOUT;
  return row;
});
writeFileSync(catalogPath, `${JSON.stringify(liveSongs, null, 2)}\n`);
writeFileSync(
  `${ROOT}/app/catalog/.dashboard-republish-map.json`,
  `${JSON.stringify(published.map((p) => ({ old_id: p.old_id, new_id: p.song.id, title: p.song.title })), null, 2)}\n`,
);
console.log("REPUBLISH PASS", published.length, "wrote", catalogPath);
