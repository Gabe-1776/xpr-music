import {
  Contract,
  Table,
  TableStore,
  Singleton,
  Name,
  Asset,
  Symbol,
  check,
  requireAuth,
  isAccount,
  currentTimeSec,
  InlineAction,
  PermissionLevel,
  ExtendedSymbol,
} from "proton-tsc";
import { Transfer } from "proton-tsc/token/token.inline";

/**
 * ondastream — custom music stream vest (TESTNET).
 *
 * Pay modes (Gabriel 2026-08-23):
 * - Wallet-direct: transfer memo s:<songId> locks a buffer (ONE Face-ID).
 * - On-chain top-up: memo onda parks; startstream pulls a lock (ONE Face-ID).
 * - Streaming: keeper `pulse` every windowSec (2s) inline-transfers that
 *   slice to the current song's payout — visible in the wallet. Pause/skip
 *   do not Face-ID; leftover rebates via `expire` (keeper) / `stopstream`.
 * Rate is catalog (rates singleton), not deposit/window. No f64.
 *
 * Do not reshape config/streams/songs/claimed — new tables only.
 */

const DEFAULT_WINDOW: u32 = 2;
const MAX_BUFFER: u32 = 180;
// Bound how long a standing pull permission can live without re-consent.
const MAX_GRANT_SECONDS: u32 = 15552000; // 180 days
// Headroom over the rate prevailing when money was deposited. Whoever can call
// `settokrate` could otherwise inflate a rate and drain deposits at speed; this
// bounds a top-up the same way `maxPerTick` bounds a grant. 8x leaves room for
// honest price moves before a stream is interrupted.
const CAP_MULTIPLIER: u64 = 8;
// Most seconds one pullbal may bill. The keeper's 2s tick is dropped whenever a
// send overruns it (contended RPC budget), so a pull can legitimately land ~20s
// after the last one; without catch-up the artist is paid for 2s of the 20 and
// silently loses the rest. Catch-up is bounded because a leaked keeper key can
// call pullbal at will: this is the per-call exposure. The HOURLY ceiling is
// unchanged -- `billable <= now - lastPull` telescopes, so no more than ~3600s
// can be billed per hour however often the action is called.
//
// The cap interaction is a KNIFE EDGE, not headroom: a deposit's `maxPerTick`
// is stamped as `rate_at_deposit * windowSec * CAP_MULTIPLIER` = 16 * rate_dep,
// while a full catch-up costs 16 * rate_now. Equal only while the rate has not
// moved -- so ANY upward reprice makes a full catch-up breach the cap, and
// because a failed pull does not clear the debt the resulting stall is sticky.
// What keeps that safe is the KEEPER: capAdmits() in onda-pulse.js clamps
// playedSec to what the stamped cap admits, leaving `tick over cap` to mean
// what it was designed to mean -- a genuinely stale cap. Raising this constant
// without raising CAP_MULTIPLIER does not widen catch-up; it only moves where
// the keeper must clamp.
const MAX_CATCHUP_SEC: u32 = 16;
const DEFAULT_BUFFER: u32 = 30;
const MAX_SONG_ID: i32 = 64;
// Q1 (audit): claims scan claimed primaries; every visited row burns WASM CPU
// billed to the withdrawing artist. Primaries are tokenKey hashes (uniform),
// so any fixed window samples all artists fairly; repeated claims terminate.
const CLAIM_SCAN_LIMIT: u32 = 256;
const MEMO_SONG: string = "s:";
const MEMO_PARK: string = "onda";
const SOURCE_WALLET: u8 = 0;
const SOURCE_BALANCE: u8 = 1;

@table("config", singleton)
export class Config extends Table {
  constructor(
    public owner: Name = new Name(),
    public paused: bool = false,
    public windowSec: u32 = DEFAULT_WINDOW,
  ) {
    super();
  }
}

@table("rates", singleton)
export class Rates extends Table {
  constructor(
    public xprPerSec: u64 = 0,
    public xusdcPerSec: u64 = 0,
  ) {
    super();
  }
}

@table("ops", singleton)
export class Ops extends Table {
  constructor(
    public keeper: Name = new Name(),
  ) {
    super();
  }
}

@table("songs")
export class Song extends Table {
  constructor(
    public id: u64 = 0,
    public songId: string = "",
    public artist: Name = new Name(),
    public payout: Name = new Name(),
    public active: bool = true,
  ) {
    super();
  }

  @primary
  get primary(): u64 {
    return this.id;
  }
}

@table("streams")
export class Stream extends Table {
  constructor(
    public listener: Name = new Name(),
    public songHash: u64 = 0,
    public songId: string = "",
    public payout: Name = new Name(),
    public tokenContract: Name = new Name(),
    public remaining: u64 = 0,
    public vestPerSec: u64 = 0,
    public lastVest: u32 = 0,
    public opened: u32 = 0,
    public symRaw: u64 = 0,
  ) {
    super();
  }

  @primary
  get primary(): u64 {
    return this.listener.N;
  }
}

@table("locks")
export class Lock extends Table {
  constructor(
    public listener: Name = new Name(),
    public songHash: u64 = 0,
    public songId: string = "",
    public payout: Name = new Name(),
    public tokenContract: Name = new Name(),
    public remaining: u64 = 0,
    public vestPerSec: u64 = 0,
    public lastVest: u32 = 0,
    public opened: u32 = 0,
    public symRaw: u64 = 0,
    public source: u8 = SOURCE_WALLET,
  ) {
    super();
  }

  @primary
  get primary(): u64 {
    return this.listener.N;
  }
}

@table("balances")
export class Balance extends Table {
  constructor(
    public id: u64 = 0,
    public account: Name = new Name(),
    public tokenContract: Name = new Name(),
    public amount: u64 = 0,
    public symRaw: u64 = 0,
    public maxPerTick: u64 = 0,
  ) {
    super();
  }

  @primary
  get primary(): u64 {
    return this.id;
  }

  @secondary
  get byAccount(): u64 {
    return this.account.N;
  }
  set byAccount(value: u64) {
    this.account = Name.fromU64(value);
  }
}

@table("claimed")
export class Claimed extends Table {
  constructor(
    public id: u64 = 0,
    public account: Name = new Name(),
    public tokenContract: Name = new Name(),
    public amount: u64 = 0,
    public symRaw: u64 = 0,
  ) {
    super();
  }

  @primary
  get primary(): u64 {
    return this.id;
  }

  @secondary
  get byAccount(): u64 {
    return this.account.N;
  }
  set byAccount(value: u64) {
    this.account = Name.fromU64(value);
  }
}

/**
 * A listener's standing permission to be pulled from directly (desktop
 * "pay from wallet"). The chain CANNOT express a spend limit: `linkauth`
 * scopes WHICH action may be signed, never an amount or a recipient. So the
 * only thing standing between this grant and the listener's whole balance is
 * the code below — maxPerTick and budget are enforced here or nowhere.
 */
@table("grants")
export class Grant extends Table {
  constructor(
    public listener: Name = new Name(),
    public perm: Name = new Name(),
    public tokenContract: Name = new Name(),
    public symRaw: u64 = 0,
    public maxPerTick: u64 = 0,
    public budget: u64 = 0,
    public spent: u64 = 0,
    public expiresAt: u32 = 0,
    public lastPull: u32 = 0,
  ) {
    super();
  }

  @primary
  get primary(): u64 {
    return this.listener.N;
  }
}

/**
 * Fuse state for top-up streaming. The deposit itself is the consent and the
 * only cap, so there is no lock and no buffer — this row exists purely to keep
 * the keeper honest about the windowSec cadence.
 */
@table("tokrates")
export class TokRate extends Table {
  constructor(
    public id: u64 = 0,
    public tokenContract: Name = new Name(),
    public symRaw: u64 = 0,
    public perSec: u64 = 0,
    public enabled: bool = true,
  ) {
    super();
  }

  @primary
  get primary(): u64 {
    return this.id;
  }
}

@table("pulls")
export class Pull extends Table {
  constructor(
    public listener: Name = new Name(),
    public lastPull: u32 = 0,
  ) {
    super();
  }

  @primary
  get primary(): u64 {
    return this.listener.N;
  }
}

function fnv64(s: string): u64 {
  let h: u64 = 14695981039346656037;
  for (let i = 0; i < s.length; i++) {
    h ^= <u64>s.charCodeAt(i);
    h *= 1099511628211;
  }
  if (h == 0) h = 1;
  return h;
}

function tokenKey(account: Name, token: Name, symRaw: u64): u64 {
  let h: u64 = account.N;
  h ^= token.N + 0x9e3779b97f4a7c15;
  h ^= symRaw + 0x9e3779b97f4a7c15;
  if (h == 0) h = 1;
  return h;
}

function xprSym(): Symbol {
  return new Symbol("XPR", 4);
}
function xusdcSym(): Symbol {
  return new Symbol("XUSDC", 6);
}

// A symbol's raw u64 already encodes both precision and code, so a stored raw
// round-trips back to a real Symbol — no per-token hardcoding.
function symFromRaw(raw: u64): Symbol {
  const s = new Symbol();
  s.value = raw;
  return s;
}

function rateKey(token: Name, symRaw: u64): u64 {
  let h: u64 = token.N;
  h ^= symRaw + 0x9e3779b97f4a7c15;
  if (h == 0) h = 1;
  return h;
}

@contract
export class OndaStream extends Contract {
  config: Singleton<Config> = new Singleton<Config>(this.receiver);
  rates: Singleton<Rates> = new Singleton<Rates>(this.receiver);
  ops: Singleton<Ops> = new Singleton<Ops>(this.receiver);
  songs: TableStore<Song> = new TableStore<Song>(this.receiver);
  streams: TableStore<Stream> = new TableStore<Stream>(this.receiver);
  locks: TableStore<Lock> = new TableStore<Lock>(this.receiver);
  balances: TableStore<Balance> = new TableStore<Balance>(this.receiver);
  claimed: TableStore<Claimed> = new TableStore<Claimed>(this.receiver);
  grants: TableStore<Grant> = new TableStore<Grant>(this.receiver);
  pulls: TableStore<Pull> = new TableStore<Pull>(this.receiver);
  tokrates: TableStore<TokRate> = new TableStore<TokRate>(this.receiver);

  @action("init")
  init(owner: Name): void {
    requireAuth(this.receiver);
    const existing = this.config.getOrNull();
    check(existing == null, "already initialized");
    check(isAccount(owner), "owner account missing");
    this.config.set(new Config(owner, false, DEFAULT_WINDOW), this.receiver);
  }

  @action("setpaused")
  setpaused(paused: bool): void {
    const cfg = this.requireConfig();
    requireAuth(cfg.owner);
    cfg.paused = paused;
    this.config.set(cfg, this.receiver);
  }

  /**
   * Repoint admin authority to a separate account. This is what makes FREEZING
   * the contract possible: every admin action authorizes against `cfg.owner`,
   * never `this.receiver`, so once owner lives on its own account the contract
   * account's keys can be destroyed — code becomes immutable and the pull grant
   * becomes trustless, while rate/window/keeper/pause stay tunable.
   * Irreversible from this side: only the NEW owner can call this again.
   */
  @action("setowner")
  setowner(owner: Name): void {
    const cfg = this.requireConfig();
    requireAuth(cfg.owner);
    check(isAccount(owner), "owner account missing");
    check(owner != cfg.owner, "owner unchanged");
    cfg.owner = owner;
    this.config.set(cfg, this.receiver);
  }

  /**
   * Add, reprice, or disable a payable token. Contract + symbol together are
   * the identity. perSec is in the token's own raw integer units.
   */
  @action("settokrate")
  settokrate(token: Name, sym: Symbol, perSec: u64, enabled: bool): void {
    const cfg = this.requireConfig();
    requireAuth(cfg.owner);
    check(isAccount(token), "token contract missing");
    check(sym.isValid(), "invalid symbol");
    const symRaw = sym.raw();
    const id = rateKey(token, symRaw);
    const existing = this.tokrates.get(id);
    // Same discipline as setsong(): a rateKey hash collision must never
    // silently repoint another (contract,symbol) pair's rate.
    if (existing != null) {
      check(existing.tokenContract == token && existing.symRaw == symRaw, "rate hash collision");
    }
    const row = new TokRate(id, token, symRaw, perSec, enabled);
    if (existing == null) this.tokrates.store(row, this.receiver);
    else this.tokrates.update(row, this.receiver);
  }

  @action("setwindow")
  setwindow(windowSec: u32): void {
    const cfg = this.requireConfig();
    requireAuth(cfg.owner);
    check(windowSec >= 1 && windowSec <= 30, "window 1-30s");
    cfg.windowSec = windowSec;
    this.config.set(cfg, this.receiver);
  }

  @action("setrate")
  setrate(xprPerSec: u64, xusdcPerSec: u64): void {
    const cfg = this.requireConfig();
    requireAuth(cfg.owner);
    check(xprPerSec > 0, "xpr rate 0");
    check(xusdcPerSec > 0, "xusdc rate 0");
    this.rates.set(new Rates(xprPerSec, xusdcPerSec), this.receiver);
  }

  @action("setkeeper")
  setkeeper(keeper: Name): void {
    const cfg = this.requireConfig();
    requireAuth(cfg.owner);
    check(isAccount(keeper), "keeper account missing");
    this.ops.set(new Ops(keeper), this.receiver);
  }

  @action("setsong")
  setsong(artist: Name, songId: string, payout: Name): void {
    requireAuth(artist);
    this.requireConfig();
    check(songId.length > 0 && songId.length <= MAX_SONG_ID, "bad song_id");
    check(isAccount(payout), "payout account missing");
    const id = fnv64(songId);
    let row = this.songs.get(id);
    if (row == null) {
      row = new Song(id, songId, artist, payout, true);
      this.songs.store(row, artist);
      return;
    }
    check(row.songId == songId, "song hash collision");
    check(row.artist == artist, "not song artist");
    row.payout = payout;
    row.active = true;
    this.songs.update(row, artist);
  }

  @action("pausesong")
  pausesong(artist: Name, songId: string): void {
    requireAuth(artist);
    const row = this.requireSong(songId);
    check(row.artist == artist, "not song artist");
    row.active = false;
    this.songs.update(row, artist);
  }

  @action("settle")
  settle(listener: Name): void {
    const lock = this.locks.get(listener.N);
    if (lock != null) {
      this.accrueLock(lock, false);
      return;
    }
    const row = this.streams.get(listener.N);
    if (row == null) return;
    this.accrueLegacy(row, false);
  }

  @action("stopstream")
  stopstream(listener: Name): void {
    requireAuth(listener);
    const lock = this.locks.get(listener.N);
    if (lock != null) {
      this.rebateOnly(lock);
      return;
    }
    const row = this.streams.get(listener.N);
    check(row != null, "no open stream");
    this.accrueLegacy(row!, true);
  }

  // Keeper: one fuse (2s) slice as a real transfer to the song's payout.
  // Not wall-clock catch-up — pause stops pulses, so paused time is free.
  @action("pulse")
  pulse(listener: Name, songId: string): void {
    const ops = this.ops.getOrNull();
    check(ops != null && ops.keeper.N != 0, "keeper unset");
    requireAuth(ops!.keeper);
    const cfg = this.requireConfig();
    check(!cfg.paused, "paused");
    const lock = this.locks.get(listener.N);
    check(lock != null, "no open stream");
    const now = <u32>currentTimeSec();
    check(now >= lock!.lastVest + cfg.windowSec, "fuse");
    const song = this.requireSong(songId);
    check(song.active, "song not active");
    let due: u64 = lock!.vestPerSec * <u64>cfg.windowSec;
    if (due > lock!.remaining) due = lock!.remaining;
    lock!.remaining -= due;
    lock!.lastVest = now;
    lock!.songHash = song.id;
    lock!.songId = song.songId;
    lock!.payout = song.payout;
    if (due > 0) {
      this.sendToken(lock!.tokenContract, song.payout, due, lock!.symRaw, "s:" + song.songId);
    }
    if (lock!.remaining == 0) {
      this.locks.remove(lock!);
    } else {
      this.locks.update(lock!, this.receiver);
    }
  }

  /**
   * Keeper: stream one window out of the listener's topped-up balance.
   * This is the DEFAULT consumer path — prepaid credits, no lock, no buffer,
   * no re-sign. The deposit (transfer with memo `onda`) is the only signature
   * until the credits run out.
   */
  /**
   * `playedSec` is how many seconds of ACTUAL playback the keeper is claiming
   * since the last pull. The contract cannot derive it -- only the server knows
   * whether the listener was playing or paused -- so it is supplied, and then
   * clamped three ways so supplying it is not a licence to over-bill:
   *   - never more than the wall clock has advanced since `lastPull`
   *   - never more than MAX_CATCHUP_SEC in one call
   *   - never less than one window (dust pulls are refused outright)
   * A keeper that under-reports only cheats itself; one that over-reports is
   * cut back to the clock.
   */
  @action("pullbal")
  pullbal(listener: Name, songId: string, token: ExtendedSymbol, playedSec: u32): void {
    const ops = this.ops.getOrNull();
    check(ops != null && ops.keeper.N != 0, "keeper unset");
    requireAuth(ops!.keeper);
    const cfg = this.requireConfig();
    check(!cfg.paused, "paused");

    const symRaw = token.sym.raw();
    const rate = this.requireRate(token.contract, symRaw);

    const now = <u32>currentTimeSec();
    const p = this.pulls.get(listener.N);
    let billable: u32 = playedSec;
    if (p != null) {
      check(now >= p.lastPull + cfg.windowSec, "fuse");
      // The clock is the ceiling: whatever the keeper claims, it can never bill
      // for more time than has actually passed since it last pulled.
      const wall: u32 = now - p.lastPull;
      if (billable > wall) billable = wall;
    }
    if (billable > MAX_CATCHUP_SEC) billable = MAX_CATCHUP_SEC;
    check(billable >= cfg.windowSec, "below window");

    const song = this.requireSong(songId);
    check(song.active, "song not active");

    const due: u64 = rate * <u64>billable;
    check(due > 0, "zero due");
    // A deposit is only exposed to the rate it was made under (plus headroom).
    // Fail loudly rather than treating an unset cap as "unlimited" — a silent
    // 0 would be exactly the hole this exists to close.
    const bal = this.balances.get(tokenKey(listener, token.contract, symRaw));
    check(bal != null, "no onda balance");
    check(bal!.maxPerTick > 0, "cap unset");
    check(due <= bal!.maxPerTick, "tick over cap");
    this.debitBalance(listener, token.contract, symRaw, due);

    if (p == null) this.pulls.store(new Pull(listener, now), this.receiver);
    else {
      p.lastPull = now;
      this.pulls.update(p, this.receiver);
    }

    this.sendToken(token.contract, song.payout, due, symRaw, "s:" + song.songId);
  }

  /**
   * Record a listener's standing pull permission. The listener must ALSO have
   * signed `eosio::updateauth` + `eosio::linkauth` creating `perm` with this
   * contract's @eosio.code as its authority, scoped to the token's `transfer`
   * — normally bundled with this action in one transaction so it is atomic.
   *
   * A fresh grant is fresh consent: the budget restarts rather than stacking.
   */
  @action("grant")
  grant(listener: Name, perm: Name, token: ExtendedSymbol, maxPerTick: u64, budget: u64, expiresAt: u32): void {
    requireAuth(listener);
    this.requireConfig();
    check(perm.N != 0, "perm required");
    // active/owner would hand over the whole account. The grant is only ever a
    // narrow child permission linked to transfer alone.
    check(perm != Name.fromString("active"), "perm must not be active");
    check(perm != Name.fromString("owner"), "perm must not be owner");
    const symRaw = token.sym.raw();
    check(this.rateOf(token.contract, symRaw) > 0, "token not payable");
    check(maxPerTick > 0, "maxPerTick 0");
    check(budget >= maxPerTick, "budget below one tick");
    const now = <u32>currentTimeSec();
    check(expiresAt > now, "already expired");
    check(expiresAt - now <= MAX_GRANT_SECONDS, "grant too long");

    const existing = this.grants.get(listener.N);
    const row = new Grant(listener, perm, token.contract, symRaw, maxPerTick, budget, 0, expiresAt, 0);
    if (existing == null) this.grants.store(row, this.receiver);
    else this.grants.update(row, this.receiver);
  }

  /**
   * Soft revoke. This stops OUR pulls immediately, but it is not the
   * cryptographic backstop — that is `unlinkauth`/`deleteauth` on the
   * listener's own account, which makes a pull fail with "irrelevant
   * authority" no matter what this table says. The UI must offer the real one.
   */
  @action("revoke")
  revoke(listener: Name): void {
    requireAuth(listener);
    const row = this.grants.get(listener.N);
    check(row != null, "no grant");
    this.grants.remove(row!);
  }

  /**
   * Keeper: pull one window straight from the listener's wallet. Same fuse and
   * cadence as `pulse`, but the money never sits in the contract — this is what
   * makes a real transfer show up in the listener's wallet every windowSec.
   */
  @action("pullpay")
  pullpay(listener: Name, songId: string): void {
    const ops = this.ops.getOrNull();
    check(ops != null && ops.keeper.N != 0, "keeper unset");
    requireAuth(ops!.keeper);
    const cfg = this.requireConfig();
    check(!cfg.paused, "paused");

    const g = this.grants.get(listener.N);
    check(g != null, "no grant");
    const now = <u32>currentTimeSec();
    check(now < g!.expiresAt, "grant expired");
    check(now >= g!.lastPull + cfg.windowSec, "fuse");

    const song = this.requireSong(songId);
    check(song.active, "song not active");

    const rate = this.requireRate(g!.tokenContract, g!.symRaw);
    let due: u64 = rate * <u64>cfg.windowSec;
    // Both caps are enforced HERE or nowhere — the permission itself has none.
    if (due > g!.maxPerTick) due = g!.maxPerTick;
    const left: u64 = g!.budget - g!.spent;
    if (due > left) due = left;
    check(due > 0, "budget exhausted");

    g!.spent += due;
    g!.lastPull = now;
    this.grants.update(g!, this.receiver);

    this.sendFrom(g!.tokenContract, listener, g!.perm, song.payout, due, g!.symRaw, "s:" + song.songId);
  }

  // Keeper: listener paused / tab died. Return leftover. Do NOT vest
  // paused time — pulses already paid the artist.
  @action("expire")
  expire(listener: Name): void {
    const ops = this.ops.getOrNull();
    check(ops != null && ops.keeper.N != 0, "keeper unset");
    requireAuth(ops!.keeper);
    const lock = this.locks.get(listener.N);
    if (lock == null) return;
    this.rebateOnly(lock);
  }

  // Skip / next track: vest-so-far stays with the old payout, leftover
  // remaining keeps streaming toward the new song. No new transfer — the
  // listener already Face-ID'd the lock. Empty lock → start a new one in the UI.
  @action("switchsong")
  switchsong(listener: Name, songId: string): void {
    requireAuth(listener);
    const lock = this.locks.get(listener.N);
    check(lock != null, "no open stream");
    const song = this.requireSong(songId);
    check(song.active, "song not active");
    this.accrueLock(lock!, false);
    check(lock!.remaining > 0, "lock empty");
    if (lock!.songId == song.songId) return;
    lock!.songHash = song.id;
    lock!.songId = song.songId;
    lock!.payout = song.payout;
    this.locks.update(lock!, this.receiver);
  }

  @action("startstream")
  startstream(listener: Name, songId: string, token: ExtendedSymbol, bufferSec: u32): void {
    requireAuth(listener);
    const cfg = this.requireConfig();
    check(!cfg.paused, "paused");
    let buf = bufferSec;
    if (buf == 0) buf = DEFAULT_BUFFER;
    check(buf >= cfg.windowSec && buf <= MAX_BUFFER, "buffer 2-180s");

    const song = this.requireSong(songId);
    check(song.active, "song not active");

    const symRaw = token.sym.raw();
    const rate = this.requireRate(token.contract, symRaw);
    const need: u64 = rate * <u64>buf;
    check(need > 0, "need 0");
    this.debitBalance(listener, token.contract, symRaw, need);

    this.closeOpen(listener, true);

    const now = <u32>currentTimeSec();
    const lock = new Lock(
      listener,
      song.id,
      song.songId,
      song.payout,
      token.contract,
      need,
      rate,
      now,
      now,
      symRaw,
      SOURCE_BALANCE,
    );
    this.locks.store(lock, this.receiver);
  }

  /**
   * Listener raises (or lowers) their own per-tick ceiling — the escape hatch
   * when an honest price move pushes a tick past the cap set at deposit time.
   */
  @action("setcap")
  setcap(listener: Name, token: ExtendedSymbol, maxPerTick: u64): void {
    requireAuth(listener);
    const symRaw = token.sym.raw();
    const row = this.balances.get(tokenKey(listener, token.contract, symRaw));
    check(row != null, "no onda balance");
    // 0 is not "no cap" here, it is "every pull fails `cap unset`" -- a listener
    // could silently brick their own stream and have no way to see why.
    check(maxPerTick > 0, "cap must be positive");
    row!.maxPerTick = maxPerTick;
    this.balances.update(row!, this.receiver);
  }

  @action("withdraw")
  withdraw(listener: Name, token: ExtendedSymbol): void {
    requireAuth(listener);
    const symRaw = token.sym.raw();
    const id = tokenKey(listener, token.contract, symRaw);
    const row = this.balances.get(id);
    check(row != null, "no balance");
    check(row!.amount > 0, "zero balance");
    const amount = row!.amount;
    this.balances.remove(row!);
    this.sendToken(token.contract, listener, amount, symRaw, "onda withdraw");
  }

  @action("claim")
  claim(account: Name): void {
    requireAuth(account);
    this.payoutClaimed(account);
  }

  @action("transfer", notify)
  onTransfer(from: Name, to: Name, quantity: Asset, memo: string): void {
    if (to != this.receiver) return;
    if (from == this.receiver) return;
    // Hardening (audit Q4): a DIRECT ondastream::transfer call should never be
    // treated as a token notification — real deposits arrive with
    // firstReceiver == eosio.token/xtokens. Belt alongside the rateOf gate.
    if (this.firstReceiver == this.receiver) return;

    const token = this.firstReceiver;
    if (quantity.amount <= 0) return;
    // The payability gate USED to live here as a bare `return`, which stranded
    // a deposit sent in an unpriced token exactly like the paused case above.
    // It now lives inside each memo branch as a `check`, so an intended deposit
    // of an unpayable token reverts and the sender keeps their money, while an
    // unrelated transfer (any other memo) is still ignored rather than blocked.

    if (memo == MEMO_PARK) {
      const cfg = this.config.getOrNull();
      // `return` here would let the transfer COMMIT while crediting nothing:
      // the tokens land in this contract with no `balances` row, and `withdraw`
      // reads only `balances`, so they are unrecoverable without a setcode.
      // Fail the whole transfer instead, the way the `s:` branch already does.
      check(cfg != null && !cfg!.paused, "deposits paused");
      const symRaw = quantity.symbol.raw();
      const rate = this.requireRate(token, symRaw);
      this.creditBalance(from, token, <u64>quantity.amount, symRaw);
      // The cap is set from the price when the money went in, so a later
      // repricing cannot outrun what the depositor effectively agreed to.
      this.bumpCap(from, token, symRaw, rate * <u64>cfg!.windowSec * CAP_MULTIPLIER);
      return;
    }

    if (!memo.startsWith(MEMO_SONG)) return;

    const cfg = this.requireConfig();
    check(!cfg.paused, "paused");

    const songId = memo.substring(MEMO_SONG.length);
    check(songId.length > 0 && songId.length <= MAX_SONG_ID, "bad song_id");
    const song = this.requireSong(songId);
    check(song.active, "song not active");

    const rate = this.requireRate(token, quantity.symbol.raw());
    const minLock = rate * <u64>cfg.windowSec;
    const maxLock = rate * <u64>MAX_BUFFER;
    check(<u64>quantity.amount >= minLock, "deposit smaller than window");
    check(<u64>quantity.amount <= maxLock, "deposit bigger than max buffer");

    this.closeOpen(from, true);

    const now = <u32>currentTimeSec();
    const lock = new Lock(
      from,
      song.id,
      song.songId,
      song.payout,
      token,
      <u64>quantity.amount,
      rate,
      now,
      now,
      quantity.symbol.raw(),
      SOURCE_WALLET,
    );
    this.locks.store(lock, this.receiver);
  }

  private requireConfig(): Config {
    const cfg = this.config.getOrNull();
    check(cfg != null, "not initialized");
    return cfg!;
  }

  private requireSong(songId: string): Song {
    const id = fnv64(songId);
    const row = this.songs.get(id);
    check(row != null, "unknown song");
    check(row!.songId == songId, "song hash collision");
    return row!;
  }

  /**
   * Per-second price for one (contract, symbol). 0 means the token is not
   * payable — one lookup replaces the old "is it accepted" + "what's the rate"
   * pair, so the two can never disagree. Contract alone is NOT enough to
   * identify a token: `xtokens` hosts both XUSDC and METAL.
   */
  private rateOf(token: Name, symRaw: u64): u64 {
    const row = this.tokrates.get(rateKey(token, symRaw));
    if (row == null || !row.enabled) return 0;
    return row.perSec;
  }

  private requireRate(token: Name, symRaw: u64): u64 {
    const rate = this.rateOf(token, symRaw);
    check(rate > 0, "token not payable");
    return rate;
  }

  private closeOpen(listener: Name, rebate: bool): void {
    const lock = this.locks.get(listener.N);
    if (lock != null) {
      // New lock replaces an old one: return leftover, do not vest paused time.
      if (rebate) this.rebateOnly(lock);
      else this.accrueLock(lock, false);
      return;
    }
    const legacy = this.streams.get(listener.N);
    if (legacy != null) this.accrueLegacy(legacy, rebate);
  }

  private rebateOnly(row: Lock): void {
    if (row.remaining > 0) {
      if (row.source == SOURCE_BALANCE) {
        this.creditBalance(row.listener, row.tokenContract, row.remaining, row.symRaw);
      } else {
        this.sendToken(row.tokenContract, row.listener, row.remaining, row.symRaw, "onda rebate");
      }
      row.remaining = 0;
    }
    this.locks.remove(row);
  }

  private accrueUnits(remaining: u64, vestPerSec: u64, lastVest: u32, now: u32): u64 {
    if (now <= lastVest) return 0;
    const elapsed: u64 = <u64>(now - lastVest);
    let due = vestPerSec * elapsed;
    if (due > remaining) due = remaining;
    return due;
  }

  private accrueLock(row: Lock, rebate: bool): void {
    const now = <u32>currentTimeSec();
    const due = this.accrueUnits(row.remaining, row.vestPerSec, row.lastVest, now);
    row.remaining -= due;
    row.lastVest = now;
    if (due > 0) this.credit(row.payout, row.tokenContract, due, row.symRaw);
    if (rebate && row.remaining > 0) {
      if (row.source == SOURCE_BALANCE) {
        this.creditBalance(row.listener, row.tokenContract, row.remaining, row.symRaw);
      } else {
        this.sendToken(row.tokenContract, row.listener, row.remaining, row.symRaw, "onda rebate");
      }
      row.remaining = 0;
    }
    if (row.remaining == 0) {
      this.locks.remove(row);
    } else {
      this.locks.update(row, this.receiver);
    }
  }

  private accrueLegacy(row: Stream, rebate: bool): void {
    const now = <u32>currentTimeSec();
    const due = this.accrueUnits(row.remaining, row.vestPerSec, row.lastVest, now);
    row.remaining -= due;
    row.lastVest = now;
    if (due > 0) this.credit(row.payout, row.tokenContract, due, row.symRaw);
    if (rebate && row.remaining > 0) {
      this.sendToken(row.tokenContract, row.listener, row.remaining, row.symRaw, "onda rebate");
      row.remaining = 0;
    }
    if (row.remaining == 0) {
      this.streams.remove(row);
    } else {
      this.streams.update(row, this.receiver);
    }
  }

  private creditBalance(account: Name, token: Name, amount: u64, symRaw: u64): void {
    check(amount > 0, "zero credit");
    const id = tokenKey(account, token, symRaw);
    let row = this.balances.get(id);
    if (row == null) {
      row = new Balance(id, account, token, amount, symRaw);
      this.balances.store(row, this.receiver);
      return;
    }
    row.amount += amount;
    this.balances.update(row, this.receiver);
  }

  private bumpCap(account: Name, token: Name, symRaw: u64, cap: u64): void {
    const row = this.balances.get(tokenKey(account, token, symRaw));
    if (row == null || cap <= row!.maxPerTick) return;
    row!.maxPerTick = cap;
    this.balances.update(row!, this.receiver);
  }

  private debitBalance(account: Name, token: Name, symRaw: u64, amount: u64): void {
    const id = tokenKey(account, token, symRaw);
    const row = this.balances.get(id);
    check(row != null, "no onda balance");
    check(row!.amount >= amount, "insufficient onda balance");
    row!.amount -= amount;
    if (row!.amount == 0) {
      this.balances.remove(row!);
    } else {
      this.balances.update(row!, this.receiver);
    }
  }

  private credit(account: Name, token: Name, amount: u64, symRaw: u64): void {
    const id = tokenKey(account, token, symRaw);
    let row = this.claimed.get(id);
    if (row == null) {
      row = new Claimed(id, account, token, amount, symRaw);
      this.claimed.store(row, this.receiver);
      return;
    }
    row.amount += amount;
    this.claimed.update(row, this.receiver);
  }

  private payoutClaimed(account: Name): void {
    let scanned: u32 = 0;
    let row = this.claimed.first();
    while (row != null && scanned < CLAIM_SCAN_LIMIT) {
      const next = this.claimed.next(row);
      if (row.account == account && row.amount > 0) {
        const amount = row.amount;
        const token = row.tokenContract;
        const symRaw = row.symRaw;
        this.claimed.remove(row);
        this.sendToken(token, account, amount, symRaw, "onda claim");
      }
      row = next;
      scanned++;
    }
    // CLAIM_SCAN_LIMIT reached → stop without reverting; the remaining rows
    // are picked up by the next claim() (hash-key order keeps it fair). A
    // future deploy can replace this with byAccount index ranges once the
    // proton-tsc secondary iteration surface is pinned down on-chain tests.
  }

  /**
   * Send FROM the listener using the permission they granted us.
   *
   * THE trap: proton-tsc's transfer helper defaults the inline authorization to
   * `from@active`. The @eosio.code grant lives in the custom CHILD permission,
   * and children never satisfy parents — so that default fails for every real
   * listener while a self-test (where from == this contract) still passes,
   * because the contract's own active contains its own @eosio.code. The
   * PermissionLevel below must name the granted permission explicitly.
   */
  private sendFrom(token: Name, from: Name, perm: Name, to: Name, amount: u64, symRaw: u64, memo: string): void {
    check(amount > 0, "zero send");
    const asset = new Asset(amount, symFromRaw(symRaw));
    const action = new InlineAction<Transfer>("transfer").act(
      token,
      new PermissionLevel(from, perm),
    );
    action.send(new Transfer(from, to, asset, memo));
  }

  private sendToken(token: Name, to: Name, amount: u64, symRaw: u64, memo: string): void {
    check(amount > 0, "zero send");
    const asset = new Asset(amount, symFromRaw(symRaw));
    const action = new InlineAction<Transfer>("transfer").act(
      token,
      new PermissionLevel(this.receiver, Name.fromString("active")),
    );
    action.send(new Transfer(this.receiver, to, asset, memo));
  }
}
