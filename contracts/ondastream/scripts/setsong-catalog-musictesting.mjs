// setsong the live catalog on-chain as musictesting (artist must sign its own
// rows). musictesting is now newaccres-enrolled, so it self-pays bandwidth —
// no felixpaw first-authorizer needed. Listener stays felixpaw, so money now
// crosses accounts and authority bugs can no longer hide.
import { readFileSync } from 'node:fs'; import { homedir } from 'node:os'
import { Api, JsonRpc, JsSignatureProvider } from '@proton/js'
const CHAIN = '71ee83bcf52142d61019d95f9cc5427ba6a0d7ff8accd9e2088ae2abeaf3d3dd'
const ARTIST = 'musictesting', PAYOUT = 'musictesting'
const w = JSON.parse(readFileSync(`${homedir()}/.xpr-testnet/wallets.json`, 'utf8'))
const rpc = new JsonRpc(['https://test.proton.eosusa.io'], { fetch })
const info = await rpc.get_info()
if (info.chain_id !== CHAIN) { console.error('WRONG CHAIN — abort'); process.exit(1) }
const songs = JSON.parse(readFileSync(`${homedir()}/Developer/xpr-music/app/catalog/songs.json`, 'utf8'))
const bad = songs.filter(s => s.owner !== ARTIST)
if (bad.length) { console.error('catalog has non-musictesting owners:', bad.length); process.exit(1) }
const ids = songs.map(s => s.id)
const api = new Api({ rpc, signatureProvider: new JsSignatureProvider([w.accounts[ARTIST].private_key]) })
const act = id => ({ account: 'ondastream', name: 'setsong',
  authorization: [{ actor: ARTIST, permission: 'active' }],
  data: { artist: ARTIST, songId: id, payout: PAYOUT } })
for (let i = 0; i < ids.length; i += 8) {
  const batch = ids.slice(i, i + 8)
  const r = await api.transact({ actions: batch.map(act) }, { blocksBehind: 3, expireSeconds: 90 })
  console.log(`batch ${i / 8 + 1}: ${batch.length} songs  ${r.transaction_id}`)
}
// Stale RPC can miss a just-written row — retry before believing a miss.
await new Promise(r => setTimeout(r, 5000))
const rows = (await rpc.get_table_rows({ json: true, code: 'ondastream', scope: 'ondastream', table: 'songs', limit: 300 })).rows
const mine = new Map(rows.filter(r => r.artist === ARTIST).map(r => [r.songId, r]))
const missing = ids.filter(id => !mine.has(id))
console.log(`\non-chain rows owned by ${ARTIST}: ${mine.size}`)
console.log(missing.length ? `MISSING ${missing.length}: ${missing.join(', ')}` : 'ALL 34 CONFIRMED ON-CHAIN')
