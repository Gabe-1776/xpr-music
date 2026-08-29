#!/usr/bin/env node
/**
 * XPR Music backend — plain `node:http` router (no web framework) with the
 * auth/chain helpers from @proton/js. Serves the catalog, wallet-metered
 * playback sessions, persistent favorites/playlists/grants, static media,
 * and web views.
 * Payment flows live in onda-*.js + stream-meter.js; this file is transport,
 * routing, and state persistence only.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = __dirname;
const SONGS = JSON.parse(fs.readFileSync(path.join(ROOT, "catalog/songs.json"), "utf8"));
const LIB_FILE = path.join(ROOT, "catalog/library.json");
const PLAYLISTS_FILE = path.join(ROOT, "catalog/playlists.json");
const SUBMISSIONS_FILE = path.join(ROOT, "catalog/submissions.json");
const ALBUMS_FILE = path.join(ROOT, "catalog/albums.json");
const METRICS_FILE = path.join(ROOT, "catalog/metrics.json");
const GRANTS_FILE = path.join(ROOT, "catalog/grants.json");
const ARTISTS_FILE = path.join(ROOT, "catalog/artists.json");
const RECENTS_FILE = path.join(ROOT, "catalog/recents.json");
const RECENT_MAX = 40;

// Canonical genre list offered to artists at upload time and shown as filter
// chips. Ordered alphabetically by the client; "Other" is the catch-all.
const CATEGORIES = [
  "Ambient",
  "Blues",
  "Contemporary",
  "Country",
  "Electronic",
  "Hip-Hop",
  "Jazz",
  "Latin",
  "Lo-Fi",
  "Metal",
  "Orchestra",
  "Pop",
  "Rock",
  "Soul & R&B",
  "Other",
];

const SUBCATEGORIES = {
  "Electronic": ["House", "Deep House", "Techno", "Drum & Bass", "Trance", "Garage", "Breakbeat", "Synth-pop", "Synthwave"],
  "Hip-Hop": ["Boom Bap", "Trap", "Instrumental"],
  "Jazz": ["Fusion", "Bebop", "Nu Jazz"],
  "Rock": ["Indie", "Post-Rock", "Garage Rock", "Southern Rock", "Classic Rock", "Alternative"],
  "Ambient": ["Drone", "Field Recording", "Neoclassical"],
  "Blues": ["Swamp Blues", "Delta Blues", "Electric Blues"],
  "Country": ["Outlaw Country", "Country Rock", "Bluegrass"],
  "Latin": ["Reggaeton", "Cumbia", "Regional Mexican"],
  "Lo-Fi": ["Chillhop", "Study Beats"],
  "Metal": ["Heavy Metal", "Doom", "Thrash"],
  "Orchestra": ["Cinematic", "Chamber"],
  "Pop": ["Synth-pop", "Dance Pop", "Art Pop"],
  "Soul & R&B": ["Neo-Soul", "Funk", "Quiet Storm"],
  "Contemporary": ["Singer-Songwriter", "Pop"],
};
// Per-currency streaming balances for LOGGED-IN wallets, keyed by actor.
// Deliberately NOT catalog/balances.json — that file is the single-scalar
// agent-grant top-up ledger behind /api/account/balance + /api/account/topup
// and keeps working untouched. Guests keep a session-scoped balance in memory.
const TOKEN_BALANCES_FILE = path.join(ROOT, "catalog/token-balances.json");
const PORT = process.env.PORT || 8788;
const ADMIN_PIN = process.env.ADMIN_PIN || "";
if (!ADMIN_PIN) throw new Error("ADMIN_PIN env is required — set it before starting the server");
const auth = require("./auth.js");
const { NETWORKS } = auth;
const ondaPulse = require("./onda-pulse");
const ondaPricing = require("./onda-pricing");
const ondaWallet = require("./onda-wallet");
const meter = require("./stream-meter");
// Planned AtomicAssets linkage for AI-original songs. Per blueprint: a
// collector NFT references the same song_id but does NOT redirect streaming
// income; nothing is minted yet (testnet free-only phase).
const NFT_COLLECTION = "xprmusic"; // 1-12 chars, a-z 1-5 — valid collection name
const NFT_SCHEMA = "song";
const NFT_API = "https://test.xpr.api.atomicassets.io/atomicassets/v1";
const NFT_API_BY_NETWORK = {
  testnet: "https://test.xpr.api.atomicassets.io/atomicassets/v1",
  mainnet: "https://atomicassets.api.atomicassets.io/atomicassets/v1",
};

// Streaming price: USD is the source of truth; the token amount is derived.
// 0.005 of a cent per second (~$0.009 per 3-min song, ~$0.18/hour).
// ONE GLOBAL RATE for all songs — per-song `rates` no longer drives accrual
// (the field stays in the catalog and still gates payment eligibility).
// 2s rolling hold + rebate lives in stream-meter.js (same vest shape as the
// old 15–30s window, tighter). The streaming $/sec rate is persisted so the
// admin dashboard can retune it live; the meter is told the new rate so the
// actual billing and the displayed accrual never drift.
const RATE_FILE = path.join(ROOT, "catalog", "rate.json");
let USD_PER_SEC = meter.DEFAULT_USD_PER_SEC;
try { USD_PER_SEC = Number(JSON.parse(fs.readFileSync(RATE_FILE, "utf8")).usd_per_sec) || meter.DEFAULT_USD_PER_SEC; } catch {}
if (!(USD_PER_SEC > 0)) USD_PER_SEC = meter.DEFAULT_USD_PER_SEC;
meter.setUsdPerSec(USD_PER_SEC);
function persistRate(v) {
  USD_PER_SEC = v;
  meter.setUsdPerSec(v);
  fs.writeFileSync(RATE_FILE, JSON.stringify({ usd_per_sec: v }, null, 2));
}
const TOKEN_USD = meter.TOKEN_USD;
const TOKEN_CONTRACTS = meter.TOKEN_CONTRACTS;
const CURRENCIES = Object.keys(TOKEN_USD);
// Mock starting balances for the simulated-payment phase (payments_enabled is
// false; nothing here touches a real wallet). Same numbers mobile has been
// showing as `initial` since the first build, moved server-side so both
// clients read ONE source of truth for the per-currency session balance.
// LOAN and METAL used to be seeded here too, but both are now REAL payable
// tokens on chain (tokrates), so a fake seeded balance for them would be
// actively misleading — removed 2026-08-24 (BLUEPRINT-pay-modes.md).
const SEED_BALANCE = { xpr: 50, usdc: 20 };

// ---------------------------------------------------------------- state
const sessions = new Map(); // sid -> { playing, songId, position, lastTick, spend, balance }
const appMode = {
  network: "testnet",
  payments_enabled: false,
  mainnet_payment_scope: "music_originals_only",
  // Mainnet is in maintenance: this build verifies testnet identity proofs
  // only (auth.js rejects any non-testnet chain id), so mainnet access is
  // unavailable by design until the contract phase. Exposed so both UIs
  // can show the MailSigil-style "maintenance" state instead of a dead link.
  mainnet_maintenance: true,
};
// XPR names: 1–12 a-z / 1-5, no dots. `ondastream` is the contract — never a payee.
function isXprAccount(name) {
  return typeof name === "string" && /^[a-z1-5]{1,12}$/.test(name);
}
function isStreamPayout(name) {
  return isXprAccount(name) && name !== "ondastream";
}
function isPaymentEligible(song) {
  return Boolean(song && song.payment_eligible === true && song.collection === "Music Originals" && song.rates);
}
for (const song of SONGS) {
  const hasRates = Boolean(song.rates);
  if (song.payment_eligible !== isPaymentEligible(song) || (song.payment_eligible === false && hasRates)) {
    throw new Error(`Invalid payment policy for catalog song: ${song.id}`);
  }
}

function loadLibrary() {
  try {
    const list = JSON.parse(fs.readFileSync(LIB_FILE, "utf8"));
    // Legacy entries used bare `sid`; migrate to scope_kind/scope_id once.
    let changed = false;
    const migrated = (Array.isArray(list) ? list : []).map((e) => {
      if (e.sid && !e.scope_kind) {
        changed = true;
        return { scope_kind: "sid", scope_id: e.sid, song_id: e.song_id, at: e.at || new Date().toISOString() };
      }
      return e;
    });
    if (changed) saveLibrary(migrated);
    return migrated;
  } catch { return []; }
}
function saveLibrary(list) {
  fs.writeFileSync(LIB_FILE, JSON.stringify(list, null, 2));
}

function loadPlaylists() {
  try {
    const list = JSON.parse(fs.readFileSync(PLAYLISTS_FILE, "utf8"));
    // Legacy entries used bare `sid`; migrate to scope_kind/scope_id once.
    let changed = false;
    const migrated = (Array.isArray(list) ? list : []).map((e) => {
      if (e.sid && !e.scope_kind) {
        changed = true;
        return { ...e, scope_kind: "sid", scope_id: e.sid, sid: undefined };
      }
      return e;
    });
    if (changed) savePlaylists(migrated);
    return migrated;
  } catch { return []; }
}
function savePlaylists(list) {
  fs.writeFileSync(PLAYLISTS_FILE, `${JSON.stringify(list, null, 2)}\n`);
}
function loadSubmissions() {
  try { return JSON.parse(fs.readFileSync(SUBMISSIONS_FILE, "utf8")); } catch { return []; }
}
function saveSubmissions(list) {
  fs.writeFileSync(SUBMISSIONS_FILE, `${JSON.stringify(list, null, 2)}\n`);
}
// Writes a base64 image upload into web/assets/covers and returns its URL.
// Shared by album art and per-song covers so the two paths cannot drift.
const albumRouteMatch = (p) => p.match(/^\/api\/albums\/([0-9a-f-]{36})$/i);
// Uploaded bytes get served back with their original filename extension from
// /web/ or /media/, so a permissive extension list turns any cover/photo/audio
// upload into a stored-XSS sink (.html/.svg execute at app origin). Allowlist
// only real media extensions — mirrors the C8 magic-byte discipline used for
// video, applied at write time to every sink.
const UPLOAD_EXT = {
  image: ["png", "jpg", "jpeg", "webp", "gif"],
  audio: ["mp3", "wav", "ogg", "m4a", "flac"],
};
const UPLOAD_MAX_B64 = 50 * 1024 * 1024; // same budget the video path uses
function uploadExt(name, kind, fallback) {
  const m = String(name || "").match(/\.([a-z0-9]+)$/i);
  const ext = (m ? m[1] : "").toLowerCase();
  return UPLOAD_EXT[kind].includes(ext) ? ext : fallback;
}

function writeCoverUpload(b64, name) {
  if (!b64) return "";
  if (b64.length > UPLOAD_MAX_B64) return "";
  const fname = `${crypto.randomUUID()}.${uploadExt(name, "image", "jpg")}`;
  fs.mkdirSync(path.join(ROOT, "web", "assets", "covers"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "web", "assets", "covers", fname), Buffer.from(b64, "base64"));
  return `/web/assets/covers/${fname}`;
}
function loadAlbums() {
  try { return JSON.parse(fs.readFileSync(ALBUMS_FILE, "utf8")); } catch { return []; }
}
function saveAlbums(list) {
  fs.writeFileSync(ALBUMS_FILE, `${JSON.stringify(list, null, 2)}\n`);
}

// -------------------------------------------------------------- agentcore
// The XPR ecosystem's agent registry (the same contract xpragents.com uses):
// code=`agentcore`, scope=`agentcore`, table=`agents`, keyed by the agent's
// account name. `owner` is the human wallet that CLAIMED the agent; "" means
// unclaimed. The Agents screen used to accept any regex-valid string typed by
// hand, so a typo, a non-existent account, or a wallet that is not an agent at
// all all looked identical. These two helpers are read-only chain queries — no
// signing, no writes.
//
// Real on-chain XPR balance (testnet) for a logged-in wallet. This is the
// source of truth the streaming screen SHOULD show, replacing the simulated
// seed once a real wallet is connected. Cached for a short window so polling
// every 2s doesn't hammer the node.
const chainBalanceCache = new Map(); // "actor:cur" -> { value, at }
async function getChainBalance(actor, cur) {
  const meta = TOKEN_CONTRACTS[cur];
  if (!meta) return null;
  const key = `${actor}:${cur}`;
  const hit = chainBalanceCache.get(key);
  if (hit && Date.now() - hit.at < 15000) return hit.value;
  try {
    const r = await fetch(`${NETWORK_RPC[appMode.network] || AGENTCORE_RPC}/v1/chain/get_currency_balance`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: meta.contract, account: actor, symbol: meta.symbol }),
    });
    if (!r.ok) return null;
    const arr = await r.json();
    // Empty array = account genuinely holds none of this token (real 0, not a failure).
    const amt = Array.isArray(arr) && arr.length ? parseFloat(arr[0]) : (Array.isArray(arr) ? 0 : null);
    const value = Number.isFinite(amt) ? amt : null;
    if (value !== null) chainBalanceCache.set(key, { value, at: Date.now() });
    return value;
  } catch { return null; }
}

// Same chain as everything else here (testnet). NOT cross-chain on purpose:
// `foo` on testnet and `foo` on mainnet are different identities with
// different keys, so resolving a mainnet claim for a testnet session would be
// a real spoofing hole. Note that as of 2026-08-19 the testnet registry has
// agents but ZERO claimed ones, so `owned_agents` is legitimately empty there
// until someone claims one — that is an accurate answer, not a failure.
const AGENTCORE_RPC = "https://testnet.protonchain.com";
const AGENTCORE_NETWORK = "testnet";
// Chain RPC endpoints per network (balances, agentcore, atomicassets). Mainnet
// is wired here so flipping `mainnet_maintenance` + a proof chain id is all it
// takes to go live — no scattered endpoint edits.
const NETWORK_RPC = {
  testnet: "https://testnet.protonchain.com",
  mainnet: "https://proton.eosusa.io",
};

// ------------------------------------------------------- onda pay mode
// Which path the keeper is using for a logged-in listener right now:
// "grant" (pulls straight from their wallet via pullpay) or "balance"
// (pulls from their topped-up ondastream balance via pullbal). The browser
// needs this so it can skip the legacy ensureChainLock()/startstream flow —
// calling that unconditionally while a grant or balance is active double-
// charges the listener (the keeper pulls separately either way).
//
// This is a read-only mirror of onda-pulse.js's own refreshModes(): same
// shape (one full-table read for ALL listeners, TTL-cached, never a
// per-listener query), but implemented separately here because onda-pulse.js
// is proven/frozen (do not modify) and this is a second, independent,
// UI-only consumer. Reads share the ONE process-wide RPC budget via
// rpc-budget.js's rpcSlot(), exactly like the keeper and price poller.
const { rpcSlot: ondaRpcSlot } = require("./rpc-budget");
const ONDA_CONTRACT = "ondastream";
const ONDA_MODE_TTL_MS = 15000;
let ondaModeMap = new Map();
let ondaModeAt = 0;

// A symbol's raw u64 packs precision in the low byte and the ASCII code
// above it (mirrors onda-pulse.js's symFromRaw) — needed because a contract
// name alone is ambiguous: `xtokens` hosts both XUSDC and METAL.
function ondaSymFromRaw(raw) {
  let v = BigInt(raw);
  const precision = Number(v & 0xffn);
  v >>= 8n;
  let code = "";
  while (v > 0n) {
    const c = Number(v & 0xffn);
    if (c) code += String.fromCharCode(c);
    v >>= 8n;
  }
  return { precision, code };
}

async function ondaRows(table) {
  await ondaRpcSlot();
  try {
    const r = await fetch(`${NETWORK_RPC[appMode.network] || AGENTCORE_RPC}/v1/chain/get_table_rows`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ json: true, code: ONDA_CONTRACT, scope: ONDA_CONTRACT, table, limit: 500 }),
    });
    if (!r.ok) return [];
    const data = await r.json();
    return Array.isArray(data.rows) ? data.rows : [];
  } catch { return []; }
}

async function refreshOndaModes() {
  if (Date.now() - ondaModeAt < ONDA_MODE_TTL_MS) return ondaModeMap;
  const now = Math.floor(Date.now() / 1000);
  const next = new Map();
  for (const g of await ondaRows("grants")) {
    if (Number(g.expiresAt) > now && Number(g.spent) < Number(g.budget)) {
      const { precision, code } = ondaSymFromRaw(g.symRaw);
      next.set(g.listener, { kind: "grant", contract: g.tokenContract, symbol: code, decimals: precision });
    }
  }
  for (const b of await ondaRows("balances")) {
    if (Number(b.amount) > 0 && !next.has(b.account)) {
      const { precision, code } = ondaSymFromRaw(b.symRaw);
      next.set(b.account, { kind: "balance", contract: b.tokenContract, symbol: code, decimals: precision });
    }
  }
  ondaModeMap = next;
  ondaModeAt = Date.now();
  return ondaModeMap;
}

/** "grant" | "balance" | null (no standing pay path — legacy lock flow applies). */
async function ondaModeFor(actor) {
  if (!actor) return null;
  const map = await refreshOndaModes();
  return map.get(actor) || null;
}

async function agentcoreRows(body) {
  const response = await fetch(`${NETWORK_RPC[appMode.network] || AGENTCORE_RPC}/v1/chain/get_table_rows`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ json: true, code: "agentcore", scope: "agentcore", table: "agents", ...body }),
  });
  if (!response.ok) throw new Error(`chain responded ${response.status}`);
  const data = await response.json();
  return Array.isArray(data.rows) ? data.rows : [];
}

// One agent by account name (primary index).
async function agentcoreGet(account) {
  const rows = await agentcoreRows({ lower_bound: account, upper_bound: account, limit: 1 });
  return rows.find((r) => r.account === account) || null;
}

// Every agent owned by `human` (secondary index on `owner`). Falls back to a
// bounded scan if the secondary index is unavailable on this node.
async function agentcoreOwnedBy(human) {
  try {
    const rows = await agentcoreRows({
      index_position: 2, key_type: "name", lower_bound: human, upper_bound: human, limit: 50,
    });
    const owned = rows.filter((r) => r.owner === human && r.account !== human).map((r) => r.account);
    if (owned.length) return owned;
  } catch { /* secondary index missing — fall through to the scan */ }
  try {
    const rows = await agentcoreRows({ limit: 300 });
    return rows.filter((r) => r.owner === human && r.account !== human).map((r) => r.account);
  } catch { return []; }
}

// ---------------------------------------------------------------- recents
// "Recently played" was localStorage-only on both clients, so it could never
// follow a wallet between devices the way favorites and playlists already do —
// play something on desktop, open mobile, and the row was a different history.
// Stored account-scoped (or session-scoped for guests) on the same
// scope_kind/scope_id pattern as the library.
function loadRecents() {
  try {
    const r = JSON.parse(fs.readFileSync(RECENTS_FILE, "utf8"));
    return Array.isArray(r) ? r : [];
  } catch { return []; }
}
function saveRecents(list) {
  fs.writeFileSync(RECENTS_FILE, `${JSON.stringify(list, null, 2)}\n`);
}
// One row per scope holding an ordered id list — most recent first. A row per
// PLAY would grow without bound and need pruning; this is inherently capped.
function recentsFor(scope) {
  const row = loadRecents().find((e) => scopeMatches(e, scope));
  return row && Array.isArray(row.song_ids) ? row.song_ids : [];
}

// --------------------------------------------------------- artist profile
// One profile per owning wallet: the artist's bio and photo belong to the
// ARTIST, not to each song. They used to be re-entered on every submission
// and copied onto the song row, so a bio change meant editing every song and
// the "artist photo" was really just whatever cover the last upload carried.
// Keyed by owner account; resolved onto songs at read time (songView) so
// editing the profile updates every one of that artist's songs at once.
function loadArtists() {
  try {
    const a = JSON.parse(fs.readFileSync(ARTISTS_FILE, "utf8"));
    return a && typeof a === "object" && !Array.isArray(a) ? a : {};
  } catch { return {}; }
}
function saveArtists(map) {
  fs.writeFileSync(ARTISTS_FILE, `${JSON.stringify(map, null, 2)}\n`);
}
function artistProfile(owner) {
  const all = loadArtists();
  const row = all[owner] || {};
  return {
    actor: owner,
    name: typeof row.name === "string" ? row.name : "",
    bio: typeof row.bio === "string" ? row.bio : "",
    photo: typeof row.photo === "string" ? row.photo : "",
    // Where streaming earnings settle. Separate from `actor` on purpose: the
    // account an artist LOGS IN with need not be the one that receives money
    // (BLUEPRINT "payoutAccount"), and an artist page can exist before a payout
    // destination is nominated.
    payout_account: typeof row.payout_account === "string" ? row.payout_account : "",
    updated_at: row.updated_at || null,
  };
}
// Songs carry the artist's bio/photo/name for the clients, but the PROFILE is
// the source of truth. Per-song values remain as a fallback for the seeded
// catalog (which has no owner profile) so nothing regresses.
// Profiles are keyed by the artist's OWN wallet, but the seeded catalog is
// owned end-to-end by one technical account (`musictesting`), so the owner
// lookup misses every artist and their photos silently vanish from the UI.
// Fall back to joining on the artist NAME: the profiles carry the right
// names, only the join column is wrong for these rows. An ambiguous name
// (two wallets claiming it) resolves to nothing rather than to whichever
// key happens to be enumerated first. Money routing never comes through
// here — payout follows `payout_account` on the song.
function artistRowsFor(all, song) {
  const direct = all[song.owner] || null;
  const want = typeof song.artist === "string" ? song.artist.trim().toLowerCase() : "";
  let named = null;
  if (want) {
    for (const key of Object.keys(all)) {
      const row = all[key];
      const name = row && typeof row.name === "string" ? row.name.trim().toLowerCase() : "";
      if (name !== want) continue;
      if (named) { named = null; break; }
      named = row;
    }
  }
  return { direct, named };
}
function songView(song) {
  const owner = song && song.owner;
  if (!owner) return song;
  const out = { ...song };
  // Resolved FIELD BY FIELD, not row by row. The owning account can have a
  // profile that exists but is blank -- prod carries a `musictesting` row
  // with no name or photo -- and an all-or-nothing row match stops there and
  // yields nothing. Each field falls through to the name-matched profile
  // instead, so a placeholder owner row can no longer blank out an artist.
  const { direct, named } = artistRowsFor(loadArtists(), song);
  if (direct || named) {
    const pick = (field) => {
      const d = direct && typeof direct[field] === "string" ? direct[field] : "";
      if (d) return d;
      return named && typeof named[field] === "string" ? named[field] : "";
    };
    out.artist_bio = pick("bio") || song.artist_bio || "";
    out.artist_photo = pick("photo") || song.artist_photo || "";
    // Artist NAME also belongs to the profile: the submit form no longer asks
    // for it (it was free-typed per song and drifted from the profile).
    const name = pick("name");
    if (name) out.artist = name;
  }
  // Album art belongs to the ALBUM: one image for the whole record, rather
  // than re-uploading the same cover with every track. A song's own cover
  // still wins if it has one (singles, and the seeded catalog).
  if (song.album_id && !song.cover) {
    const album = loadAlbums().find((a) => a.id === song.album_id);
    if (album && album.cover) {
      out.cover = album.cover;
      out.album_cover = true;
    }
  }
  return out;
}

// ---------------------------------------------------------------- metrics
// Listening metrics: plays + accrued listen-seconds per song, bucketed by
// listener scope (actor for wallet users, sid for guests). Written only on
// song change / pause so the poll loop never touches disk.
function loadMetrics() {
  try {
    const m = JSON.parse(fs.readFileSync(METRICS_FILE, "utf8"));
    if (m && typeof m === "object") {
      // Normalize: tolerate an empty/partial file ({} or missing keys).
      if (!m.songs || typeof m.songs !== "object") m.songs = {};
      if (!m.days || typeof m.days !== "object") m.days = {};
      if (!m.first_seen || typeof m.first_seen !== "object") m.first_seen = {};
      return m;
    }
  } catch {}
  return { songs: {}, days: {}, first_seen: {} };
}
function saveMetrics(m) {
  fs.writeFileSync(METRICS_FILE, JSON.stringify(m, null, 2));
}

// ---------------------------------------------------------------- grants
// Agent-wallet grants (MailSigil pattern): a wallet OWNER links an agent
// wallet and grants read/write access to their Onda account. Read lets the
// agent browse the owner's account state (favorites/playlists/metrics);
// write adds mutation + a (mock, testnet) top-up capability.
function loadGrants() {
  try { return JSON.parse(fs.readFileSync(GRANTS_FILE, "utf8")); } catch { return []; }
}
function saveGrants(list) {
  fs.writeFileSync(GRANTS_FILE, `${JSON.stringify(list, null, 2)}\n`);
}
function grantView(g) {
  const scopes = grantScopes(g);
  return {
    id: g.id,
    owner: g.owner,
    grantee: g.grantee,
    read: scopes.read,
    control: scopes.control,
    spend: scopes.spend,
    write: scopes.control,   // deprecated alias, kept so old clients still read

    created_at: g.created_at,
    revoked_at: g.revoked_at || null,
    revoked: Boolean(g.revoked_at),
  };
}
/**
 * Resolve effective access for an authed actor on another account.
 * Returns { read, write } or null if no active grant covers owner←actor.
 */
/**
 * Grant scopes. `write` used to mean BOTH "mutate the account" and "top it up",
 * so letting an agent skip a track or favourite a song also handed it your
 * money (/api/account/topup checked the same flag). Split three ways:
 *
 *   read    — now playing, favourites, playlists, listening stats, balance
 *   control — change track, play/pause, favourite, edit playlists
 *   spend   — top-up and anything that moves balance. Never implied.
 *
 * Legacy rows only have read/write. `write:true` migrates to control ONLY —
 * deliberately dropping top-up rather than silently preserving money access on
 * a grant issued before the distinction existed. Re-grant `spend` on purpose.
 */
function grantScopes(g) {
  const legacyWrite = Boolean(g.write);
  return {
    read: g.read === undefined ? true : Boolean(g.read),
    control: g.control === undefined ? legacyWrite : Boolean(g.control),
    spend: Boolean(g.spend),   // never inherited from legacy write
  };
}
const NO_ACCESS = Object.freeze({ read: false, control: false, spend: false, write: false });
function grantAccessFor(actor, owner) {
  if (actor === owner) return { read: true, control: true, spend: true, write: true }; // self = full
  const grants = loadGrants();
  const g = grants.find(
    (entry) => entry.grantee === actor && entry.owner === owner && !entry.revoked_at,
  );
  // Never null: every call site reads .read/.write off the result. Pre-audit
  // this returned null for unknown pairs and the `.write` deref crashed the
  // request (dormant until bearer-authenticated callers hit it for real).
  if (!g) return NO_ACCESS;
  const scopes = grantScopes(g);
  // `write` kept as an alias for `control` so existing call sites (writeGate,
  // library/playlist mutations) keep working unchanged.
  return { ...scopes, write: scopes.control };
}
function metricsEntry(m, songId) {
  if (!m.songs[songId]) m.songs[songId] = { plays: 0, listen_seconds: 0, listeners: {} };
  return m.songs[songId];
}
function dayKey(date = new Date()) {
  return date.toISOString().slice(0, 10); // "2026-08-16" (UTC day bucket)
}
function dayEntry(m, day, songId) {
  if (!m.days) m.days = {};
  if (!m.days[day]) m.days[day] = {};
  if (!m.days[day][songId]) m.days[day][songId] = { plays: 0, listen_seconds: 0, listeners: {} };
  return m.days[day][songId];
}
/**
 * Flush a session's accrued listening time into the metrics store.
 * Writes BOTH the lifetime aggregate and a per-day bucket (so the artist
 * graph can slice daily/weekly/monthly), and records first-seen per
 * listener per song (so "new" vs "returning" listeners are distinct).
 * `sess.metricsBase` is the position where the current chunk started;
 * attribution is `sess.metricsScope` (actor if wallet, else sid).
 * Called on song change, pause, and track end — never from the poll loop.
 */
function flushSessionMetrics(sess) {
  if (!sess.songId || sess.metricsBase === undefined) return;
  const seconds = Math.max(0, Number(sess.position) - Number(sess.metricsBase));
  if (seconds < 0.5 && !sess.metricsPlays) return; // ignore sub-second noise
  const m = loadMetrics();
  const entry = metricsEntry(m, sess.songId);
  const day = dayKey();
  const dEntry = dayEntry(m, day, sess.songId);
  const listenerKey = sess.metricsScope ? `${sess.metricsScope.kind}:${sess.metricsScope.id}` : `sid:${sess.metricsScopeRaw || "unknown"}`;
  if (seconds >= 0.5) {
    entry.listen_seconds += seconds;
    dEntry.listen_seconds += seconds;
    entry.listeners[listenerKey] = (entry.listeners[listenerKey] || 0) + seconds;
    dEntry.listeners[listenerKey] = (dEntry.listeners[listenerKey] || 0) + seconds;
  }
  if (sess.metricsPlays) {
    entry.plays += sess.metricsPlays;
    dEntry.plays += sess.metricsPlays;
    sess.metricsPlays = 0;
    // First-ever listen by this listener for this song → "new listener".
    if (!m.first_seen) m.first_seen = {};
    if (!m.first_seen[sess.songId]) m.first_seen[sess.songId] = {};
    if (!m.first_seen[sess.songId][listenerKey]) m.first_seen[sess.songId][listenerKey] = day;
  }
  saveMetrics(m);
  sess.metricsBase = sess.position;
}

/**
 * Build a time series over the per-day metric buckets.
 * period "day" → last 14 days (one bucket per day);
 * period "week" → last 8 weeks (bucket = ISO week start);
 * period "month" → last 6 months (bucket = month start).
 * Each bucket sums the owned songs' plays/listen-seconds and splits
 * listeners into new (first-ever listen inside the window) vs returning.
 */
function buildMetricBuckets(days, ownedIds, period, m) {
  const now = new Date();
  const byKey = new Map(); // bucketKey -> bucket
  const buckets = [];
  const makeBucket = (label, key, start, end) => {
    const b = { label, plays: 0, listen_seconds: 0, new_listeners: 0, returning_listeners: 0 };
    byKey.set(key, b);
    const withBounds = { ...b, _start: start, _end: end };
    buckets.push(withBounds);
    return withBounds;
  };
  const iso = (d) => d.toISOString().slice(0, 10);
  const dayStart = (d) => { const x = new Date(d); x.setUTCHours(0, 0, 0, 0); return x; };

  if (period === "day") {
    for (let i = 13; i >= 0; i--) {
      const s = dayStart(new Date(now.getTime() - i * 86400000));
      makeBucket(iso(s), iso(s), s, new Date(s.getTime() + 86400000));
    }
  } else if (period === "week") {
    const monday = (d) => { const x = dayStart(d); const dow = (x.getUTCDay() + 6) % 7; x.setUTCDate(x.getUTCDate() - dow); return x; };
    for (let i = 7; i >= 0; i--) {
      const s = monday(new Date(now.getTime() - i * 7 * 86400000));
      makeBucket(iso(s), `w:${iso(s)}`, s, new Date(s.getTime() + 7 * 86400000));
    }
  } else {
    for (let i = 5; i >= 0; i--) {
      const s = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      makeBucket(iso(s), `m:${iso(s)}`, s, new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + 1, 1)));
    }
  }

  const firstSeen = (m && m.first_seen) || {};
  for (const [day, songMap] of Object.entries(days || {})) {
    const dayMs = new Date(`${day}T00:00:00Z`).getTime();
    const bucket = buckets.find((b) => dayMs >= b._start.getTime() && dayMs < b._end.getTime());
    if (!bucket) continue;
    for (const [songId, dEntry] of Object.entries(songMap)) {
      if (!ownedIds.has(songId)) continue;
      bucket.plays += dEntry.plays || 0;
      bucket.listen_seconds += dEntry.listen_seconds || 0;
      const fs = firstSeen[songId] || {};
      for (const listener of Object.keys(dEntry.listeners || {})) {
        const seenDay = fs[listener];
        if (seenDay) {
          const seenMs = new Date(`${seenDay}T00:00:00Z`).getTime();
          if (seenMs >= bucket._start.getTime() && seenMs < bucket._end.getTime()) bucket.new_listeners += 1;
          else if (seenMs < bucket._end.getTime()) bucket.returning_listeners += 1;
        } else {
          bucket.returning_listeners += 1;
        }
      }
    }
  }
  return buckets.map(({ _start, _end, ...rest }) => rest);
}

/** Per-song stats within [startLabel, endLabel] (inclusive ISO day range). */
function songStatsInRange(m, songId, startLabel, endLabel) {
  const days = m.days || {};
  const firstSeen = m.first_seen || {};
  let plays = 0, listenSeconds = 0;
  const unique = new Set();
  let newListeners = 0, returning = 0;
  const seenForSong = firstSeen[songId] || {};
  for (const [day, dEntry] of Object.entries(days)) {
    if (day < startLabel || day > endLabel) continue;
    const entry = dEntry[songId];
    if (!entry) continue;
    plays += entry.plays || 0;
    listenSeconds += entry.listen_seconds || 0;
    for (const listener of Object.keys(entry.listeners || {})) {
      unique.add(listener);
      const seenDay = seenForSong[listener];
      if (seenDay && seenDay >= startLabel) newListeners += 1;
      else returning += 1;
    }
  }
  return { plays, listen_seconds: listenSeconds, unique: unique.size, newListeners, returning };
}
function playlistView(entry) {
  return {
    id: entry.id,
    name: entry.name,
    song_ids: entry.song_ids,
    songs: entry.song_ids.map((id) => SONGS.find((song) => song.id === id)).filter(Boolean),
    created_at: entry.created_at,
    updated_at: entry.updated_at,
  };
}
function sessionFor(req) {
  const sid = req.headers["x-session-id"];
  return { sid, session: sid && sessions.get(sid) };
}

/**
 * Resolve the owning scope for library/playlist state.
 * - Wallet-authed request (Authorization: Bearer <jwt>) → actor scope.
 * - Guest request with a valid session → sid scope.
 * - Nothing → null (caller returns 401).
 * Account scope means state survives across browsers/sessions and is
 * attached to the wallet identity, matching the MailSigil model where
 * state belongs to the verified actor, not the ephemeral session.
 */
function scopeFor(req) {
  const header = req.headers["authorization"] || "";
  const match = header.match(/^Bearer\s+(\S+)$/i);
  const actor = match ? auth.verifyToken(match[1]) : null;
  if (actor) {
    // Agent access: a granted agent may act on the owner's account scope.
    const target = req.headers["x-account-actor"];
    if (target && target !== actor) {
      const access = grantAccessFor(actor, target);
      if (access) return { kind: "actor", id: target, access };
    }
    return { kind: "actor", id: actor, access: { read: true, write: true } };
  }
  const sid = req.headers["x-session-id"];
  if (sid && sessions.has(sid)) return { kind: "sid", id: sid };
  return null;
}

function scopeMatches(entry, scope) {
  return entry.scope_kind === scope.kind && entry.scope_id === scope.id;
}

/**
 * Mutation gate: self-access always writes; a granted agent needs the
 * write flag. Returns an error body or null (proceed).
 */
function writeGate(scope) {
  if (scope && scope.access && scope.access.write === false) {
    return { error: "read-only grant — write access not granted" };
  }
  return null;
}
// Playlists are account features: a guest (session scope) must not create or
// edit them. This gate requires a verified wallet actor.
function actorGate(scope) {
  if (!scope || scope.kind !== "actor") {
    return { error: "wallet login required to manage playlists" };
  }
  return null;
}

/** Builds a scoped entry object for storage (actor or sid). */
function scopedEntry(scope, fields) {
  return { scope_kind: scope.kind, scope_id: scope.id, ...fields };
}

// --------------------------------------------------- streaming balances
// A balance belongs to a WALLET when there is one (persisted to disk, follows
// the actor across browsers/devices — same ownership model as favorites and
// playlists via scopeFor()). Guests fall back to a session-scoped balance held
// in memory. The on-chain top-up contract that will fund these for real is a
// later phase; SEED_BALANCE is the simulated-payment stand-in.
let tokenBalancesCache = null;
function loadTokenBalances() {
  if (!tokenBalancesCache) {
    try {
      const parsed = JSON.parse(fs.readFileSync(TOKEN_BALANCES_FILE, "utf8"));
      tokenBalancesCache = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch { tokenBalancesCache = {}; }
  }
  return tokenBalancesCache;
}
function saveTokenBalances() {
  // Written synchronously on every debit: the file is a few hundred bytes and
  // a `kill` of the server must not roll a balance back to its seed.
  fs.writeFileSync(TOKEN_BALANCES_FILE, JSON.stringify(loadTokenBalances(), null, 2));
}
/** Persisted per-currency balances for a wallet. A logged-in wallet starts at
 * 0 and is hydrated from the real chain (see hydrateWalletBalances); guests
 * keep SEED_BALANCE as a demo preview. */
function accountBalances(actor) {
  const all = loadTokenBalances();
  let entry = all[actor];
  if (!entry || typeof entry !== "object") {
    entry = { xpr: 0, usdc: 0, loan: 0, metal: 0, hydrated: false };
    all[actor] = entry;
    saveTokenBalances();
  }
  return entry;
}
/**
 * Pull a logged-in wallet's REAL on-chain balances (all four currencies) and
 * write them into its persisted entry so both the playback gate and the display
 * use real money — not the simulated seed. A missing token = 0.
 */
async function hydrateWalletBalances(actor) {
  const entry = accountBalances(actor);
  for (const cur of CURRENCIES) {
    const real = await getChainBalance(actor, cur);
    entry[cur] = Number.isFinite(real) ? real : 0;
  }
  entry.hydrated = true;
  saveTokenBalances();
  return entry;
}
/** The balance object this session should read/write: wallet's or its own. */
function balancesFor(sess) {
  if (sess.actor) return accountBalances(sess.actor);
  if (!sess.balance) sess.balance = { ...SEED_BALANCE };
  return sess.balance;
}
/**
 * Stamp the wallet identity (if any) on the session before tick/state, so a
 * login switches the session to the wallet's persisted balances and a logout
 * drops it back to the guest session balance on the very next request.
 */
// ── account-scoped now-playing ───────────────────────────────────────────
// Playback lives in an in-memory session keyed to a BROWSER (X-Session-Id), so
// an agent holding a grant had no way to see or change what its human is
// listening to — the two things Gabriel actually wants agents to do. This
// mirrors the active session onto the ACCOUNT so both are reachable by
// account name, and lets an agent queue a track the browser picks up on its
// existing 2s poll (no new transport, no push channel).
const nowPlaying = new Map();   // actor -> { song_id, playing, position, at }
const pendingTrack = new Map(); // actor -> song_id requested by an agent

function publishNowPlaying(sess) {
  if (!sess || !sess.actor) return;
  nowPlaying.set(sess.actor, {
    // sess.songId — camelCase. Reading sess.song_id silently gave undefined,
    // so the agent saw "nothing playing" while the human was mid-track.
    song_id: sess.songId || null,
    playing: Boolean(sess.playing),
    position: Number(sess.position) || 0,
    currency: sess.currency || "xpr",
    at: new Date().toISOString(),
  });
}

function bindSessionActor(req, sess) {
  const header = req.headers["authorization"] || "";
  const match = header.match(/^Bearer\s+(\S+)$/i);
  const actor = match ? auth.verifyToken(match[1]) : null;
  sess.actor = actor || null;
  return actor;
}

function getSession(sid) {
  if (!sessions.has(sid)) {
    sessions.set(sid, {
      playing: false, songId: null, position: 0, lastTick: Date.now(),
      spend: { xpr: 0, usdc: 0, loan: 0, metal: 0 },
      // Remaining per-currency balance for this session: seeded here and
      // debited in tick() by the exact amount spend is credited, so the
      // picker can show money counting DOWN. Session-scoped and simulated —
      // unrelated to /api/account/balance (one scalar, wallet-only top-ups).
      balance: { ...SEED_BALANCE },
      // Only the SELECTED currency accrues (POST /api/session/currency).
      currency: "xpr", spend_usd: 0,
      escrow_usd: 0, escrow_cur: "xpr",
      // metrics: where the current listen chunk started + who owns it
      metricsBase: undefined, metricsScope: null, metricsScopeRaw: null, metricsPlays: 0,
    });
  }
  return sessions.get(sid);
}

function persistWallet(sess) {
  if (sess.actor) saveTokenBalances();
}

function songFor(sess) {
  return SONGS.find((candidate) => candidate.id === sess.songId) || null;
}

// 2s rolling hold. Testnet: no chain transfers. Vest actual play from
// escrow; rebate unused escrow on explicit stop; stale heartbeat vests
// the open window (crash bound) and does not refill.
function tick(sess, { renew = true, now = Date.now() } = {}) {
  const wasPlaying = sess.playing;
  const song = songFor(sess);
  meter.tick(sess, {
    now,
    eligible: isPaymentEligible(song),
    duration: song ? song.duration_s : 0,
    wallet: balancesFor(sess),
    renew,
    persist: () => persistWallet(sess),
  });
  if (wasPlaying && !sess.playing) flushSessionMetrics(sess);
  return sess;
}

function rebateHold(sess) {
  meter.closePlay(sess, balancesFor(sess), () => persistWallet(sess));
}

async function sessionState(sess) {
  tick(sess);
  const song = SONGS.find((s) => s.id === sess.songId) || null;
  const ondaMode = sess.actor ? await ondaModeFor(sess.actor) : null;
  return {
    playing: sess.playing,
    // Set when the keeper had to stop playback because a slice could not be
    // paid (credits empty, grant revoked/expired, budget hit).
    payment_error: sess.payment_error || null,
    // "grant" | "balance" | "none" — which on-chain path the keeper is
    // pulling from for this listener right now. The browser must skip the
    // legacy ensureChainLock()/startstream flow whenever this is grant or
    // balance: the keeper already pulls on its own 2s cadence, so opening a
    // lock on top of that double-charges the listener.
    pay_mode: ondaMode ? ondaMode.kind : "none",
    pay_mode_token: ondaMode ? { contract: ondaMode.contract, symbol: ondaMode.symbol, decimals: ondaMode.decimals } : null,
    song,
    position: +sess.position.toFixed(2),
    // 8 decimals: at $0.00005/sec XPR accrues ~0.00012/sec, so the old 6/4
    // decimal rounding threw away visible movement in the first seconds.
    spend: {
      xpr: +sess.spend.xpr.toFixed(8),
      usdc: +sess.spend.usdc.toFixed(8),
      loan: +sess.spend.loan.toFixed(8),
      metal: +(sess.spend.metal || 0).toFixed(8),
    },
    // Remaining balance per currency, same 8-decimal rounding as spend.
    // `balance_scope` says whose money it is: "actor" once a wallet is logged
    // in (persisted across restarts/devices), "session" for guests.
    // `seed_balance` ships alongside so a client can render "of 50 XPR"
    // without hardcoding the number again.
    balance: (() => {
      const wallet = balancesFor(sess);
      const out = {};
      for (const cur of CURRENCIES) out[cur] = +Math.max(0, Number(wallet[cur]) || 0).toFixed(8);
      return out;
    })(),
    balance_scope: sess.actor ? "actor" : "session",
    balance_actor: sess.actor || null,
    seed_balance: SEED_BALANCE,
    // Set when tick() halted playback for lack of funds; the clients turn it
    // into a "top up / switch currency" message. Cleared on the next play.
    stopped_reason: sess.stopReason || null,
    currency: CURRENCIES.includes(sess.currency) ? sess.currency : "xpr",
    spend_usd: +(sess.spend_usd || 0).toFixed(6),
    usd_per_sec: USD_PER_SEC,
    // LIVE oracle prices, not the hardcoded TOKEN_USD constants — those had
    // drifted 36% on XPR and 132% on METAL, so every USD figure shown to a
    // listener was wrong. TOKEN_USD remains the per-token fallback.
    token_usd: await ondaWallet.livePrices(TOKEN_USD),
    payments_enabled: appMode.payments_enabled,
    payment_eligible: isPaymentEligible(song),
    stream_window_s: meter.WINDOW_S,
    held_usd: +((sess.escrow_usd || 0)).toFixed(8),
    held: (() => {
      const cur = sess.escrow_cur && TOKEN_USD[sess.escrow_cur] ? sess.escrow_cur : (CURRENCIES.includes(sess.currency) ? sess.currency : "xpr");
      return { currency: cur, tokens: +meter.usdToTok(sess.escrow_usd || 0, cur).toFixed(8) };
    })(),
  };
}

// ---------------------------------------------------------------- helpers
function send(res, code, body, type = "application/json") {
  const data = type === "application/json" ? JSON.stringify(body) : body;
  res.writeHead(code, { "Content-Type": type, "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,X-Session-Id,Authorization" });
  res.end(data);
}

/**
 * Live testnet AtomicAssets lookup for a song's NFT linkage. Returns the
 * planned linkage (collection/schema/template) plus any minted assets found
 * on testnet. Never throws — a failed query degrades to the plan only.
 * Collector NFT semantics per blueprint: references song_id, does not
 * redirect streaming income.
 */
async function nftLinkageFor(song) {
  const base = {
    song_id: song.id,
    title: song.title,
    collection: NFT_COLLECTION,
    schema: NFT_SCHEMA,
    template: null,
    minted: Boolean(song.minted),
    assets: [],
  };
  try {
    const params = new URLSearchParams({
      collection_name: NFT_COLLECTION,
      schema_name: NFT_SCHEMA,
      limit: "100",
    });
    const response = await fetch(`${NFT_API_BY_NETWORK[appMode.network] || NFT_API}/templates?${params}`);
    if (!response.ok) return { ...base, plan_only: true, note: "template query failed" };
    const { data: templates } = await response.json();
    // The real song↔NFT linkage is immutable_data.song_id on the template
    // (blueprint: collector NFT references song_id). Match on that, not a
    // name — AtomicAssets template ids are numeric and arbitrary.
    const template = (templates || []).find(
      (t) => String(t.immutable_data?.song_id) === song.id,
    );
    base.template_id = template ? template.template_id : null;
    if (template) {
      const assetParams = new URLSearchParams({ template_id: String(template.template_id), limit: "100" });
      const assetResponse = await fetch(`${NFT_API_BY_NETWORK[appMode.network] || NFT_API}/assets?${assetParams}`);
      if (assetResponse.ok) {
        const { data: assets } = await assetResponse.json();
        base.assets = (assets || []).map((a) => ({
          asset_id: a.asset_id,
          owner: a.owner,
          data: a.data || {},
        }));
      }
    }
    return base;
  } catch {
    return { ...base, plan_only: true, note: "testnet lookup unavailable" };
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => { try { resolve(JSON.parse(b || "{}")); } catch { resolve({}); } });
  });
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css",
  ".mp3": "audio/mpeg", ".mp4": "video/mp4", ".webm": "video/webm", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml" };

function serveStatic(res, req, filePath) {
  const full = path.join(ROOT, filePath);
  if (!full.startsWith(ROOT) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    return send(res, 404, { error: "not found" });
  }
  const stat = fs.statSync(full);
  const type = MIME[path.extname(full)] || "application/octet-stream";
  const range = req.headers["range"];
  // HTTP Range support — required for smooth seek/scrub on audio. Without it
  // the browser can only seek within already-buffered data, so seeking back
  // past the buffer fails and forces a reload (the reported seek bug).
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m) {
      const start = m[1] ? parseInt(m[1], 10) : 0;
      const end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
      const safeStart = Math.min(Math.max(0, start), stat.size - 1);
      const safeEnd = Math.min(Math.max(safeStart, end), stat.size - 1);
      res.writeHead(206, {
        "Content-Type": type,
        "Content-Range": `bytes ${safeStart}-${safeEnd}/${stat.size}`,
        "Accept-Ranges": "bytes",
        "Content-Length": safeEnd - safeStart + 1,
      });
      fs.createReadStream(full, { start: safeStart, end: safeEnd }).pipe(res);
      return;
    }
  }
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": stat.size,
    "Accept-Ranges": "bytes",
  });
  fs.createReadStream(full).pipe(res);
}

// ---------------------------------------------------------------- routes

// ---------------------------------------------------------------- rate limit
// Per-IP token bucket on every request. In-memory (resets on restart) — fine
// for testnet single-instance; swap for Redis when multi-instance.
const rateBuckets = new Map();
const RATE_LIMIT = 300;
// Static assets (covers, artist photos, audio) get their own, larger budget:
// ONE home-page load legitimately pulls 30+ images, so counting them against
// the API budget meant a few honest page views looked like an attack.
const RATE_LIMIT_STATIC = 1200;
const RATE_WINDOW_MS = 60_000;
// Caddy reverse-proxies from 127.0.0.1, so req.socket.remoteAddress is the
// PROXY for every visitor — the bucket was effectively one global 300/min
// shared by everyone on the internet, and a couple of page loads exhausted
// it (observed live 2026-08-27: the whole site returning 429). Trust
// X-Forwarded-For only when the immediate peer is loopback; a direct client
// can therefore never forge its own identity.
function clientIp(req) {
  const peer = req.socket?.remoteAddress || "unknown";
  const loopback = peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
  if (!loopback) return peer;
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd !== "string" || !fwd) return peer;
  // Left-most entry is the original client; Caddy appends, so this is the
  // one hop we actually trust.
  const first = fwd.split(",")[0].trim();
  return first || peer;
}
function isStaticPath(p) {
  return p.startsWith("/web/") || p.startsWith("/media/");
}
function rateLimit(req, pathname) {
  const limit = isStaticPath(pathname) ? RATE_LIMIT_STATIC : RATE_LIMIT;
  const key = `${isStaticPath(pathname) ? "s" : "a"}:${clientIp(req)}`;
  const now = Date.now();
  if (!rateBuckets.has(key)) rateBuckets.set(key, { tokens: limit, lastRefill: now });
  const b = rateBuckets.get(key);
  if (now - b.lastRefill > RATE_WINDOW_MS) { b.tokens = limit; b.lastRefill = now; }
  if (b.tokens <= 0) return false;
  b.tokens -= 1;
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  if (!rateLimit(req, p)) return send(res, 429, { error: "too many requests" });
  if (req.method === "OPTIONS") return send(res, 204, "");

  if (p === "/api/catalog") {
    // Categories were derived purely from the songs on disk, so a genre with
    // no tracks yet could never be picked — a chicken-and-egg that capped the
    // catalog at whatever had already been uploaded. The canonical list is
    // the source of truth now; anything a song already uses is unioned in so
    // nothing in the existing catalog can vanish.
    const categories = [...new Set([
      ...CATEGORIES,
      ...SONGS.map((song) => song.category).filter(Boolean),
    ])].sort();
    return send(res, 200, {
      songs: SONGS.map(songView),
      categories,
      subcategories: SUBCATEGORIES,
      mode: { ...appMode, playback_requires_wallet: true },
    });
  }

  // Wallet login: identity-proof verification (MailSigil pattern). The
  // client posts the wallet's "EOSIO <base64>" proof; we verify it against
  // the actor's live on-chain authority and return a 7-day session token.
  if (p === "/api/auth/verify-proof" && req.method === "POST") {
    const body = await readBody(req);
    if (!body.proof || typeof body.proof !== "string") {
      return send(res, 400, { error: "missing 'proof' string" });
    }
    try {
      const { actor, permission } = await auth.verifyIdentityProof(body.proof);
      const session = auth.mintAccessToken(actor);
      return send(res, 200, {
        ok: true,
        actor,
        permission,
        token: session.token,
        expires_at: session.expires_at,
        scope: "wallet-ownership",
      });
    } catch (error) {
      return send(res, 401, { error: error.message || "verification failed" });
    }
  }

  // WebAuth desktop popup returns a session and no IdentityProof. Client
  // fetches a nonce, signs sigillogin::login (never broadcast), posts here.
  if (p === "/api/auth/nonce" && req.method === "POST") {
    return send(res, 200, auth.issueChallenge());
  }

  if (p === "/api/auth/verify" && req.method === "POST") {
    const body = await readBody(req);
    try {
      const { actor, permission } = await auth.verifySignedLogin(body);
      const session = auth.mintAccessToken(actor);
      return send(res, 200, {
        ok: true,
        actor,
        permission,
        token: session.token,
        expires_at: session.expires_at,
        scope: "wallet-ownership",
      });
    } catch (error) {
      const code = error instanceof auth.AuthError ? 401 : 400;
      return send(res, code, { error: error.message || "verification failed" });
    }
  }

  // Current wallet session (Authorization: Bearer <token>).
  if (p === "/api/auth/me") {
    const header = req.headers["authorization"] || "";
    const match = header.match(/^Bearer\s+(\S+)$/i);
    const actor = match ? auth.verifyToken(match[1]) : null;
    if (!actor) return send(res, 401, { error: "not authenticated" });
    return send(res, 200, { actor, authenticated: true, scope: "wallet-ownership" });
  }

  // NFT-song linkage: planned AtomicAssets collector-NFT for each
  // payment-eligible song, with live testnet mint status where available.
  if (p === "/api/nfts") {
    const songs = SONGS.filter((song) => isPaymentEligible(song));
    const linkage = await Promise.all(songs.map(nftLinkageFor));
    return send(res, 200, { collection: NFT_COLLECTION, schema: NFT_SCHEMA, songs: linkage });
  }

  if (p === "/api/network") {
    // LIVE listeners: sessions actively playing with a fresh heartbeat.
    // Ticks land every ~2s while playing, so anything older than 15s is an
    // abandoned tab (there is no explicit "closed the browser" signal).
    const now = Date.now();
    let live = 0;
    for (const sess of sessions.values()) {
      if (sess.playing && now - Number(sess.lastTick || 0) < 15000) live += 1;
    }
    // Streaming-money contract of record (ondastream). The clients sign play /
    // stop / top-up / withdraw against these endpoints — both modes (wallet
    // and Onda balance) vest the same way on chain, only the source of the
    // lock differs. Surfaced here so the UI has ONE place to read the
    // contract account, the memos the notify() recognises, and the two
    // payable tokens. Mainnet still gated by appMode.mainnet_maintenance; the
    // contract address / memos are the same on both nets (BLUEPRINT-pay-modes.md).
    const net = NETWORKS[appMode.network] || NETWORKS.testnet;
    return send(res, 200, {
      network: appMode.network,
      payments_enabled: appMode.payments_enabled,
      // Gate for the ON-CHAIN pay UI (wallet-direct + Onda balance). This is
      // NOT payments_enabled — that one governs the legacy simulated JSON
      // meter and stays false. The ondastream contract is live on testnet, so
      // testnet is true; mainnet stays shut behind the maintenance door until
      // the mainnet deploy + invert SHIP (BLUEPRINT-pay-modes.md).
      chain_pay_enabled: appMode.network === "testnet" || !appMode.mainnet_maintenance,
      mainnet_maintenance: appMode.mainnet_maintenance,
      xpr_paid_today: 0,
      settling: appMode.payments_enabled ? "live" : "test mode · no charges",
      listeners: live,
      contract: {
        account: "ondastream",
        chain_id: net.chainId,
        // Memo prefixes the notify() branches on. "onda" parks into the
        // listener's balances row; "s:<songId>" locks straight from the wallet
        // (memo must NOT be "deposit" — Metal X DEX footgun, stuck funds).
        memos: { topup: "onda", play: "s:" },
        // Hard allowlist — same as on-chain `isAccepted` check. LOAN/METAL/XUSDT/XBTC
        // are still displayable on the player but are NOT payable here. The
        // picker enforces this; the contract re-checks.
        accepted_tokens: [
          { code: "XPR",  contract: "eosio.token", symbol: "XPR",  decimals: 4 },
          { code: "XUSDC", contract: "xtokens",    symbol: "XUSDC", decimals: 6 },
        ],
        // Buffer/window bounds the client must respect BEFORE signing, so the
        // browser never hardcodes them and never eats an on-chain assert.
        // Literals mirroring the deployed contract constants
        // (contracts/ondastream/assembly/ondastream.contract.ts:
        // DEFAULT_WINDOW / DEFAULT_BUFFER / MAX_BUFFER / MAX_SONG_ID) — the
        // server does NOT read the contract source at runtime. Keep in sync by
        // hand when the contract redeploys.
        // startstream asserts `buffer >= config.windowSec && buffer <= MAX_BUFFER`
        // ("buffer 2-180s"); a wallet-direct transfer asserts the same range in
        // value terms (rate x windowSec <= quantity <= rate x MAX_BUFFER).
        buffer: { window_sec: 2, default_sec: 30, max_sec: 180 },
        // songId length cap — the memo "s:<songId>" tail and the startstream
        // arg both check `0 < len <= 64` ("bad song_id").
        max_song_id_len: 64,
        actions: {
          topup:      { account: null, name: "transfer", memo: "onda" }, // account = token contract
          play_wallet:{ account: null, name: "transfer", memo: "s:<songId>" },
          play_balance:{ account: "ondastream", name: "startstream" },
          stop:       { account: "ondastream", name: "stopstream" },
          pulse:      { account: "ondastream", name: "pulse" },
          expire:     { account: "ondastream", name: "expire" },
          withdraw:   { account: "ondastream", name: "withdraw" },
        },
      },
    });
  }

  // Agent surface (MailSigil pattern): compact live-listener state for tools
  // and CLIs. Read-scoped by the same grant system the account routes use —
  // an agent needs `read` on an owner to see that owner's session; without a
  // grant it sees only aggregate counts (no per-listener detail).
  if (p === "/api/agents/listeners") {
    const actor = (url.searchParams.get("actor") || "").trim();
    const owner = (url.searchParams.get("owner") || "").trim();
    const format = (url.searchParams.get("format") || "").trim();
    const now = Date.now();
    const live = [];
    for (const [sid, sess] of sessions) {
      if (!sess.playing || now - Number(sess.lastTick || 0) >= 15000) continue;
      const song = SONGS.find((s) => s.id === sess.songId) || null;
      live.push({
        sid,
        actor: sess.actor || "",
        song_id: sess.songId,
        title: song ? song.title : null,
        artist: song ? song.artist : null,
        position_s: Math.round(Number(sess.position) || 0),
      });
    }
    if (format === "toon") {
      // Token-efficient output for agents (Kun Chen / AXI): one line per
      // listener, semantics over JSON ceremony.
      const lines = live.map((l) => `${l.actor || l.sid.slice(0,8)} | ${l.title ?? "-"} | ${l.position_s}s`);
      return send(res, 200, { text: `live_listeners=${live.length}\n${lines.join("\n")}`.trim(), count: live.length });
    }
    // Grant gate for per-listener detail when an owner is requested.
    if (owner) {
      const access = grantAccessFor(actor, owner);
      if (!access || !access.read) return send(res, 403, { error: "read access to that owner required" });
      const scoped = live.filter((l) => l.actor === owner);
      return send(res, 200, { listeners: scoped, count: scoped.length });
    }
    return send(res, 200, { listeners: live, count: live.length });
  }

  if (p === "/api/radio") {
    const category = (url.searchParams.get("category") || "").trim();
    const candidates = category ? SONGS.filter((song) => song.category === category) : SONGS;
    if (!candidates.length) return send(res, 404, { error: "no songs in that category" });
    return send(res, 200, { song: candidates[Math.floor(Math.random() * candidates.length)], category: category || "All" });
  }

  // For You radio: a personalized queue built from the listener's favorites
  // and playlists, shuffled. Falls back to the full catalog for new listeners
  // with no saved songs. Optionally filtered by category.
  if (p === "/api/radio/for-you" && req.method === "GET") {
    const scope = scopeFor(req);
    const category = (url.searchParams.get("category") || "").trim();
    // Gather the listener's saved song ids from library + playlists.
    // scopeFor returns null for guests without a session — fall back to
    // the full catalog in that case (no personalization yet).
    const savedIds = new Set();
    if (scope) {
      loadLibrary().filter((e) => scopeMatches(e, scope)).forEach((e) => savedIds.add(e.song_id));
      loadPlaylists().filter((pl) => scopeMatches(pl, scope)).forEach((pl) => {
        (pl.song_ids || []).forEach((id) => savedIds.add(id));
      });
    }
    let candidates = SONGS.filter((s) => savedIds.has(s.id));
    if (category) candidates = candidates.filter((s) => s.category === category);
    // Fallback: if no saved songs (or none in this category), use the full catalog
    if (!candidates.length) candidates = category ? SONGS.filter((s) => s.category === category) : SONGS;
    if (!candidates.length) return send(res, 404, { error: "no songs found" });
    // Fisher-Yates shuffle for a random queue
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    const seedSong = candidates[Math.floor(Math.random() * candidates.length)];
    return send(res, 200, {
      song: seedSong,
      queue: candidates.map((s) => s.id),
      personalized: savedIds.size > 0,
      category: category || "For You",
      total: candidates.length,
    });
  }

  // Genre stations: return available genres that have songs in the catalog
  if (p === "/api/radio/stations" && req.method === "GET") {
    const catCount = {};
    SONGS.forEach((s) => {
      const cat = s.category || "Other";
      catCount[cat] = (catCount[cat] || 0) + 1;
    });
    const stations = Object.entries(catCount)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
    return send(res, 200, { stations });
  }

  if (p === "/api/session" && req.method === "POST") {
    const body = await readBody(req);
    const reusable = typeof body.session_id === "string" && /^[0-9a-f-]{36}$/i.test(body.session_id);
    const sid = reusable ? body.session_id : crypto.randomUUID();
    getSession(sid);
    return send(res, 200, { session_id: sid });
  }

  if (p === "/api/session/state") {
    const sid = req.headers["x-session-id"];
    if (!sid || !sessions.has(sid)) return send(res, 401, { error: "no session" });
    const sess = sessions.get(sid);
    // Re-bind every poll: a login mid-session must switch the reported
    // balances to the wallet's persisted ones (and a logout back again).
    bindSessionActor(req, sess);
    publishNowPlaying(sess);
    // An agent may have asked for a different track since the last poll. Hand
    // it to the browser in the state payload; the client switches and the next
    // poll publishes the new track back. One direction of truth at a time.
    const queued = sess.actor ? pendingTrack.get(sess.actor) : null;
    if (queued) pendingTrack.delete(sess.actor);
    return send(res, 200, { ...(await sessionState(sess)), agent_request: queued ? { song_id: queued } : null });
  }

  if (p === "/api/session/currency" && req.method === "POST") {
    const sid = req.headers["x-session-id"];
    const sess = sid && sessions.get(sid);
    if (!sess) return send(res, 401, { error: "no session" });
    const body = await readBody(req);
    const cur = typeof body.currency === "string" ? body.currency.toLowerCase() : "";
    if (!CURRENCIES.includes(cur)) return send(res, 400, { error: "unknown currency" });
    // Close out accrual at the OLD currency first: whatever was already earned
    // stays denominated in the currency it was actually earned in. Switching
    // mid-song must never retroactively move or convert past spend. Rebate the
    // old hold (do not vest it) then lock a fresh 2s window in the new token.
    bindSessionActor(req, sess);
    if (sess.actor) await hydrateWalletBalances(sess.actor);
    tick(sess, { renew: false });
    rebateHold(sess);
    sess.currency = cur;
    sess.escrow_cur = cur;
    const song = songFor(sess);
    if (sess.playing && isPaymentEligible(song)) {
      if (!meter.openPlay(sess, balancesFor(sess), () => persistWallet(sess))) {
        sess.playing = false;
        sess.stopReason = { reason: "insufficient_balance", currency: cur };
        flushSessionMetrics(sess);
      }
    }
    // Switching to a funded currency is the recovery path from a zero-balance
    // stop (there is no real top-up yet), so drop the stale reason.
    if ((Number(balancesFor(sess)[cur]) || 0) > 0) sess.stopReason = null;
    return send(res, 200, await sessionState(sess));
  }

  if (p === "/api/session/play" && req.method === "POST") {
    // Playback requires a verified wallet (re-gated 2026-08-20). Guests may
    // still browse; metrics attribute to the wallet when present.
    const sid = req.headers["x-session-id"];
    const body = await readBody(req);
    const sess = sid && sessions.get(sid);
    if (!sess) return send(res, 401, { error: "no session" });
    const actor = bindSessionActor(req, sess);
    if (!actor) return send(res, 401, { error: "wallet login required to play" });
    await hydrateWalletBalances(actor);
    tick(sess, { renew: false });
    if (body.song_id && !SONGS.some((song) => song.id === body.song_id)) {
      return send(res, 400, { error: "bad song" });
    }
    const wanted = SONGS.find((song) => song.id === (body.song_id || sess.songId)) || null;
    if (body.song_id && body.song_id !== sess.songId) {
      // Song switch: rebate unused hold of the previous track, then start a new window.
      rebateHold(sess);
      flushSessionMetrics(sess);
      sess.songId = body.song_id;
      sess.position = Number(body.position) || 0;
      sess.metricsBase = sess.position;
      sess.metricsScope = actor ? { kind: "actor", id: actor } : { kind: "sid", id: sid };
      sess.metricsScopeRaw = actor ? null : sid;
      sess.metricsPlays = 1;
    }
    if (typeof body.position === "number") sess.position = Math.max(0, body.position);
    // No money, no billable music. Free CC tracks are unaffected: they cost
    // nothing, so a zero balance is irrelevant to them and they still start.
    if (isPaymentEligible(wanted)) {
      const cur = CURRENCIES.includes(sess.currency) ? sess.currency : "xpr";
      if (!meter.openPlay(sess, balancesFor(sess), () => persistWallet(sess))) {
        sess.playing = false;
        sess.stopReason = { reason: "insufficient_balance", currency: cur };
        return send(res, 409, { error: "insufficient balance", currency: cur, balance: 0 });
      }
    } else {
      rebateHold(sess);
    }
    sess.stopReason = null;
    sess.playing = true;
    // Fresh attempt: clear any previous "could not be paid" state so a resolved
    // top-up or re-grant is not reported as still failing.
    sess.payment_error = null;
    sess.lastTick = Date.now();
    return send(res, 200, await sessionState(sess));
  }

  // What the listener holds, and what it is worth — so the Top Up picker can
  // show real balances instead of making them guess which token to use.
  // Server-side because it must share the ONE global RPC budget; the browser
  // must never poll the chain itself.
  if (p === "/api/onda/wallet" && req.method === "GET") {
    const sid = req.headers["x-session-id"];
    const sess = sid && sessions.get(sid);
    if (sess) bindSessionActor(req, sess);
    const actor = (sess && sess.actor) || (url.searchParams.get("actor") || "").trim();
    if (!actor) return send(res, 200, { actor: null, tokens: [], reliable: false });
    try {
      return send(res, 200, await ondaWallet.walletFor(actor));
    } catch (e) {
      // `reliable:false` means "we could not tell", which the UI must not
      // render as "you have nothing".
      return send(res, 200, { actor, tokens: [], reliable: false, error: String(e && e.message || e).slice(0, 120) });
    }
  }

  if (p === "/api/session/pause" && req.method === "POST") {
    const sid = req.headers["x-session-id"];
    const sess = sid && sessions.get(sid);
    if (!sess) return send(res, 401, { error: "no session" });
    bindSessionActor(req, sess);
    tick(sess, { renew: false });
    rebateHold(sess);
    flushSessionMetrics(sess);
    sess.playing = false;
    // Pause deliberately does NOT `expire`. Expiring refunded the entire
    // remaining lock/credit, so the very next song had nothing to draw on and
    // forced a fresh signature. Pausing should hold your place; the keeper
    // simply stops pulling. Cash-out happens on stop/logout, not on pause.
    return send(res, 200, await sessionState(sess));
  }

  // ── search ────────────────────────────────────────────────────────────
  // Public, ranked. An agent asked to "find that house track with the piano"
  // had to download the entire catalog and filter it locally; this is the
  // lookup surface for that. Scores exact > prefix > substring across title,
  // artist, album, category and collection so the best match sorts first.
  if (p === "/api/search" && req.method === "GET") {
    const q = (url.searchParams.get("q") || "").trim().toLowerCase();
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit")) || 10));
    if (!q) return send(res, 400, { error: "q is required" });
    const terms = q.split(/\s+/).filter(Boolean);
    const scored = SONGS.map((song) => {
      const fields = [
        [String(song.title || "").toLowerCase(), 6],
        [String(song.artist || "").toLowerCase(), 5],
        [String(song.album_name || "").toLowerCase(), 3],
        [String(song.category || "").toLowerCase(), 2],
        [String(song.subcategory || "").toLowerCase(), 4],   // "house" should beat "electronic"
        [String(song.collection || "").toLowerCase(), 1],
      ];
      let score = 0;
      for (const term of terms) {
        for (const [value, weight] of fields) {
          if (!value) continue;
          if (value === term) score += weight * 4;
          else if (value.startsWith(term)) score += weight * 2;
          else if (value.includes(term)) score += weight;
        }
      }
      return { song, score };
    }).filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    return send(res, 200, {
      query: q,
      count: scored.length,
      songs: scored.map((r) => ({ ...songView(r.song), match_score: r.score })),
    });
  }

  // ── agent-shaped playlist add ─────────────────────────────────────────
  // Humans say "add it to my walk playlist", not a UUID. Resolves BOTH the
  // playlist and the song by name (case-insensitive, exact then substring),
  // and optionally creates the playlist. Ambiguity is reported rather than
  // guessed — silently picking one of two matching playlists is worse than
  // asking.  (scope: control)
  if (p === "/api/playlists/add-by-name" && req.method === "POST") {
    const scope = scopeFor(req);
    if (!scope) return send(res, 401, { error: "no session" });
    if (scope.access && scope.access.control === false) {
      return send(res, 403, { error: "no control access to this account" });
    }
    const body = await readBody(req);
    const wantList = String(body.playlist || "").trim().toLowerCase();
    const wantSong = String(body.song || "").trim().toLowerCase();
    if (!wantList || !wantSong) return send(res, 400, { error: "playlist and song are required" });

    const match = (items, want, key) => {
      const exact = items.filter((i) => String(i[key] || "").toLowerCase() === want);
      if (exact.length) return exact;
      return items.filter((i) => String(i[key] || "").toLowerCase().includes(want));
    };

    const songHits = match(SONGS, wantSong, "title");
    if (!songHits.length) return send(res, 404, { error: `no song matching "${body.song}"` });
    if (songHits.length > 1) {
      return send(res, 409, { error: "ambiguous song", matches: songHits.map((x) => ({ id: x.id, title: x.title, artist: x.artist })) });
    }
    const song = songHits[0];

    const playlists = loadPlaylists();
    const mine = playlists.filter((e) => scopeMatches(e, scope));
    let listHits = match(mine, wantList, "name");
    if (listHits.length > 1) {
      return send(res, 409, { error: "ambiguous playlist", matches: listHits.map((x) => ({ id: x.id, name: x.name })) });
    }
    let target = listHits[0];
    let created = false;
    if (!target) {
      if (!body.create) return send(res, 404, { error: `no playlist matching "${body.playlist}" — pass create:true to make it` });
      target = scopedEntry(scope, {
        id: crypto.randomUUID(),
        name: String(body.playlist).trim().slice(0, 40),
        song_ids: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      playlists.push(target);
      created = true;
    }
    const index = playlists.findIndex((e) => e.id === target.id);
    const ids = playlists[index].song_ids || [];
    const already = ids.includes(song.id);
    if (!already) ids.push(song.id);
    playlists[index].song_ids = ids;
    playlists[index].updated_at = new Date().toISOString();
    savePlaylists(playlists);
    return send(res, 200, {
      ok: true,
      created_playlist: created,
      already_present: already,
      playlist: playlistView(playlists[index]),
      song: { id: song.id, title: song.title, artist: song.artist },
    });
  }

  // Agent-facing: what is my human listening to right now?  (scope: read)
  if (p === "/api/now-playing" && req.method === "GET") {
    const header = req.headers["authorization"] || "";
    const m = header.match(/^Bearer\s+(\S+)$/i);
    const actor = m ? auth.verifyToken(m[1]) : null;
    if (!actor) return send(res, 401, { error: "wallet login required" });
    const target = (req.headers["x-account-actor"] || actor).toString().trim().toLowerCase();
    const access = grantAccessFor(actor, target);
    if (!access || !access.read) return send(res, 403, { error: "no read access to this account" });
    const state = nowPlaying.get(target);
    if (!state || !state.song_id) {
      return send(res, 200, { account: target, playing: false, song: null, since: null });
    }
    const song = SONGS.find((x) => x.id === state.song_id);
    return send(res, 200, {
      account: target,
      playing: state.playing,
      position_s: Math.round(state.position),
      since: state.at,
      song: song ? songView(song) : null,
    });
  }

  // Agent-facing: put a different track on.  (scope: control)
  // Queues the request; the human's browser picks it up on its next state poll.
  // Deliberately not a direct mutation of the session — the browser owns the
  // audio element, so the server cannot make sound happen on its own.
  if (p === "/api/now-playing/track" && req.method === "POST") {
    const header = req.headers["authorization"] || "";
    const m = header.match(/^Bearer\s+(\S+)$/i);
    const actor = m ? auth.verifyToken(m[1]) : null;
    if (!actor) return send(res, 401, { error: "wallet login required" });
    const body = await readBody(req);
    const target = typeof body.account === "string" ? body.account.trim().toLowerCase() : actor;
    const access = grantAccessFor(actor, target);
    if (!access || !access.control) {
      return send(res, 403, { error: "no control access to this account" });
    }
    const songId = typeof body.song_id === "string" ? body.song_id : "";
    const song = SONGS.find((x) => x.id === songId);
    if (!song) return send(res, 400, { error: "unknown song_id" });
    if (!nowPlaying.has(target)) {
      return send(res, 409, { error: "that account has no active listening session" });
    }
    pendingTrack.set(target, song.id);
    return send(res, 200, { ok: true, queued: songView(song), account: target });
  }

  if (p === "/api/recents" && req.method === "GET") {
    const scope = scopeFor(req);
    if (!scope) return send(res, 401, { error: "no session" });
    const ids = recentsFor(scope);
    return send(res, 200, {
      song_ids: ids,
      songs: ids.map((id) => SONGS.find((s) => s.id === id)).filter(Boolean).map(songView),
    });
  }

  if (p === "/api/recents" && req.method === "POST") {
    const scope = scopeFor(req);
    if (!scope) return send(res, 401, { error: "no session" });
    const gate = writeGate(scope);
    if (gate) return send(res, 403, gate);
    const body = await readBody(req);
    const songId = typeof body.song_id === "string" ? body.song_id : "";
    if (!SONGS.find((s) => s.id === songId)) return send(res, 400, { error: "bad song" });
    const rows = loadRecents();
    const index = rows.findIndex((e) => scopeMatches(e, scope));
    const existing = index >= 0 && Array.isArray(rows[index].song_ids) ? rows[index].song_ids : [];
    const ids = [songId, ...existing.filter((id) => id !== songId)].slice(0, RECENT_MAX);
    const row = scopedEntry(scope, { song_ids: ids, updated_at: new Date().toISOString() });
    if (index >= 0) rows[index] = row; else rows.push(row);
    saveRecents(rows);
    return send(res, 200, { ok: true, song_ids: ids });
  }

  if (p === "/api/library") {
    const scope = scopeFor(req);
    if (!scope) return send(res, 401, { error: "no session" });
    const lib = loadLibrary().filter((e) => scopeMatches(e, scope));
    return send(res, 200, { saved: lib.map((e) => SONGS.find((s) => s.id === e.song_id)).filter(Boolean) });
  }

  if (p === "/api/library/save" && req.method === "POST") {
    const scope = scopeFor(req);
    const body = await readBody(req);
    if (!scope) return send(res, 401, { error: "no session" });
    const gate = writeGate(scope);
    if (gate) return send(res, 403, gate);
    if (!SONGS.find((s) => s.id === body.song_id)) return send(res, 400, { error: "bad song" });
    const lib = loadLibrary();
    if (!lib.find((e) => scopeMatches(e, scope) && e.song_id === body.song_id)) {
      lib.push(scopedEntry(scope, { song_id: body.song_id, at: new Date().toISOString() }));
      saveLibrary(lib);
    }
    return send(res, 200, { ok: true });
  }

  if (p === "/api/library/remove" && req.method === "POST") {
    const scope = scopeFor(req);
    const body = await readBody(req);
    if (!scope) return send(res, 401, { error: "no session" });
    const gate = writeGate(scope);
    if (gate) return send(res, 403, gate);
    if (!SONGS.some((song) => song.id === body.song_id)) return send(res, 400, { error: "bad song" });
    const lib = loadLibrary().filter((entry) => !(scopeMatches(entry, scope) && entry.song_id === body.song_id));
    saveLibrary(lib);
    return send(res, 200, { ok: true });
  }

  if (p === "/api/playlists" && req.method === "GET") {
    const scope = scopeFor(req);
    if (!scope) return send(res, 401, { error: "no session" });
    return send(res, 200, { playlists: loadPlaylists().filter((entry) => scopeMatches(entry, scope)).map(playlistView) });
  }

  if (p === "/api/playlists" && req.method === "POST") {
    const scope = scopeFor(req);
    const body = await readBody(req);
    if (!scope) return send(res, 401, { error: "no session" });
    const gate = actorGate(scope);
    if (gate) return send(res, 401, gate);
    const name = typeof body.name === "string" ? body.name.trim().replace(/\s+/g, " ") : "";
    if (!name || name.length > 40) return send(res, 400, { error: "Playlist names must be 1–40 characters" });
    const playlists = loadPlaylists();
    if (playlists.some((entry) => scopeMatches(entry, scope) && entry.name.toLowerCase() === name.toLowerCase())) {
      return send(res, 409, { error: "A playlist with that name already exists" });
    }
    const now = new Date().toISOString();
    const playlist = { ...scopedEntry(scope, {}), id: crypto.randomUUID(), name, song_ids: [], created_at: now, updated_at: now };
    playlists.push(playlist);
    savePlaylists(playlists);
    return send(res, 201, { playlist: playlistView(playlist) });
  }

  const playlistRoute = p.match(/^\/api\/playlists\/([0-9a-f-]{36})(?:\/(add|remove|delete))?$/i);
  if (playlistRoute) {
    const scope = scopeFor(req);
    if (!scope) return send(res, 401, { error: "no session" });
    const playlists = loadPlaylists();
    const index = playlists.findIndex((entry) => entry.id === playlistRoute[1] && scopeMatches(entry, scope));
    if (index < 0) return send(res, 404, { error: "playlist not found" });
    const action = playlistRoute[2];
    if (!action) {
      if (req.method === "GET") return send(res, 200, { playlist: playlistView(playlists[index]) });
      return send(res, 405, { error: "method not allowed" });
    }
    if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
    const gate = actorGate(scope);
    if (gate) return send(res, 401, gate);
    if (action === "delete") {
      const [removed] = playlists.splice(index, 1);
      savePlaylists(playlists);
      return send(res, 200, { ok: true, playlist: playlistView(removed) });
    }
    const body = await readBody(req);
    if (!SONGS.some((song) => song.id === body.song_id)) return send(res, 400, { error: "bad song" });
    const ids = playlists[index].song_ids;
    if (action === "add" && !ids.includes(body.song_id)) ids.push(body.song_id);
    if (action === "remove") playlists[index].song_ids = ids.filter((id) => id !== body.song_id);
    playlists[index].updated_at = new Date().toISOString();
    savePlaylists(playlists);
    return send(res, 200, { playlist: playlistView(playlists[index]) });
  }

  // ── Artist profile (bio + photo live here, not on each song) ───────────
  if (p === "/api/artist/profile" && req.method === "GET") {
    const header = req.headers["authorization"] || "";
    const m = header.match(/^Bearer\s+(\S+)$/i);
    const actor = m ? auth.verifyToken(m[1]) : null;
    if (!actor) return send(res, 401, { error: "wallet login required" });
    let platformCut = 0;
    try { platformCut = Number(JSON.parse(fs.readFileSync(path.join(ROOT, "catalog/split-defaults.json"), "utf8")).platform_cut_pct) || 0; } catch {}
    return send(res, 200, { profile: artistProfile(actor), platform_cut_pct: platformCut });
  }

  if (p === "/api/artist/profile" && req.method === "PUT") {
    const header = req.headers["authorization"] || "";
    const m = header.match(/^Bearer\s+(\S+)$/i);
    const actor = m ? auth.verifyToken(m[1]) : null;
    if (!actor) return send(res, 401, { error: "wallet login required" });
    const body = await readBody(req);
    const all = loadArtists();
    const row = all[actor] || {};
    if (typeof body.name === "string") row.name = body.name.trim().slice(0, 40);
    if (typeof body.bio === "string") row.bio = body.bio.trim().slice(0, 500);
    if (typeof body.payout_account === "string") {
      const acct = body.payout_account.trim().toLowerCase();
      if (acct && !isStreamPayout(acct)) {
        return send(res, 400, { error: "payout_account must be a real XPR account (not ondastream, no dots)" });
      }
      row.payout_account = acct;
    }
    // Photo may arrive as a base64 upload or be left alone.
    const photoB64 = typeof body.photo_base64 === "string" ? body.photo_base64 : "";
    if (photoB64) {
      if (photoB64.length > UPLOAD_MAX_B64) return send(res, 400, { error: "photo too large" });
      const fname = `${crypto.randomUUID()}.${uploadExt(body.photo_name, "image", "jpg")}`;
      fs.mkdirSync(path.join(ROOT, "web", "assets", "artists"), { recursive: true });
      fs.writeFileSync(path.join(ROOT, "web", "assets", "artists", fname), Buffer.from(photoB64, "base64"));
      row.photo = `/web/assets/artists/${fname}`;
    }
    row.updated_at = new Date().toISOString();
    all[actor] = row;
    saveArtists(all);
    return send(res, 200, { profile: artistProfile(actor) });
  }

  // ── agentcore lookup: is this account a registered agent, and who owns it?
  // Reads the on-chain registry (code/scope `agentcore`, table `agents`) on
  // THIS deployment's own chain. Deliberately not cross-chain: an account
  // name on testnet is not the same identity as the same name on mainnet.
  if (p === "/api/agents/lookup" && req.method === "GET") {
    const header = req.headers["authorization"] || "";
    const m = header.match(/^Bearer\s+(\S+)$/i);
    const actor = m ? auth.verifyToken(m[1]) : null;
    if (!actor) return send(res, 401, { error: "wallet login required" });
    const account = (url.searchParams.get("account") || "").trim().toLowerCase();
    if (account && !/^[a-z1-5.]{1,12}$/.test(account)) {
      return send(res, 400, { error: "not a valid XPR account name" });
    }
    try {
      const [row, owned] = await Promise.all([
        account ? agentcoreGet(account) : Promise.resolve(null),
        agentcoreOwnedBy(actor),
      ]);
      return send(res, 200, {
        account: account || null,
        registered: Boolean(row),
        owner: row && row.owner ? row.owner : null,
        pending_owner: row && row.pending_owner ? row.pending_owner : null,
        // Agents the LOGGED-IN wallet owns — the "linked agent wallets" list.
        owned_agents: owned,
        network: AGENTCORE_NETWORK,
      });
    } catch (error) {
      return send(res, 502, { error: `agentcore lookup failed: ${error.message || error}` });
    }
  }

  // Albums: artists create albums and assign songs to them.
  if (p === "/api/albums" && req.method === "POST") {
    const body = await readBody(req);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const owner = typeof body.actor === "string" ? body.actor.trim() : "";
    if (!name || !owner) return send(res, 400, { error: "name and artist are required" });
    if (name.length > 40) return send(res, 400, { error: "album name too long" });
    const albums = loadAlbums();
    if (albums.some((a) => a.owner === owner && a.name.toLowerCase() === name.toLowerCase())) {
      return send(res, 409, { error: "album already exists" });
    }
    const album = {
      id: crypto.randomUUID(),
      name,
      owner,
      // Album art — applied to every song filed under this album (songView).
      cover: writeCoverUpload(body.cover_base64, body.cover_name),
      created_at: new Date().toISOString(),
    };
    albums.push(album);
    saveAlbums(albums);
    return send(res, 201, { album });
  }

  // Update an album's name or art. Same token-derived ownership rule as
  // DELETE below — re-arting someone else's record must not be possible.
  if (albumRouteMatch(p) && req.method === "PUT") {
    const header = req.headers["authorization"] || "";
    const m = header.match(/^Bearer\s+(\S+)$/i);
    const owner = m ? auth.verifyToken(m[1]) : null;
    if (!owner) return send(res, 401, { error: "wallet login required" });
    const albums = loadAlbums();
    const index = albums.findIndex((a) => a.id === albumRouteMatch(p)[1]);
    if (index < 0) return send(res, 404, { error: "album not found" });
    if (albums[index].owner !== owner) return send(res, 403, { error: "not your album" });
    const body = await readBody(req);
    if (typeof body.name === "string" && body.name.trim()) albums[index].name = body.name.trim().slice(0, 40);
    const cover = writeCoverUpload(body.cover_base64, body.cover_name);
    if (cover) albums[index].cover = cover;
    saveAlbums(albums);
    return send(res, 200, { album: albums[index] });
  }

  // Delete an album. Ownership is taken from the wallet TOKEN, never from a
  // body field — otherwise anyone could delete anyone's album by naming them.
  // Songs filed under it are NOT deleted; they fall back to "no album", which
  // is why this is safe to confirm-and-go rather than a destructive cascade.
  const albumRoute = albumRouteMatch(p);
  if (albumRoute && req.method === "DELETE") {
    const header = req.headers["authorization"] || "";
    const m = header.match(/^Bearer\s+(\S+)$/i);
    const owner = m ? auth.verifyToken(m[1]) : null;
    if (!owner) return send(res, 401, { error: "wallet login required" });
    const albums = loadAlbums();
    const index = albums.findIndex((a) => a.id === albumRoute[1]);
    if (index < 0) return send(res, 404, { error: "album not found" });
    if (albums[index].owner !== owner) return send(res, 403, { error: "not your album" });
    const [removed] = albums.splice(index, 1);
    saveAlbums(albums);
    // Unfile any songs that pointed at it so nothing renders a dead album name.
    let touched = 0;
    SONGS.forEach((song) => {
      if (song.album_id === removed.id) {
        song.album_id = "";
        song.album_name = "";
        touched += 1;
      }
    });
    if (touched) fs.writeFileSync(path.join(ROOT, "catalog/songs.json"), `${JSON.stringify(SONGS, null, 2)}\n`);
    return send(res, 200, { ok: true, removed: removed.name, songs_unfiled: touched });
  }

  if (p === "/api/albums" && req.method === "GET") {
    const owner = (url.searchParams.get("owner") || "").trim();
    let list = loadAlbums();
    if (owner) list = list.filter((a) => a.owner === owner);
    return send(res, 200, { albums: list });
  }

  // Artist submissions + admin moderation
  if (p === "/api/submissions" && req.method === "POST") {
    const body = await readBody(req);
    // S2 gate: identity comes ONLY from a verified wallet token, or the
    // operator's admin PIN (legacy console path). body.actor alone is never
    // trusted — owner names are public via /api/catalog.
    const header = req.headers["authorization"] || "";
    const m = header.match(/^Bearer\s+(\S+)$/i);
    const submitter = m ? auth.verifyToken(m[1]) : null;
    const isAdminPin = req.headers["x-admin-pin"] === ADMIN_PIN;
    if (!submitter && !isAdminPin) return send(res, 401, { error: "wallet login required" });
    const owner = submitter || (isAdminPin && typeof body.actor === "string" && body.actor ? body.actor : "");
    if (!owner) return send(res, 401, { error: "wallet login required" });
    const title = typeof body.title === "string" ? body.title.trim() : "";
    // The artist NAME comes from the artist PROFILE, not a free-typed field —
    // it used to drift from the profile and let a typo masquerade as an artist.
    // Fall back to the submitted value (legacy clients) or the wallet.
    const ownerEarly = owner;
    const profileRow = ownerEarly ? loadArtists()[ownerEarly] : null;
    const artist = (
      (profileRow && typeof profileRow.name === "string" && profileRow.name) ||
      (typeof body.artist === "string" ? body.artist.trim() : "") ||
      ownerEarly
    );
    const category = typeof body.category === "string" ? body.category.trim() : "";
    const subRaw = typeof body.subcategory === "string" ? body.subcategory.trim() : "";
    // Only accept a sub-genre that belongs to the chosen category — otherwise a
    // track ends up filed as Jazz/House and the filters quietly lie.
    const subcategory = (SUBCATEGORIES[category] || []).includes(subRaw) ? subRaw : "";
    // No `bio` here any more: the artist bio lives on the artist PROFILE
    // (PUT /api/artist/profile) and is resolved onto every one of that
    // artist's songs by songView(). Re-typing it per song was the complaint.
    const album_id = typeof body.album_id === "string" ? body.album_id.trim() : "";
    if (!title || !artist) return send(res, 400, { error: "title and artist name are required" });
    if (!category) return send(res, 400, { error: "category is required" });
    if (title.length > 80 || artist.length > 40) return send(res, 400, { error: "a field is too long" });
    // Audio: uploaded file (base64) or URL fallback.
    const audioB64 = typeof body.audio_base64 === "string" ? body.audio_base64 : "";
    const audioName = typeof body.audio_name === "string" ? body.audio_name : "";
    const fileUrl = typeof body.file === "string" ? body.file.trim() : "";
    let file = "";
    if (audioB64) {
      if (audioB64.length > UPLOAD_MAX_B64) {
        return send(res, 400, { error: "audio too large (max ~35MB)" });
      }
      const fname = `${crypto.randomUUID()}.${uploadExt(audioName, "audio", "mp3")}`;
      fs.mkdirSync(path.join(ROOT, "media", "songs", "uploads"), { recursive: true });
      fs.writeFileSync(path.join(ROOT, "media", "songs", "uploads", fname), Buffer.from(audioB64, "base64"));
      file = `uploads/${fname}`;
    } else if (fileUrl) {
      file = fileUrl;
    }
    if (!file) return send(res, 400, { error: "audio file is required" });

    // Cover is OPTIONAL now: art belongs to the album, so a track filed under
    // one inherits it (songView). A single with no art falls back to the
    const cover = writeCoverUpload(body.cover_base64, body.cover_name)
      || (typeof body.cover === "string" ? body.cover.trim() : "");

    // Music video: optional URL, or a base64 .mp4/.webm upload saved into
    // media/videos/. Stored as the catalog-relative path (like `file`).
    const videoB64 = typeof body.video_base64 === "string" ? body.video_base64 : "";
    const videoName = typeof body.video_name === "string" ? body.video_name : "";
    const videoUrl = typeof body.video === "string" ? body.video.trim() : "";
    let video = "";
    if (videoB64) {
      // C8: validate content type + cap size before writing.
      if (videoB64.length > 50 * 1024 * 1024) { // ~37 MB decoded base64 → 50 MB b64 chars
        return send(res, 400, { error: "video too large (max ~35MB)" });
      }
      const buf = Buffer.from(videoB64, "base64");
      // MP4 starts with 'ftyp' at offset 4; WebM starts with EBML header 0x1A45DFA3
      const isMp4 = buf.length > 12 && buf.toString("ascii", 4, 8) === "ftyp";
      const isWebm = buf.length > 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3;
      if (!isMp4 && !isWebm) {
        return send(res, 400, { error: "not a valid MP4 or WebM file" });
      }
      const ext = ((videoName.match(/\.([a-z0-9]+)$/i) || [])[1] || "mp4").toLowerCase();
      const safeExt = ["mp4", "webm"].includes(ext) ? ext : "mp4";
      const fname = `${crypto.randomUUID()}.${safeExt}`;
      fs.mkdirSync(path.join(ROOT, "media", "videos", "uploads"), { recursive: true });
      fs.writeFileSync(path.join(ROOT, "media", "videos", "uploads", fname), buf);
      video = `uploads/${fname}`;
    } else if (videoUrl) {
      video = videoUrl;
    }

    // Payout: artists may name a primary payout wallet and split earnings
    // across multiple wallets by percent. Validate both server-side (the UI
    // does too, but the API is the trust boundary).
    const payoutAccount = typeof body.payout_account === "string" ? body.payout_account.trim().toLowerCase() : "";
    if (!isStreamPayout(payoutAccount)) {
      return send(res, 400, { error: "payout_account is required — a real XPR account (not ondastream, no dots)" });
    }
    const splitsIn = Array.isArray(body.splits) ? body.splits : [];
    const cleanSplits = splitsIn
      .map((sp) => ({ wallet: String((sp && sp.wallet) || "").trim().toLowerCase(), pct: Number((sp && sp.pct) || 0) }))
      .filter((s) => s.wallet && s.pct > 0);
    for (const s of cleanSplits) {
      if (!isStreamPayout(s.wallet)) return send(res, 400, { error: `split wallet "${s.wallet}" must be a real XPR account (not ondastream)` });
    }
    const splitTotal = cleanSplits.reduce((a, s) => a + s.pct, 0);
    if (splitTotal > 100) return send(res, 400, { error: "split percentages exceed 100%" });

    // Songs publish immediately — no admin approval gate (Gabriel 2026-08-19:
    // "songs dont need our approval"). The submission row is still written so
    // there is an audit trail and the admin screen keeps working, but it is
    // recorded as already published rather than pending. The admin
    // approve/reject routes stay for the legacy pending backlog.
    const submissions = loadSubmissions();
    const submission = {
      id: crypto.randomUUID(),
      title, artist,
      category,
      file,
      cover,
      video,
      color: /^#[0-9a-f]{6}$/i.test(body.color || "") ? body.color : "#6d8bff",
      status: "published",
      submitted_by: owner,
      submitted_at: new Date().toISOString(),
    };

    const albums = loadAlbums();
    const album = album_id ? albums.find((a) => a.id === album_id && a.owner === owner) : null;
    const base = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "song";
    const song = {
      id: `${base}-${crypto.randomUUID().slice(0, 6)}`,
      title,
      artist,
      collection: "Music Originals",
      category,
      subcategory,
      payment_eligible: true,
      duration_s: 180,
      file,
      color: submission.color,
      minted: false,
      rates: { xpr: 0.002, usdc: 0.0013, loan: 0.072, metal: 0.0009 },
      license: "Artist-submitted",
      cover,
      video,
      // artist_photo / artist_bio deliberately NOT set from this upload: the
      // cover is the SONG's art, not the artist's face. songView() resolves
      // both from the artist profile.
      album_id: album ? album.id : "",
      album_name: album ? album.name : "",
      owner,
      // Payment splits: default is 100% to the artist's payout wallet.
      // Admin can set a platform_cut_pct that applies globally; artists
      // can override with multi-wallet splits per song via PUT /api/songs/:id/splits.
      payout_account: payoutAccount,
      splits: cleanSplits,
    };
    // Remember the primary payout wallet on the artist profile (if given) so
    // future submissions and the settlement script default to it.
    if (payoutAccount) {
      const artists = loadArtists();
      const arow = artists[owner] || {};
      arow.payout_account = payoutAccount;
      artists[owner] = arow;
      saveArtists(artists);
    }
    SONGS.push(song);
    fs.writeFileSync(path.join(ROOT, "catalog/songs.json"), `${JSON.stringify(SONGS, null, 2)}\n`);
    submission.song_id = song.id;
    submissions.push(submission);
    saveSubmissions(submissions);
    return send(res, 201, { submission, song: songView(song), published: true });
  }

  // ── Agent grants (MailSigil pattern) ────────────────────────────────────
  // List grants issued BY the authed wallet (owner view).
  if (p === "/api/grants" && req.method === "GET") {
    const header = req.headers["authorization"] || "";
    const match = header.match(/^Bearer\s+(\S+)$/i);
    const owner = match ? auth.verifyToken(match[1]) : null;
    if (!owner) return send(res, 401, { error: "wallet login required" });
    const grants = loadGrants().filter((g) => g.owner === owner).map(grantView);
    return send(res, 200, { grants });
  }

  // Grant an agent wallet read/write access to the authed wallet's account.
  if (p === "/api/grants" && req.method === "POST") {
    const header = req.headers["authorization"] || "";
    const match = header.match(/^Bearer\s+(\S+)$/i);
    const owner = match ? auth.verifyToken(match[1]) : null;
    if (!owner) return send(res, 401, { error: "wallet login required" });
    const body = await readBody(req);
    const grantee = typeof body.grantee === "string" ? body.grantee.trim().toLowerCase() : "";
    if (!/^[a-z1-5.]{1,12}$/.test(grantee)) {
      return send(res, 400, { error: "grantee must be a valid XPR account name" });
    }
    if (grantee === owner) return send(res, 400, { error: "cannot grant access to yourself" });
    const grants = loadGrants();
    if (grants.some((g) => g.owner === owner && g.grantee === grantee && !g.revoked_at)) {
      return send(res, 409, { error: "an active grant to this wallet already exists" });
    }
    const grant = {
      id: crypto.randomUUID(),
      owner,
      grantee,
      read: body.read !== false,
      control: body.control !== undefined ? Boolean(body.control) : Boolean(body.write),
      spend: Boolean(body.spend),
      created_at: new Date().toISOString(),
      revoked_at: null,
    };
    grants.push(grant);
    saveGrants(grants);
    return send(res, 201, { grant: grantView(grant) });
  }

  // Grant detail / revoke.
  const grantRoute = p.match(/^\/api\/grants\/([0-9a-f-]{36})(?:\/(revoke))?$/i);
  if (grantRoute) {
    const header = req.headers["authorization"] || "";
    const match = header.match(/^Bearer\s+(\S+)$/i);
    const owner = match ? auth.verifyToken(match[1]) : null;
    if (!owner) return send(res, 401, { error: "wallet login required" });
    const grants = loadGrants();
    const index = grants.findIndex((g) => g.id === grantRoute[1] && g.owner === owner);
    if (index < 0) return send(res, 404, { error: "grant not found" });
    if (grantRoute[2] === "revoke") {
      grants[index].revoked_at = new Date().toISOString();
      saveGrants(grants);
      return send(res, 200, { ok: true, grant: grantView(grants[index]) });
    }
    return send(res, 200, { grant: grantView(grants[index]) });
  }

  // Account balance read (self or granted read access).
  if (p === "/api/account/balance") {
    const header = req.headers["authorization"] || "";
    const match = header.match(/^Bearer\s+(\S+)$/i);
    const actor = match ? auth.verifyToken(match[1]) : null;
    if (!actor) return send(res, 401, { error: "wallet login required" });
    const target = req.headers["x-account-actor"] || actor;
    const access = grantAccessFor(actor, target);
    if (!access || !access.read) return send(res, 403, { error: "no read access to this account" });
    const balFile = path.join(ROOT, "catalog", "balances.json");
    let balances = {};
    try { balances = JSON.parse(fs.readFileSync(balFile, "utf8")); } catch {}
    return send(res, 200, { account: target, balance: +(balances[target] || 0) });
  }

  // Top-up mock: a wallet with WRITE access (self or granted agent) adds
  // credit to the target account. Testnet mock only — no chain transfer.
  if (p === "/api/account/topup" && req.method === "POST") {    const header = req.headers["authorization"] || "";
    const match = header.match(/^Bearer\s+(\S+)$/i);
    const actor = match ? auth.verifyToken(match[1]) : null;
    if (!actor) return send(res, 401, { error: "wallet login required" });
    const body = await readBody(req);
    const target = typeof body.account === "string" ? body.account.trim().toLowerCase() : actor;
    const amount = Math.max(0, Number(body.amount) || 0);
    if (!Number.isFinite(amount) || amount <= 0) return send(res, 400, { error: "amount must be positive" });
    const access = grantAccessFor(actor, target);
    // Money needs `spend` explicitly — `control` (skip a track, favourite a
    // song) must never be enough to move a balance.
    if (!access || !access.spend) {
      return send(res, 403, { error: "no spend access to this account — top-up requires the spend scope" });
    }
    const balFile = path.join(ROOT, "catalog", "balances.json");
    let balances = {};
    try { balances = JSON.parse(fs.readFileSync(balFile, "utf8")); } catch {}
    balances[target] = +(balances[target] || 0) + amount;
    fs.writeFileSync(balFile, JSON.stringify(balances, null, 2));
    return send(res, 200, { ok: true, account: target, balance: balances[target], topped_up_by: actor });
  }

  // Admin: full listening metrics (plays, listen-seconds, listeners per song).
  if (p === "/api/metrics") {
    if (req.headers["x-admin-pin"] !== ADMIN_PIN) return send(res, 401, { error: "admin pin required" });
    const m = loadMetrics();
    // Platform cut is the admin-controlled share applied to every song's
    // accrual; read it live so the dashboard number matches the toggle.
    let platformCut = 0;
    try { platformCut = Number(JSON.parse(fs.readFileSync(path.join(ROOT, "catalog/split-defaults.json"), "utf8")).platform_cut_pct) || 0; } catch {}
    const songs = SONGS.map((song) => {
      const entry = m.songs[song.id] || { plays: 0, listen_seconds: 0, listeners: {} };
      const seconds = entry.listen_seconds || 0;
      // Payment-eligible songs bill at USD_PER_SEC; CC/ineligible accrue $0.
      const accruedUsd = isPaymentEligible(song) ? seconds * USD_PER_SEC : 0;
      const platformUsd = accruedUsd * (platformCut / 100);
      return {
        song_id: song.id,
        title: song.title,
        artist: song.artist,
        plays: entry.plays || 0,
        listen_seconds: Math.round(seconds),
        listeners: Object.keys(entry.listeners || {}).length,
        owner: song.owner || null,
        accrued_usd: +accruedUsd.toFixed(4),
        platform_usd: +platformUsd.toFixed(4),
        artist_usd: +(accruedUsd - platformUsd).toFixed(4),
        payment_eligible: isPaymentEligible(song),
      };
    }).sort((a, b) => b.plays - a.plays);
    const totals = songs.reduce((acc, s) => {
      acc.plays += s.plays;
      acc.listen_seconds += s.listen_seconds;
      acc.listeners += s.listeners;
      acc.accrued_usd = +(acc.accrued_usd + s.accrued_usd).toFixed(4);
      acc.platform_usd = +(acc.platform_usd + s.platform_usd).toFixed(4);
      acc.artist_usd = +(acc.artist_usd + s.artist_usd).toFixed(4);
      acc.payment_eligible = acc.payment_eligible || s.payment_eligible;
      return acc;
    }, { plays: 0, listen_seconds: 0, listeners: 0, accrued_usd: 0, platform_usd: 0, artist_usd: 0, payment_eligible: false });
    // Whole-player time-series: the admin trend over all songs. ?period=
    // day|week|month buckets the same buildMetricBuckets the artist graph
    // uses, but across the entire catalog (no owner filter).
    const series = buildMetricBuckets(m.days, new Set(SONGS.map((s) => s.id)), (url.searchParams.get("period") || "day"), m);
    return send(res, 200, { totals, songs, series });
  }

  // Artist: time-series metrics for the dashboard graph.
  // ?period=day|week|month  — bucket the series accordingly.
  // Returns per-bucket { label, plays, listen_seconds, new_listeners,
  // returning_listeners } plus top songs with totals + new/returning split.
  if (p === "/api/metrics/artist/range") {
    const header = req.headers["authorization"] || "";
    const match = header.match(/^Bearer\s+(\S+)$/i);
    const actor = match ? auth.verifyToken(match[1]) : null;
    if (!actor) return send(res, 401, { error: "wallet login required" });
    const period = ["day", "week", "month"].includes(url.searchParams.get("period") || "")
      ? url.searchParams.get("period")
      : "week";
    const m = loadMetrics();
    const owned = SONGS.filter((song) => song.owner === actor || (song.submitted_by && song.submitted_by === actor));
    const ownedIds = new Set(owned.map((s) => s.id));
    const days = m.days || {};

    // Bucket boundaries: day → 14 daily buckets; week → 8 weekly buckets;
    // month → 6 monthly buckets. Labels are the bucket's start date.
    const buckets = buildMetricBuckets(days, ownedIds, period, m);

    // Top songs over the same window: total listens + unique + new/returning.
    const rangeStart = buckets[0] ? buckets[0].label : dayKey();
    const songs = owned.map((song) => {
      const stat = songStatsInRange(m, song.id, rangeStart, buckets[buckets.length - 1].label);
      return {
        song_id: song.id,
        title: song.title,
        plays: stat.plays,
        listen_seconds: Math.round(stat.listen_seconds),
        unique_listeners: stat.unique,
        new_listeners: stat.newListeners,
        returning_listeners: stat.returning,
        // USD is the source of truth now: seconds × the global USD rate.
        // (Was seconds × the XPR *token* rate, which labelled a token amount USD.)
        accrued_usd: +((isPaymentEligible(song) ? stat.listen_seconds * USD_PER_SEC : 0)).toFixed(4),
      };
    }).sort((a, b) => b.listen_seconds - a.listen_seconds || b.plays - a.plays);

    const totals = songs.reduce((acc, s) => {
      acc.plays += s.plays;
      acc.listen_seconds += s.listen_seconds;
      acc.new_listeners += s.new_listeners;
      acc.returning_listeners += s.returning_listeners;
      acc.unique_listeners += s.unique_listeners;
      acc.accrued_usd = +(acc.accrued_usd + s.accrued_usd).toFixed(4);
      return acc;
    }, { plays: 0, listen_seconds: 0, new_listeners: 0, returning_listeners: 0, unique_listeners: 0, accrued_usd: 0 });

    return send(res, 200, { actor, period, series: buckets, totals, songs });
  }

  // PUBLIC per-song stats. The now-playing artist panel could only fill these
  // in when you were the artist yourself (song.owner === your actor), so every
  // listener saw "—" plays and "$0" accrued on somebody else's track. Streaming
  // payouts are the whole premise here; what a track has earned should be
  // visible to the person paying it. No auth, no listener identities exposed —
  // only counts and the USD total.
  const songStatsRoute = p.match(/^\/api\/metrics\/song\/([A-Za-z0-9_-]{1,64})$/);
  if (songStatsRoute && req.method === "GET") {
    const song = SONGS.find((s) => s.id === songStatsRoute[1]);
    if (!song) return send(res, 404, { error: "song not found" });
    const m = loadMetrics();
    const entry = m.songs[song.id] || { plays: 0, listen_seconds: 0, listeners: {} };
    const seconds = entry.listen_seconds || 0;
    return send(res, 200, {
      song_id: song.id,
      artist: song.artist || "",
      plays: entry.plays || 0,
      listen_seconds: Math.round(seconds),
      listeners: Object.keys(entry.listeners || {}).length,
      accrued_usd: +((isPaymentEligible(song) ? seconds * USD_PER_SEC : 0)).toFixed(4),
      payment_eligible: isPaymentEligible(song),
    });
  }

  // PUBLIC per-artist totals — powers the "see artist" surfaces.
  const artistStatsRoute = p.match(/^\/api\/metrics\/artist-public\/(.+)$/);
  if (artistStatsRoute && req.method === "GET") {
    const name = decodeURIComponent(artistStatsRoute[1]);
    const owned = SONGS.filter((s) => (s.artist || "") === name);
    if (!owned.length) return send(res, 404, { error: "artist not found" });
    const m = loadMetrics();
    let plays = 0, seconds = 0, accrued = 0;
    const listeners = new Set();
    owned.forEach((song) => {
      const e = m.songs[song.id] || { plays: 0, listen_seconds: 0, listeners: {} };
      plays += e.plays || 0;
      seconds += e.listen_seconds || 0;
      Object.keys(e.listeners || {}).forEach((l) => listeners.add(l));
      if (isPaymentEligible(song)) accrued += (e.listen_seconds || 0) * USD_PER_SEC;
    });
    const owner = (owned.find((s) => s.owner) || {}).owner || "";
    const profile = owner ? artistProfile(owner) : null;
    // Per-song play counts (public — no listener identity) so the artist page
    // can sort tracks most → least played.
    const songList = owned.map((song) => {
      const e = m.songs[song.id] || { plays: 0, listen_seconds: 0 };
      return { song_id: song.id, title: song.title, plays: e.plays || 0, listen_seconds: Math.round(e.listen_seconds || 0) };
    }).sort((a, b) => b.plays - a.plays);
    return send(res, 200, {
      artist: name,
      songs: owned.length,
      song_list: songList,
      plays,
      listen_seconds: Math.round(seconds),
      listeners: listeners.size,
      accrued_usd: +accrued.toFixed(4),
      // What is owed and where it would go. payments_enabled is still false —
      // this is the accrual ledger, not a claim that anything has been paid.
      payout_account: profile ? profile.payout_account : "",
      settled: false,
    });
  }

  // Artist: metrics for songs this wallet owns (submitted + approved).
  if (p === "/api/metrics/artist") {
    const header = req.headers["authorization"] || "";
    const match = header.match(/^Bearer\s+(\S+)$/i);
    const actor = match ? auth.verifyToken(match[1]) : null;
    if (!actor) return send(res, 401, { error: "wallet login required" });
    const m = loadMetrics();
    const owned = SONGS.filter((song) => song.owner === actor || (song.submitted_by && song.submitted_by === actor));
    const songs = owned.map((song) => {
      const entry = m.songs[song.id] || { plays: 0, listen_seconds: 0, listeners: {} };
      const seconds = entry.listen_seconds || 0;
      return {
        song_id: song.id,
        title: song.title,
        plays: entry.plays || 0,
        listen_seconds: Math.round(seconds),
        listeners: Object.keys(entry.listeners || {}).length,
        accrued_usd: +((isPaymentEligible(song) ? seconds * USD_PER_SEC : 0)).toFixed(4),
      };
    }).sort((a, b) => b.plays - a.plays);
    const totals = songs.reduce((acc, s) => {
      acc.plays += s.plays;
      acc.listen_seconds += s.listen_seconds;
      acc.listeners += s.listeners;
      return acc;
    }, { plays: 0, listen_seconds: 0, listeners: 0 });
    // Accrued spend across this artist's songs at the global USD rate —
    // testnet simulates per-second accrual; mainnet would sum real payouts.
    let accruedUsd = 0;
    for (const song of owned) {
      if (!isPaymentEligible(song)) continue;
      const entry = m.songs[song.id] || { listen_seconds: 0 };
      accruedUsd += (entry.listen_seconds || 0) * USD_PER_SEC;
    }
    totals.accrued_usd = +accruedUsd.toFixed(4);
    return send(res, 200, { actor, totals, songs });
  }

  if (p === "/api/submissions" && req.method === "GET") {
    if (req.headers["x-admin-pin"] !== ADMIN_PIN) return send(res, 401, { error: "admin pin required" });
    const status = (url.searchParams.get("status") || "").trim();
    let list = loadSubmissions();
    if (status) list = list.filter((s) => s.status === status);
    return send(res, 200, { submissions: list });
  }

  const submissionRoute = p.match(/^\/api\/submissions\/([0-9a-f-]{36})\/(approve|reject)$/i);
  if (submissionRoute && req.method === "POST") {
    if (req.headers["x-admin-pin"] !== ADMIN_PIN) return send(res, 401, { error: "admin pin required" });
    const submissions = loadSubmissions();
    const index = submissions.findIndex((s) => s.id === submissionRoute[1]);
    if (index < 0) return send(res, 404, { error: "submission not found" });
    const sub = submissions[index];
    if (submissionRoute[2] === "reject") {
      sub.status = "rejected";
      saveSubmissions(submissions);
      return send(res, 200, { ok: true, status: "rejected" });
    }
    const base = sub.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40) || "song";
    const albums = loadAlbums();
    const album = sub.album_id ? albums.find((a) => a.id === sub.album_id) : null;
    const song = {
      id: `${base}-${crypto.randomUUID().slice(0, 6)}`,
      title: sub.title,
      artist: sub.artist,
      collection: "Music Originals",
      category: sub.category,
      payment_eligible: true,
      duration_s: 180,
      file: sub.file,
      color: sub.color,
      minted: false,
      rates: { xpr: 0.002, usdc: 0.0013, loan: 0.072, metal: 0.0009 },
      cover: sub.cover || "",
      video: sub.video || "",
      artist_photo: sub.cover || "",
      artist_bio: sub.bio || "",
      album_id: sub.album_id || "",
      album_name: album ? album.name : "",
      owner: sub.submitted_by || "unknown",
    };
    SONGS.push(song);
    fs.writeFileSync(path.join(ROOT, "catalog/songs.json"), `${JSON.stringify(SONGS, null, 2)}\n`);
    sub.status = "approved";
    saveSubmissions(submissions);
    return send(res, 200, { ok: true, song });
  }

  // Admin: remove a song from the catalog.
  // ── streaming rate (admin only) ────────────────────────────────────
  // The $/second each payment-eligible song bills. Persisted so it survives
  // restarts; the meter is retuned live so billing + accrual never drift.
  if (p === "/api/admin/rate" && req.method === "GET") {
    if (req.headers["x-admin-pin"] !== ADMIN_PIN) return send(res, 401, { error: "admin pin required" });
    return send(res, 200, { usd_per_sec: USD_PER_SEC });
  }
  if (p === "/api/admin/rate" && req.method === "PUT") {
    if (req.headers["x-admin-pin"] !== ADMIN_PIN) return send(res, 401, { error: "admin pin required" });
    const body = await readBody(req);
    const v = Number(body.usd_per_sec);
    if (!Number.isFinite(v) || v <= 0 || v >= 1) return send(res, 400, { error: "rate must be > 0 and < $1/sec" });
    persistRate(v);
    return send(res, 200, { usd_per_sec: USD_PER_SEC });
  }

  // ── payment splits ──────────────────────────────────────────────────
  // Platform-level defaults (admin only)
  if (p === "/api/admin/splits/defaults" && req.method === "GET") {
    if (req.headers["x-admin-pin"] !== ADMIN_PIN) return send(res, 401, { error: "admin pin required" });
    let defaults = {};
    try { defaults = JSON.parse(fs.readFileSync(path.join(ROOT, "catalog/split-defaults.json"), "utf8")); } catch {}
    return send(res, 200, defaults);
  }
  if (p === "/api/admin/splits/defaults" && req.method === "PUT") {
    if (req.headers["x-admin-pin"] !== ADMIN_PIN) return send(res, 401, { error: "admin pin required" });
    const body = await readBody(req);
    const platformCutPct = Math.min(100, Math.max(0, Number(body.platform_cut_pct) || 0));
    const enabled = Boolean(body.enabled);
    const defaults = { platform_cut_pct: platformCutPct, enabled };
    fs.writeFileSync(path.join(ROOT, "catalog/split-defaults.json"), JSON.stringify(defaults, null, 2));
    return send(res, 200, defaults);
  }

  // Per-song splits (artist or admin)
  const splitsRoute = p.match(/^\/api\/songs\/([a-z0-9-]+)\/splits$/i);
  if (splitsRoute && req.method === "GET") {
    const song = SONGS.find((s) => s.id === splitsRoute[1]);
    if (!song) return send(res, 404, { error: "song not found" });
    return send(res, 200, { splits: song.splits || [], platform_defaults_path: "/api/admin/splits/defaults" });
  }
  if (splitsRoute && req.method === "PUT") {
    const body = await readBody(req);
    // Identity: verified wallet token or admin PIN. Never a client-supplied
    // body field — owner names are public via /api/catalog.
    const authHeader = req.headers["authorization"] || "";
    const authMatch = authHeader.match(/^Bearer\s+(\S+)$/i);
    const actor = authMatch ? auth.verifyToken(authMatch[1]) : null;
    const isAdmin = req.headers["x-admin-pin"] === ADMIN_PIN;
    if (!actor && !isAdmin) return send(res, 401, { error: "wallet login required" });
    const songIdx = SONGS.findIndex((s) => s.id === splitsRoute[1]);
    if (songIdx < 0) return send(res, 404, { error: "song not found" });
    const song = SONGS[songIdx];
    // Owner can set their own splits; admin can set anyone's
    if (!isAdmin && song.owner !== actor && !grantAccessFor(actor, song.owner || "").write) {
      return send(res, 403, { error: "not authorized to edit this song's splits" });
    }
    const splits = Array.isArray(body.splits) ? body.splits : [];
    const totalPct = splits.reduce((sum, s) => sum + (Number(s.pct) || 0), 0);
    if (totalPct > 100) return send(res, 400, { error: "splits exceed 100%" });
    for (const sp of splits) {
      if (!sp.wallet || typeof sp.wallet !== "string") return send(res, 400, { error: "each split needs a wallet" });
      if (!Number(sp.pct) || Number(sp.pct) <= 0) return send(res, 400, { error: "each split needs a positive pct" });
    }
    song.splits = splits.map((sp) => ({ wallet: sp.wallet.trim().toLowerCase(), pct: Number(sp.pct) }));
    fs.writeFileSync(path.join(ROOT, "catalog/songs.json"), `${JSON.stringify(SONGS, null, 2)}\n`);
    return send(res, 200, { splits: song.splits, total_pct: totalPct });
  }

  // Artist (or admin) removes one of their own songs.
  if (p === "/api/songs/remove" && req.method === "POST") {
    const header = req.headers["authorization"] || "";
    const m = header.match(/^Bearer\s+(\S+)$/i);
    const actor = m ? auth.verifyToken(m[1]) : null;
    const isAdmin = req.headers["x-admin-pin"] === ADMIN_PIN;
    if (!actor && !isAdmin) return send(res, 401, { error: "wallet login required" });
    const body = await readBody(req);
    const id = typeof body.song_id === "string" ? body.song_id : "";
    const idx = SONGS.findIndex((s) => s.id === id);
    if (idx < 0) return send(res, 404, { error: "song not found" });
    if (!isAdmin && SONGS[idx].owner !== actor) return send(res, 403, { error: "not your song" });
    SONGS.splice(idx, 1);
    fs.writeFileSync(path.join(ROOT, "catalog/songs.json"), `${JSON.stringify(SONGS, null, 2)}\n`);
    return send(res, 200, { ok: true });
  }

  if (p === "/api/admin/songs/remove" && req.method === "POST") {
    if (req.headers["x-admin-pin"] !== ADMIN_PIN) return send(res, 401, { error: "admin pin required" });
    const body = await readBody(req);
    const id = typeof body.song_id === "string" ? body.song_id : "";
    const idx = SONGS.findIndex((s) => s.id === id);
    if (idx < 0) return send(res, 404, { error: "song not found" });
    SONGS.splice(idx, 1);
    fs.writeFileSync(path.join(ROOT, "catalog/songs.json"), `${JSON.stringify(SONGS, null, 2)}\n`);
    return send(res, 200, { ok: true });
  }

  // static: views + media
  // Root routes by User-Agent: phones get mobile.html, everything else gets
  // desktop.html. Explicit paths override: /desktop, /mobile, /now-playing.
  if (p === "/admin") return serveStatic(res, req, "web/admin.html");
  if (p === "/" || p === "/desktop" || p === "/mobile" || p === "/now-playing") {
    const ua = (req.headers["user-agent"] || "").toLowerCase();
    const isMobileUA = /mobile|android|iphone|ipad|ipod/i.test(ua);
    if (p === "/mobile" || p === "/now-playing") return serveStatic(res, req, "web/mobile.html");
    if (p === "/desktop") return serveStatic(res, req, "web/desktop.html");
    return serveStatic(res, req, isMobileUA ? "web/mobile.html" : "web/desktop.html");
  }
  if (p.startsWith("/media/")) return serveStatic(res, req, p.slice(1));
  if (p.startsWith("/web/")) return serveStatic(res, req, p.slice(1));

  send(res, 404, { error: "not found" });
});

// Q3 (audit): an unguarded async throw in the router previously took the whole
// process down mid-ledger-write. Log loudly, then exit — state files are only
// ever written synchronously, so a clean exit here is consistent. Restart
// supervision is the operator's (launchd/pm2) responsibility.
process.on("uncaughtException", (err) => {
  console.error("[fatal] uncaughtException:", err);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error("[fatal] unhandledRejection:", reason);
  process.exit(1);
});

setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW_MS * 2;
  for (const [k, b] of rateBuckets) if (b.lastRefill < cutoff) rateBuckets.delete(k);
}, RATE_WINDOW_MS).unref();

server.listen(PORT, () => {
  console.log(`🎵 XPR Music backend on http://127.0.0.1:${PORT}  (desktop: / · mobile: /mobile)`);
  ondaPulse.start(() => {
    const live = [];
    for (const sess of sessions.values()) {
      if (sess.playing && sess.actor && sess.songId) live.push({ actor: sess.actor, songId: sess.songId });
    }
    return live;
  }, (actor, reason) => {
    // A slice could not be paid. Never keep streaming audio nobody paid for.
    for (const sess of sessions.values()) {
      if (sess.actor === actor && sess.playing) {
        sess.playing = false;
        sess.payment_error = reason;
      }
    }
    console.warn("onda payment stopped playback:", actor, reason);
  });
  // Keeps every token charging the same value per second as prices move.
  // Stays off unless ONDA_PRICER_* is set — and that key must be scoped to
  // ondastream::settokrate only, never a key that can `setcode`.
  ondaPricing.start();
});
