// Onda wallet login — copy of Mail Sigil's live login (bulwark login/page.tsx
// handleXprLogin, 2026-07-23). Do not invent extra scheme/testUrl knobs.
//
// Returning visit = restoreSession (no prompt) + one sigillogin signature.
// First visit = ConnectWallet; proof if the wallet has one, else the same
// nonce sign. Burned proofs fall through to nonce. A dead restored session
// (transact hang / unknown credential) purges SDK storage and reconnects.
(function (global) {
  const SDK_V4 = "https://esm.sh/@proton/web-sdk@4";
  const LINK_V3 = "https://esm.sh/@proton/link@3";
  const GREYMASS = "https://esm.sh/@greymass/eosio";
  const LOGIN_CONTRACT = "sigillogin";
  let sdkPromise = null;

  // The login flow used to build a session and drop it. Money actions need the
  // same link session, and re-running ConnectWallet just to sign a transfer is
  // an extra wallet prompt for a session we already hold.
  let activeSession = null;

  function loadSdk() {
    if (!sdkPromise) {
      sdkPromise = Promise.all([import(SDK_V4), import(LINK_V3)]).then(([mod]) => mod.default);
    }
    return sdkPromise;
  }

  function asError(err) {
    if (err instanceof Error) return err;
    if (err && typeof err === "object" && err.message) return new Error(String(err.message));
    return new Error(String(err || "Wallet login failed"));
  }

  function isWalletCancel(err) {
    if (err && typeof err === "object" && err.code === "E_CANCEL") return true;
    return /cancell?ed/i.test(String(err && err.message || err || ""));
  }

  function isProofReplay(err) {
    return /already used/i.test(String(err && err.message || err || ""));
  }

  function purgeProtonSdkStorage() {
    try {
      const stale = [];
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (key && (key.startsWith("proton-storage") || key.startsWith("proton-link"))) stale.push(key);
      }
      stale.forEach((key) => localStorage.removeItem(key));
    } catch (_) {}
  }

  function sdkOpts(chainId, endpoints, requestAccount, appName) {
    return {
      linkOptions: { chainId: chainId, endpoints: endpoints },
      transportOptions: { requestAccount: requestAccount },
      selectorOptions: {
        appName: appName,
        enabledWalletTypes: ["webauth", "anchor", "proton"],
      },
    };
  }

  async function txHex(signed) {
    if (signed && signed.transaction) {
      try {
        const { Serializer } = await import(GREYMASS);
        const hex = Serializer.encode({ object: signed.transaction }).hexString;
        if (hex) return hex;
      } catch (_) {}
    }
    const raw = signed && (signed.resolved && signed.resolved.serializedTransaction
      ? signed.resolved.serializedTransaction
      : signed.serializedTransaction);
    if (!raw) return null;
    if (typeof raw === "string") return raw.replace(/^0x/i, "");
    const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  async function viaNonce(session, request, status, loginContract, bounded) {
    status("Preparing your sign-in…");
    const challenge = await request("/api/auth/nonce", { method: "POST" });
    const nonce = challenge.nonce || (String(challenge.message || "").match(/Nonce: (\S+)/) || [])[1];
    if (!challenge.challengeId || !nonce) throw new Error("login challenge missing");
    const actor = session.auth.actor;
    const permission = session.auth.permission;
    status("Connected — confirm the sign-in in your wallet. Nothing is sent to the blockchain and nothing is spent.");
    const transactPromise = session.transact(
      {
        actions: [{
          account: loginContract,
          name: "login",
          authorization: [{ actor: actor, permission: permission }],
          data: { account: actor, nonce: nonce },
        }],
      },
      { broadcast: false },
    );
    const result = bounded
      ? await Promise.race([
          transactPromise,
          new Promise((_, reject) => {
            setTimeout(() => reject(new Error("Restored wallet session did not respond — reconnecting…")), 90000);
          }),
        ])
      : await transactPromise;
    const serializedTransaction = await txHex(result);
    const signatures = result && result.signatures;
    if (!serializedTransaction || !signatures || !signatures.length) {
      throw new Error("This wallet could not sign the login challenge — try Anchor or the WebAuth app");
    }
    status("Verifying signature…");
    const data = await request("/api/auth/verify", {
      method: "POST",
      body: JSON.stringify({
        challengeId: challenge.challengeId,
        actor: actor,
        permission: permission,
        signatures: signatures,
        serializedTransaction: serializedTransaction,
      }),
    });
    if (!data || !data.token) throw new Error((data && data.error) || "verification failed");
    return { actor: data.actor || String(actor), permission: String(permission || "active"), token: data.token };
  }

  async function verifyWithSession(session, loginResult, request, status, loginContract, bounded) {
    if (loginResult && loginResult.proof) {
      status("Verifying…");
      try {
        const data = await request("/api/auth/verify-proof", {
          method: "POST",
          body: JSON.stringify({ proof: loginResult.proof.toString() }),
        });
        if (data && data.token) {
          return {
            actor: data.actor || String(session.auth.actor),
            permission: String(session.auth.permission || "active"),
            token: data.token,
          };
        }
      } catch (err) {
        if (!isProofReplay(err)) throw err;
      }
    }
    return viaNonce(session, request, status, loginContract, bounded);
  }

  global.ondaWalletLogin = async function ondaWalletLogin(opts) {
    const { chainId, endpoints, requestAccount, appName, request, onStatus } = opts || {};
    const status = typeof onStatus === "function" ? onStatus : function () {};
    const ProtonWebSDK = await loadSdk();
    if (typeof ProtonWebSDK !== "function") {
      throw new Error("Wallet SDK failed to load — check your connection and reload");
    }
    const optsSdk = sdkOpts(chainId, endpoints, requestAccount, appName);

    // Silent restore FIRST — Mail Sigil / SimpleDex model. Restoring the
    // stored link session prompts for nothing; the sigillogin signature is
    // still the only gate. Re-login = one wallet approval, not connect+sign.
    let session = null;
    let loginResult = null;
    let restoredSilently = false;
    try {
      const restored = await ProtonWebSDK({
        linkOptions: Object.assign({}, optsSdk.linkOptions, { restoreSession: true }),
        transportOptions: optsSdk.transportOptions,
        selectorOptions: optsSdk.selectorOptions,
      });
      if (restored && restored.session) {
        session = restored.session;
        restoredSilently = true;
      }
    } catch (_) {}

    if (!session) {
      status("Connecting…");
      let fresh;
      try {
        fresh = await ProtonWebSDK(optsSdk);
      } catch (err) {
        throw asError(err);
      }
      if (fresh && fresh.error) throw asError(fresh.error);
      session = fresh && fresh.session;
      loginResult = fresh && fresh.loginResult;
    }
    if (!session) throw new Error("Wallet connection was cancelled");
    activeSession = session;

    try {
      return await verifyWithSession(session, loginResult, request, status, LOGIN_CONTRACT, restoredSilently);
    } catch (pipelineErr) {
      if (!restoredSilently || isWalletCancel(pipelineErr)) throw asError(pipelineErr);
      purgeProtonSdkStorage();
      status("Reconnecting wallet…");
      let fresh;
      try {
        fresh = await ProtonWebSDK(optsSdk);
      } catch (err) {
        throw asError(err);
      }
      if (fresh && fresh.error) throw asError(fresh.error);
      if (!fresh || !fresh.session) throw new Error("Wallet connection was cancelled");
      activeSession = fresh.session;
      return verifyWithSession(fresh.session, fresh.loginResult, request, status, LOGIN_CONTRACT, false);
    }
  };

  // ------------------------------------------------------------------ chain
  // Money layer. Login proves identity to our server; everything below is the
  // listener's own funds moving on chain, so the browser signs and the server
  // is never in the path.

  const MEMO_PARK = "onda";

  // Hard allowlist. Anything else is not payable — the contract's notify
  // returns without crediting, so a stray token is a silent loss.
  const DEFAULT_TOKENS = [
    { code: "XPR", contract: "eosio.token", symbol: "XPR", decimals: 4 },
    { code: "XUSDC", contract: "xtokens", symbol: "XUSDC", decimals: 6 },
  ];

  // ---- Pay-modes tokens (BLUEPRINT-pay-modes.md, 2026-08-24) --------------
  // The five tokens the ondastream `tokrates` table actually prices. Kept
  // SEPARATE from DEFAULT_TOKENS/tokenFor (the legacy lock-flow list) because
  // `xtokens` hosts BOTH XUSDC and METAL — matching by contract alone (what
  // tokenFor does) is ambiguous once METAL is in the list, so top-up/withdraw/
  // grant use this id-keyed list and match balances/grants rows by
  // (contract, decoded symbol) instead of contract alone.
  const ONDA_TOKENS = [
    { id: "xpr", code: "XPR", contract: "eosio.token", symbol: "XPR", decimals: 4 },
    { id: "xusdc", code: "XUSDC", contract: "xtokens", symbol: "XUSDC", decimals: 6 },
    { id: "metal", code: "METAL", contract: "xtokens", symbol: "METAL", decimals: 8 },
    { id: "loan", code: "LOAN", contract: "loan.token", symbol: "LOAN", decimals: 4 },
    { id: "xmd", code: "XMD", contract: "xmd.token", symbol: "XMD", decimals: 6 },
  ];
  function ondaTokenById(id) {
    return ONDA_TOKENS.find(function (t) { return t.id === String(id || ""); }) || null;
  }
  function requireOndaToken(id) {
    const token = ondaTokenById(id);
    if (!token) throw new Error("unknown token");
    return token;
  }
  // A symbol's raw u64 packs precision in the low byte and the ASCII code
  // above it — mirrors onda-pulse.js's symFromRaw (contract-side). Needed to
  // tell rows in the same `xtokens`-contract bucket apart.
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
    return { precision: precision, code: code };
  }
  function ondaTokenFromRow(contract, symRaw) {
    const decoded = ondaSymFromRaw(symRaw);
    return ONDA_TOKENS.find(function (t) {
      return t.contract === String(contract) && t.symbol === decoded.code && t.decimals === decoded.precision;
    }) || null;
  }

  const chainConfig = {
    network: "testnet",
    chainId: null,
    endpoints: [],
    requestAccount: "ondastream",
    appName: "Onda",
    contract: "ondastream",
    tokens: DEFAULT_TOKENS.slice(),
    windowSec: 2,
    defaultBufferSec: 30,
    maxBufferSec: 180,
  };

  const CONFIG_KEYS = [
    "network", "chainId", "endpoints", "requestAccount", "appName",
    "contract", "tokens", "windowSec", "defaultBufferSec", "maxBufferSec",
  ];

  function configure(opts) {
    const given = opts || {};
    CONFIG_KEYS.forEach(function (key) {
      if (given[key] !== undefined && given[key] !== null) chainConfig[key] = given[key];
    });
    return getConfig();
  }

  function getConfig() {
    const out = {};
    CONFIG_KEYS.forEach(function (key) { out[key] = chainConfig[key]; });
    out.tokens = (chainConfig.tokens || []).slice();
    out.endpoints = (chainConfig.endpoints || []).slice();
    return out;
  }

  function isConfigured() {
    return !!(chainConfig.chainId && (chainConfig.endpoints || []).length && chainConfig.contract);
  }

  function tokenFor(tokenContract) {
    const wanted = String(tokenContract || "");
    const list = chainConfig.tokens || [];
    for (let i = 0; i < list.length; i += 1) {
      if (list[i] && String(list[i].contract) === wanted) return list[i];
    }
    return null;
  }

  function requireToken(tokenContract) {
    const token = tokenFor(tokenContract);
    if (!token) throw new Error("token not accepted");
    return token;
  }

  function clampBuffer(bufferSec) {
    const min = Math.max(1, Math.floor(Number(chainConfig.windowSec) || 1));
    const max = Math.max(min, Math.floor(Number(chainConfig.maxBufferSec) || min));
    let want = Math.floor(Number(bufferSec));
    if (!isFinite(want) || want <= 0) want = Math.floor(Number(chainConfig.defaultBufferSec) || min);
    return Math.min(max, Math.max(min, want));
  }

  function requireSongId(songId) {
    const id = String(songId == null ? "" : songId);
    if (!id || id.length > 64) throw new Error("invalid songId");
    return id;
  }

  function actorOf(session) {
    // session.auth.actor is a Name object — template it into a string or the
    // action data serialises as "[object Object]".
    return String(session.auth.actor);
  }

  // Fixed-point straight off the integer. Float division builds strings like
  // "0.30000000000000004 XPR" and the chain rejects the precision outright.
  function formatAsset(raw, decimals, symbol) {
    const places = Math.max(0, Math.floor(Number(decimals) || 0));
    let units = Math.round(Number(raw));
    if (!isFinite(units)) throw new Error("invalid amount");
    const negative = units < 0;
    if (negative) units = -units;
    let digits = String(units);
    if (places > 0) {
      while (digits.length <= places) digits = "0" + digits;
      digits = digits.slice(0, digits.length - places) + "." + digits.slice(digits.length - places);
    }
    return (negative ? "-" : "") + digits + " " + String(symbol);
  }

  // One place for reads. Endpoints are tried in order so a flaky RPC degrades
  // to the next instead of blanking the balances card.
  async function getTableRows(query) {
    const endpoints = chainConfig.endpoints || [];
    if (!endpoints.length) throw new Error("chain endpoints not configured");
    let lastErr = null;
    for (let i = 0; i < endpoints.length; i += 1) {
      const base = String(endpoints[i]).replace(/\/+$/, "");
      try {
        const res = await fetch(base + "/v1/chain/get_table_rows", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(query),
        });
        if (!res.ok) {
          lastErr = new Error("chain read failed (" + res.status + ")");
          continue;
        }
        const data = await res.json();
        return (data && data.rows) || [];
      } catch (err) {
        lastErr = asError(err);
      }
    }
    throw lastErr || new Error("chain read failed");
  }

  // get_account, not get_table_rows: this is how we see a listener's OWN
  // permissions/linked_actions before deciding whether a grant needs to
  // unlinkauth an existing (account, code, transfer) link first — linkauth
  // is not idempotent, and one (account, code, action) has exactly one
  // requirement (BLUEPRINT-pay-modes.md).
  async function getAccountInfo(actor) {
    const endpoints = chainConfig.endpoints || [];
    if (!endpoints.length) throw new Error("chain endpoints not configured");
    let lastErr = null;
    for (let i = 0; i < endpoints.length; i += 1) {
      const base = String(endpoints[i]).replace(/\/+$/, "");
      try {
        const res = await fetch(base + "/v1/chain/get_account", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ account_name: actor }),
        });
        if (!res.ok) {
          lastErr = new Error("chain read failed (" + res.status + ")");
          continue;
        }
        return await res.json();
      } catch (err) {
        lastErr = asError(err);
      }
    }
    throw lastErr || new Error("chain read failed");
  }

  async function getRates() {
    const code = chainConfig.contract;
    const rows = await getTableRows({ json: true, code: code, scope: code, table: "rates", limit: 1 });
    if (!rows.length) return null;
    return {
      xprPerSec: Number(rows[0].xprPerSec || 0),
      xusdcPerSec: Number(rows[0].xusdcPerSec || 0),
    };
  }

  async function rateFor(tokenContract) {
    const token = requireToken(tokenContract);
    const rates = await getRates();
    const isUsdc = token.contract === "xtokens" || token.symbol === "XUSDC" || token.code === "XUSDC";
    const perSecRaw = rates ? Number(isUsdc ? rates.xusdcPerSec : rates.xprPerSec) : 0;
    // No singleton or a zero rate means the owner never ran setrate. Quoting
    // "free" here would sign a transfer the contract can't turn into a lock.
    if (!perSecRaw || perSecRaw <= 0) throw new Error("catalog rate not set on chain");
    return {
      contract: token.contract,
      symbol: token.symbol,
      decimals: token.decimals,
      perSecRaw: perSecRaw,
    };
  }

  async function quoteRaw(tokenContract, bufferSec) {
    const rate = await rateFor(tokenContract);
    const seconds = Math.floor(Number(bufferSec));
    if (!isFinite(seconds) || seconds <= 0) throw new Error("buffer must be a positive number of seconds");
    return rate.perSecRaw * seconds;
  }

  function balanceFromRow(row) {
    const token = tokenFor(row && row.tokenContract);
    if (!token) return null; // unknown token: not payable, don't surface it as money
    const amountRaw = Number(row.amount || 0);
    return {
      contract: token.contract,
      symbol: token.symbol,
      decimals: token.decimals,
      amountRaw: amountRaw,
      amount: amountRaw / Math.pow(10, token.decimals),
    };
  }

  async function getBalances(actor) {
    const who = String(actor || "");
    if (!who) return [];
    const code = chainConfig.contract;
    // balances' primary key is a hash of listener+token — it can't be looked up
    // by account. byAccount (index_position 2) is the listener index.
    const rows = await getTableRows({
      json: true,
      code: code,
      scope: code,
      table: "balances",
      index_position: 2,
      key_type: "name",
      lower_bound: who,
      upper_bound: who,
      limit: 10,
    });
    const out = [];
    rows.forEach(function (row) {
      if (row && row.account && String(row.account) !== who) return;
      const balance = balanceFromRow(row);
      if (balance) out.push(balance);
    });
    return out;
  }

  async function getBalance(actor, tokenContract) {
    const token = requireToken(tokenContract);
    const all = await getBalances(actor);
    for (let i = 0; i < all.length; i += 1) {
      if (all[i].contract === token.contract) return all[i];
    }
    return null;
  }

  async function getLock(actor) {
    const who = String(actor || "");
    if (!who) return null;
    const code = chainConfig.contract;
    const rows = await getTableRows({
      json: true,
      code: code,
      scope: code,
      table: "locks",
      limit: 1,
      key_type: "name",
      lower_bound: who,
      upper_bound: who,
    });
    const row = rows[0];
    if (!row || String(row.listener) !== who) return null;
    const token = tokenFor(row.tokenContract);
    if (!token) return null;
    const remainingRaw = Number(row.remaining || 0);
    const vestPerSec = Number(row.vestPerSec || 0);
    const lastVest = Number(row.lastVest || 0);
    const nowSec = Math.floor(Date.now() / 1000);
    // The contract only writes `remaining` when something touches the row, so
    // the stored number is stale between actions. Accrue locally for the bar.
    const elapsed = Math.max(0, nowSec - lastVest);
    const remainingRawNow = Math.max(0, remainingRaw - vestPerSec * elapsed);
    const source = Number(row.source || 0);
    return {
      listener: String(row.listener),
      songHash: row.songHash,
      songId: row.songId,
      payout: String(row.payout),
      tokenContract: String(row.tokenContract),
      vestPerSec: vestPerSec,
      lastVest: lastVest,
      opened: Number(row.opened || 0),
      symRaw: row.symRaw,
      contract: token.contract,
      symbol: token.symbol,
      decimals: token.decimals,
      remainingRaw: remainingRaw,
      remainingRawNow: remainingRawNow,
      remaining: remainingRawNow / Math.pow(10, token.decimals),
      remainingSec: vestPerSec > 0 ? Math.floor(remainingRawNow / vestPerSec) : 0,
      source: source,
      sourceLabel: source === 1 ? "balance" : "wallet",
    };
  }

  // ---- Pay-modes reads (all five tokens; see ONDA_TOKENS above) ----------

  /** Every token this listener has topped up, in real amounts. */
  async function getOndaBalances(actor) {
    const who = String(actor || "");
    if (!who) return [];
    const code = chainConfig.contract;
    const rows = await getTableRows({
      json: true,
      code: code,
      scope: code,
      table: "balances",
      index_position: 2,
      key_type: "name",
      lower_bound: who,
      upper_bound: who,
      limit: 20,
    });
    const out = [];
    rows.forEach(function (row) {
      if (!row || String(row.account) !== who) return;
      const token = ondaTokenFromRow(row.tokenContract, row.symRaw);
      if (!token) return; // unknown token: not payable, don't surface it as money
      const amountRaw = Number(row.amount || 0);
      out.push(Object.assign({}, token, { amountRaw: amountRaw, amount: amountRaw / Math.pow(10, token.decimals) }));
    });
    return out;
  }

  async function getOndaBalance(actor, tokenId) {
    const token = requireOndaToken(tokenId);
    const all = await getOndaBalances(actor);
    for (let i = 0; i < all.length; i += 1) if (all[i].id === token.id) return all[i];
    return null;
  }

  /** The listener's standing pull grant (Mode B), or null if none/expired. */
  async function getOndaGrant(actor) {
    const who = String(actor || "");
    if (!who) return null;
    const code = chainConfig.contract;
    const rows = await getTableRows({
      json: true,
      code: code,
      scope: code,
      table: "grants",
      limit: 1,
      key_type: "name",
      lower_bound: who,
      upper_bound: who,
    });
    const row = rows[0];
    if (!row || String(row.listener) !== who) return null;
    const token = ondaTokenFromRow(row.tokenContract, row.symRaw);
    const nowSec = Math.floor(Date.now() / 1000);
    return {
      listener: String(row.listener),
      perm: String(row.perm),
      token: token,
      maxPerTickRaw: Number(row.maxPerTick || 0),
      budgetRaw: Number(row.budget || 0),
      spentRaw: Number(row.spent || 0),
      expiresAt: Number(row.expiresAt || 0),
      lastPull: Number(row.lastPull || 0),
      expired: Number(row.expiresAt || 0) <= nowSec,
    };
  }

  /** Enabled per-token rates (raw units/sec) — used to size a sane default
   * maxPerTick for the grant form. One-shot read on Advanced-section open,
   * never polled. */
  async function getOndaTokRates() {
    const code = chainConfig.contract;
    const rows = await getTableRows({ json: true, code: code, scope: code, table: "tokrates", limit: 50 });
    const out = [];
    rows.forEach(function (row) {
      if (!row || !row.enabled) return;
      const token = ondaTokenFromRow(row.tokenContract, row.symRaw);
      if (!token) return;
      out.push(Object.assign({}, token, { perSecRaw: Number(row.perSec || 0) }));
    });
    return out;
  }

  function hasSession() {
    return !!activeSession;
  }

  function clearSession() {
    activeSession = null;
  }

  async function ensureSession(opts) {
    const interactive = !(opts && opts.interactive === false);
    if (activeSession) return activeSession;
    const ProtonWebSDK = await loadSdk();
    if (typeof ProtonWebSDK !== "function") {
      throw new Error("Wallet SDK failed to load — check your connection and reload");
    }
    const optsSdk = sdkOpts(chainConfig.chainId, chainConfig.endpoints, chainConfig.requestAccount, chainConfig.appName);
    try {
      const restored = await ProtonWebSDK({
        linkOptions: Object.assign({}, optsSdk.linkOptions, { restoreSession: true }),
        transportOptions: optsSdk.transportOptions,
        selectorOptions: optsSdk.selectorOptions,
      });
      if (restored && restored.session) {
        activeSession = restored.session;
        return activeSession;
      }
    } catch (_) {}
    if (!interactive) return null;
    let fresh;
    try {
      fresh = await ProtonWebSDK(optsSdk);
    } catch (err) {
      throw asError(err);
    }
    if (fresh && fresh.error) throw asError(fresh.error);
    if (!fresh || !fresh.session) throw new Error("Wallet connection was cancelled");
    activeSession = fresh.session;
    return activeSession;
  }

  // A restored link session can be one the wallet has already forgotten; the
  // SDK hands it back happily and it only dies at transact time. Same purge +
  // reconnect the login path does, so a spend isn't lost to stale storage.
  function isDeadSession(err) {
    return /unknown credential|no linked session|session not found|did not respond/i
      .test(String((err && err.message) || err || ""));
  }

  // `build(session)` may return one action or an array of actions (the grant
  // flow needs up to 4 in a single atomic transaction) — always broadcast as
  // a list.
  function asActionList(built) {
    return Array.isArray(built) ? built : [built];
  }
  async function signAction(build) {
    let session = await ensureSession({ interactive: true });
    try {
      return await session.transact({ actions: asActionList(build(session)) }, { broadcast: true });
    } catch (err) {
      if (isWalletCancel(err) || !isDeadSession(err)) throw asError(err);
      purgeProtonSdkStorage();
      activeSession = null;
      session = await ensureSession({ interactive: true });
      return session.transact({ actions: asActionList(build(session)) }, { broadcast: true });
    }
  }

  function transferAction(session, token, quantity, memo) {
    return {
      account: token.contract,
      name: "transfer",
      authorization: [session.auth],
      data: {
        from: actorOf(session),
        to: chainConfig.contract,
        quantity: quantity,
        memo: memo,
      },
    };
  }

  async function topUp(o) {
    const opts = o || {};
    const token = requireToken(opts.tokenContract);
    const amountRaw = Number(opts.amountRaw);
    if (!isFinite(amountRaw) || amountRaw <= 0 || Math.floor(amountRaw) !== amountRaw) {
      throw new Error("top-up amount must be a positive integer in raw token units");
    }
    const quantity = formatAsset(amountRaw, token.decimals, token.symbol);
    // Memo is `onda`. Never "deposit": that word on a transfer to the Metal X
    // dex sticks the funds permanently, and it is one typo'd `to` away here.
    const tx = await signAction(function (session) {
      return transferAction(session, token, quantity, MEMO_PARK);
    });
    return { tx: tx, quantity: quantity };
  }

  async function playFromWallet(o) {
    const opts = o || {};
    const token = requireToken(opts.tokenContract);
    const songId = requireSongId(opts.songId);
    const bufferSec = clampBuffer(opts.bufferSec);
    const amountRaw = await quoteRaw(token.contract, bufferSec);
    const quantity = formatAsset(amountRaw, token.decimals, token.symbol);
    const tx = await signAction(function (session) {
      return transferAction(session, token, quantity, "s:" + songId);
    });
    return { tx: tx, quantity: quantity, bufferSec: bufferSec };
  }

  async function playFromBalance(o) {
    const opts = o || {};
    const token = requireToken(opts.tokenContract);
    const songId = requireSongId(opts.songId);
    const bufferSec = clampBuffer(opts.bufferSec);
    // A short pot throws. Silently reaching into the wallet would spend money
    // the listener explicitly parked away from the wallet toggle.
    const tx = await signAction(function (session) {
      return {
        account: chainConfig.contract,
        name: "startstream",
        authorization: [session.auth],
        data: {
          listener: actorOf(session),
          songId: songId,
          token: token.contract,
          bufferSec: bufferSec,
        },
      };
    });
    return { tx: tx, bufferSec: bufferSec };
  }

  async function switchSong(o) {
    const songId = requireSongId((o || {}).songId);
    return signAction(function (session) {
      return {
        account: chainConfig.contract,
        name: "switchsong",
        authorization: [session.auth],
        data: { listener: actorOf(session), songId: songId },
      };
    });
  }

  async function stopStream() {
    try {
      return await signAction(function (session) {
        return {
          account: chainConfig.contract,
          name: "stopstream",
          authorization: [session.auth],
          data: { listener: actorOf(session) },
        };
      });
    } catch (err) {
      // Pause/skip/end can all land on stop; a second one is a no-op, not a
      // failure the listener should see. A real cancel still surfaces.
      if (!isWalletCancel(err) && /no open stream/i.test(String((err && err.message) || err || ""))) {
        return null;
      }
      throw asError(err);
    }
  }

  async function withdraw(o) {
    const token = requireToken((o || {}).tokenContract);
    return signAction(function (session) {
      return {
        account: chainConfig.contract,
        name: "withdraw",
        authorization: [session.auth],
        data: { listener: actorOf(session), token: token.contract },
      };
    });
  }

  // ---- Pay-modes writes (BLUEPRINT-pay-modes.md, 2026-08-24) -------------

  function extendedSymbol(token) {
    return { sym: token.decimals + "," + token.symbol, contract: token.contract };
  }

  /** Mode A: top-up. A plain transfer, memo `onda` — never `deposit` (Metal X
   * dex footgun, funds stick). Uncapped; the listener picks the size. */
  async function ondaDeposit(o) {
    const opts = o || {};
    const token = requireOndaToken(opts.tokenId);
    const amountRaw = Number(opts.amountRaw);
    if (!isFinite(amountRaw) || amountRaw <= 0 || Math.floor(amountRaw) !== amountRaw) {
      throw new Error("top-up amount must be a positive integer in raw token units");
    }
    const quantity = formatAsset(amountRaw, token.decimals, token.symbol);
    const tx = await signAction(function (session) {
      return transferAction(session, token, quantity, MEMO_PARK);
    });
    return { tx: tx, quantity: quantity, token: token };
  }

  /** Mode A: withdraw the full remaining balance for one token. */
  async function ondaWithdraw(o) {
    const token = requireOndaToken((o || {}).tokenId);
    return signAction(function (session) {
      return {
        account: chainConfig.contract,
        name: "withdraw",
        authorization: [session.auth],
        data: { listener: actorOf(session), token: extendedSymbol(token) },
      };
    });
  }

  /**
   * Mode B: grant, once ever. THREE actions in one atomic transaction
   * (updateauth + linkauth + ondastream::grant), plus a leading unlinkauth if
   * this account already has a DIFFERENT permission linked to this token's
   * `transfer` action — linkauth is not idempotent and one
   * (account, code, action) has exactly one requirement.
   *
   * WebAuth's mobile app silently refuses to DISPLAY an updateauth/linkauth
   * request — no error, nothing appears. So this races a timeout; on timeout
   * the caller should fall back to top-up with an honest message, never leave
   * a spinner waiting on a prompt that will never arrive.
   */
  async function ondaGrant(o) {
    const opts = o || {};
    const token = requireOndaToken(opts.tokenId);
    const actor = String(opts.actor || "");
    if (!actor) throw new Error("actor required");
    const budgetRaw = Math.floor(Number(opts.budgetRaw));
    const maxPerTickRaw = Math.floor(Number(opts.maxPerTickRaw));
    if (!isFinite(maxPerTickRaw) || maxPerTickRaw <= 0) throw new Error("maxPerTick must be a positive integer");
    if (!isFinite(budgetRaw) || budgetRaw < maxPerTickRaw) throw new Error("budget must be at least one tick");
    const days = Number(opts.days) > 0 ? Math.min(180, Number(opts.days)) : 7; // contract caps at 180 days
    const expiresAt = Math.floor(Date.now() / 1000) + Math.round(days * 86400);
    const PERM = "ondapull";
    const CONTRACT = chainConfig.contract;

    // Read the account's CURRENT links before opening a wallet prompt, so the
    // transaction we build already knows whether an unlinkauth is needed.
    const info = await getAccountInfo(actor);
    const linked = [];
    (info.permissions || []).forEach(function (p) {
      (p.linked_actions || []).forEach(function (l) {
        if (l.account === token.contract && l.action === "transfer") linked.push(p.perm_name);
      });
    });

    const build = function (session) {
      const acct = actorOf(session);
      const actions = [];
      linked.forEach(function (pn) {
        if (pn === PERM) return;
        actions.push({
          account: "eosio",
          name: "unlinkauth",
          authorization: [session.auth],
          data: { account: acct, code: token.contract, type: "transfer" },
        });
      });
      actions.push({
        account: "eosio",
        name: "updateauth",
        authorization: [session.auth],
        data: {
          account: acct,
          permission: PERM,
          parent: "active",
          // NEVER add anything to `waits` — it permanently bricks the account.
          auth: { threshold: 1, keys: [], waits: [], accounts: [{ permission: { actor: CONTRACT, permission: "eosio.code" }, weight: 1 }] },
        },
      });
      if (linked.indexOf(PERM) < 0) {
        actions.push({
          account: "eosio",
          name: "linkauth",
          authorization: [session.auth],
          data: { account: acct, code: token.contract, type: "transfer", requirement: PERM },
        });
      }
      actions.push({
        account: CONTRACT,
        name: "grant",
        authorization: [session.auth],
        data: {
          listener: acct,
          perm: PERM,
          token: extendedSymbol(token),
          maxPerTick: maxPerTickRaw,
          budget: budgetRaw,
          expiresAt: expiresAt,
        },
      });
      return actions;
    };

    const GRANT_TIMEOUT_MS = 40000;
    const tx = await Promise.race([
      signAction(build),
      new Promise(function (_, reject) {
        setTimeout(function () {
          reject(Object.assign(new Error("Wallet did not respond to the permission request — this often means it silently refused to show it. Try top-up instead."), { code: "E_GRANT_TIMEOUT" }));
        }, GRANT_TIMEOUT_MS);
      }),
    ]);
    return { tx: tx, token: token, maxPerTickRaw: maxPerTickRaw, budgetRaw: budgetRaw, expiresAt: expiresAt };
  }

  /** Soft revoke — stops OUR pulls immediately, but is only as honest as our
   * code. Not the cryptographic backstop; see ondaUnlinkauth. */
  async function ondaRevoke() {
    return signAction(function (session) {
      return {
        account: chainConfig.contract,
        name: "revoke",
        authorization: [session.auth],
        data: { listener: actorOf(session) },
      };
    });
  }

  /** The REAL backstop: remove the (account, code, transfer) link entirely.
   * Proven: after this, a pull fails "declares irrelevant authority" no
   * matter what the grants row still says. */
  async function ondaUnlinkauth(tokenId) {
    const token = requireOndaToken(tokenId);
    return signAction(function (session) {
      return {
        account: "eosio",
        name: "unlinkauth",
        authorization: [session.auth],
        data: { account: actorOf(session), code: token.contract, type: "transfer" },
      };
    });
  }

  // Artist registry. requireAuth(artist) on chain — the signed wallet IS the
  // artist. Payout may be a different account. Never `ondastream` (that's the
  // contract; vest would credit itself). Names: 1–12 a-z/1-5, no dots.
  function requirePayout(name) {
    const payout = String(name || "").trim().toLowerCase();
    if (!/^[a-z1-5]{1,12}$/.test(payout)) {
      throw new Error("payout must be a valid XPR account (1–12 chars, a-z and 1-5, no dots)");
    }
    if (payout === chainConfig.contract || payout === "ondastream") {
      throw new Error("payout cannot be the Onda contract — use the artist wallet");
    }
    return payout;
  }

  async function setSong(o) {
    const opts = o || {};
    const songId = requireSongId(opts.songId);
    const payout = requirePayout(opts.payout);
    return signAction(function (session) {
      return {
        account: chainConfig.contract,
        name: "setsong",
        authorization: [session.auth],
        data: {
          artist: actorOf(session),
          songId: songId,
          payout: payout,
        },
      };
    });
  }

  global.ondaChain = {
    configure: configure,
    getConfig: getConfig,
    isConfigured: isConfigured,
    isCancel: isWalletCancel,
    hasSession: hasSession,
    clearSession: clearSession,
    ensureSession: ensureSession,
    getRates: getRates,
    getBalances: getBalances,
    getBalance: getBalance,
    getLock: getLock,
    rateFor: rateFor,
    quoteRaw: quoteRaw,
    formatAsset: formatAsset,
    topUp: topUp,
    playFromWallet: playFromWallet,
    playFromBalance: playFromBalance,
    switchSong: switchSong,
    stopStream: stopStream,
    withdraw: withdraw,
    setSong: setSong,
    // Pay modes (BLUEPRINT-pay-modes.md): top-up (default) + advanced grant.
    ondaTokens: ONDA_TOKENS.slice(),
    getOndaBalances: getOndaBalances,
    getOndaBalance: getOndaBalance,
    getOndaGrant: getOndaGrant,
    getOndaTokRates: getOndaTokRates,
    ondaDeposit: ondaDeposit,
    ondaWithdraw: ondaWithdraw,
    ondaGrant: ondaGrant,
    ondaRevoke: ondaRevoke,
    ondaUnlinkauth: ondaUnlinkauth,
  };
})(window);
