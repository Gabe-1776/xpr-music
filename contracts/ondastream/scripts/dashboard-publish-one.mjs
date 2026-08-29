#!/usr/bin/env node
// Headed Chrome: publish ONE song through the live artist dashboard
// (login → form → Publish → WebAuth setsong). Not a catalog dump.
import { chromium } from "playwright-core";
import { homedir } from "node:os";

const LIVE = "https://music.project-testing.xyz";
const TITLE = "Deep Devotion";
const CATEGORY = "Electronic";
const ALBUM = "Basement Gospel";
const PAYOUT = "felixpaw";
const AUDIO = `${homedir()}/Developer/xpr-music/app/media/songs/Deep_Devotion.mp3`;
const COVER = `${homedir()}/Developer/xpr-music/app/web/assets/covers/basement-gospel.jpg`;

function log(...a) { console.log(new Date().toISOString(), ...a); }

const browser = await chromium.launch({
  channel: "chrome",
  headless: false,
  args: ["--disable-blink-features=AutomationControlled"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(180000);

try {
  log("OPEN", LIVE);
  await page.goto(LIVE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#walletButton");
  await page.waitForTimeout(1500);

  const label = (await page.locator("#walletLabel").textContent()) || "";
  log("wallet label", label.trim());
  if (!/felixpaw/i.test(label)) {
    log("WAITING_LOGIN — Face-ID Testnet as felixpaw");
    await page.locator("#artistLoginNav").click();
    await page.waitForSelector("#walletNetworkPicker:not([hidden])");
    await page.locator('#walletNetworkPicker button[data-network="testnet"]').click();
    await page.waitForFunction(() => {
      const el = document.getElementById("walletLabel");
      return el && /felixpaw/i.test(el.textContent || "");
    }, { timeout: 180000 });
  }
  const actor = ((await page.locator("#walletLabel").textContent()) || "").trim();
  log("LOGGED_IN", actor);
  if (!/felixpaw/i.test(actor)) throw new Error(`logged in as ${actor}, need felixpaw`);

  await page.locator("#artistLoginNav").click();
  await page.waitForSelector('input[placeholder="Song title"]', { timeout: 30000 });

  await page.locator('input[placeholder="Song title"]').fill(TITLE);
  await page.locator("select").nth(0).selectOption({ label: CATEGORY });
  const albumSel = page.locator("select").nth(1);
  const albumVal = await albumSel.locator("option", { hasText: ALBUM }).first().getAttribute("value");
  if (albumVal) await albumSel.selectOption(albumVal);
  else log("WARN no album option", ALBUM);

  await page.locator('input[type="file"][accept="audio/*"]').setInputFiles(AUDIO);
  const cover = page.locator('input[type="file"][accept="image/*"]').nth(1);
  if (await cover.count()) await cover.setInputFiles(COVER);
  await page.locator(".payout-field input").fill(PAYOUT);

  log("WAITING_SETSONG — click Publish, Face-ID setsong");
  await page.locator("button.dialog-submit", { hasText: "Publish song" }).click();

  const toast = page.locator("#toast");
  await page.waitForFunction(() => {
    const t = document.getElementById("toast");
    const txt = (t && t.textContent) || "";
    return /published/i.test(txt);
  }, { timeout: 180000 });
  const toastText = ((await toast.textContent()) || "").trim();
  log("TOAST", toastText);

  const catalog = await page.request.get(`${LIVE}/api/catalog`);
  const body = await catalog.json();
  const songs = body.songs || [];
  const mine = songs.filter((s) => /deep devotion/i.test(s.title));
  log("CATALOG_N", songs.length, "deep-devotion", mine.map((s) => ({ id: s.id, owner: s.owner, payout: s.payout_account })));
  if (!mine.length) throw new Error("catalog has no Deep Devotion after publish");
  log("DONE", mine[0].id);
} catch (err) {
  const shot = "/tmp/onda-dashboard-publish.png";
  try { await page.screenshot({ path: shot, fullPage: true }); log("screenshot", shot); } catch (_) {}
  log("FAIL", err && err.message ? err.message : err);
  process.exitCode = 1;
} finally {
  await browser.close();
}
