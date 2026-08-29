// Prove a token that is NOT XPR works end-to-end, and that `xtokens` hosting
// two different symbols is disambiguated correctly.
import { Api, JsonRpc, JsSignatureProvider } from '@proton/js'
import fs from 'fs'; import os from 'os'; import path from 'path'
const env = Object.fromEntries(fs.readFileSync(path.join(os.homedir(), '.openclaw/workspace/.env.xpr'), 'utf8')
  .split('\n').filter(l => l.includes('=') && !l.trim().startsWith('#'))
  .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]))
const w = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.xpr-testnet/wallets.json'), 'utf8'))
const rpc = new JsonRpc(['https://test.proton.eosusa.io'], { fetch })
const listener = new Api({ rpc, signatureProvider: new JsSignatureProvider([env.XPR_PRIVATE_KEY]) })
const keeper = new Api({ rpc, signatureProvider: new JsSignatureProvider([w.accounts.xprmusic.private_key]) })
const songId = JSON.parse(fs.readFileSync(path.join(os.homedir(), 'Developer/xpr-music/app/catalog/songs.json'), 'utf8'))[0].id
const TOKEN = { contract: 'xtokens', sym: '6,XUSDC' }
const bal = async (a, c, s) => ((await rpc.get_currency_balance(c, a, s))[0]) || `0 ${s}`

console.log('1. DEPOSIT 0.010000 XUSDC (memo onda)')
await listener.transact({ actions: [{ account: 'xtokens', name: 'transfer',
  authorization: [{ actor: 'felixpaw', permission: 'active' }],
  data: { from: 'felixpaw', to: 'ondastream', quantity: '0.010000 XUSDC', memo: 'onda' } }] },
  { blocksBehind: 3, expireSeconds: 60 })
await new Promise(r => setTimeout(r, 4000))
const rows = async () => (await rpc.get_table_rows({ json: true, code: 'ondastream', scope: 'ondastream', table: 'balances', limit: 10 })).rows
console.log('   balances:', JSON.stringify(await rows()))
console.log('   artist XUSDC before:', await bal('musictesting', 'xtokens', 'XUSDC'))

console.log('2. STREAM 3 pulls in XUSDC (listener signs nothing)')
for (let i = 0; i < 3; i++) {
  try {
    await keeper.transact({ actions: [{ account: 'ondastream', name: 'pullbal',
      authorization: [{ actor: 'xprmusic', permission: 'active' }],
      data: { listener: 'felixpaw', songId, token: TOKEN } }] }, { blocksBehind: 3, expireSeconds: 60 })
    console.log(`   pull ${i + 1}: OK`)
  } catch (e) { console.log(`   pull ${i + 1}: FAIL`, (e.message || String(e)).split('\n')[0].slice(0, 130)) }
  if (i < 2) await new Promise(r => setTimeout(r, 2500))
}
await new Promise(r => setTimeout(r, 4000))
console.log('   artist XUSDC after :', await bal('musictesting', 'xtokens', 'XUSDC'))
console.log('   balances:', JSON.stringify(await rows()))

console.log('3. REJECT an unpriced token (xtokens/FOOBAR should not be payable)')
try {
  await keeper.transact({ actions: [{ account: 'ondastream', name: 'pullbal',
    authorization: [{ actor: 'xprmusic', permission: 'active' }],
    data: { listener: 'felixpaw', songId, token: { contract: 'xtokens', sym: '4,FOOBAR' } } }] }, { blocksBehind: 3, expireSeconds: 60 })
  console.log('   UNEXPECTEDLY ACCEPTED — bad')
} catch (e) { console.log('   correctly rejected:', (e.message || String(e)).split('\n')[0].slice(0, 90)) }

console.log('4. WITHDRAW remaining XUSDC')
await listener.transact({ actions: [{ account: 'ondastream', name: 'withdraw',
  authorization: [{ actor: 'felixpaw', permission: 'active' }],
  data: { listener: 'felixpaw', token: TOKEN } }] }, { blocksBehind: 3, expireSeconds: 60 })
await new Promise(r => setTimeout(r, 4000))
console.log('   balances after withdraw:', JSON.stringify(await rows()))
