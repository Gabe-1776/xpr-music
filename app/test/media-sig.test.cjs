const { test } = require("node:test");
const assert = require("node:assert/strict");
const auth = require("../auth.js");

test("media HMAC round-trips and rejects tamper/expiry", () => {
  const url = auth.signMediaUrl("songs/Deep_Devotion.mp3");
  const u = new URL(url, "http://x");
  const rel = decodeURIComponent(u.pathname.replace(/^\/media\//, ""));
  assert.equal(rel, "songs/Deep_Devotion.mp3");
  assert.equal(auth.verifyMediaSig(rel, u.searchParams.get("exp"), u.searchParams.get("sig")), true);
  assert.equal(auth.verifyMediaSig(rel, u.searchParams.get("exp"), "aa".repeat(32)), false);
  assert.equal(auth.verifyMediaSig(rel, "1", u.searchParams.get("sig")), false);
  assert.equal(auth.verifyMediaSig("songs/other.mp3", u.searchParams.get("exp"), u.searchParams.get("sig")), false);
});
