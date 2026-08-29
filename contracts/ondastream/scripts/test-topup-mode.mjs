// Mode A end-to-end: deposit (memo `onda`) -> stream from credits -> withdraw.
// Proves the consumer default needs exactly ONE signature and no lock.
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
const bal = async a => (await rpc.get_currency_balance('eosio.token', a, 'XPR'))[0]
const credits = async () => {
  const r = (await rpc.get_table_rows({ json: true, code: 'ondastream', scope: 'ondastream', table: 'balances', limit: 10 })).rows
  return r.length ? r[0].amount : 0
}
console.log('1. DEPOSIT 0.0500 XPR, memo "onda" (the ONE signature)')
await listener.transact({ actions: [{ account: 'eosio.token', name: 'transfer',
  authorization: [{ actor: 'felixpaw', permission: 'active' }],
  data: { from: 'felixpaw', to: 'ondastream', quantity: '0.0500 XPR', memo: 'onda' } }] },
  { blocksBehind: 3, expireSeconds: 60 })
await new Promise(r => setTimeout(r, 4000))
console.log('   credits =', await credits(), 'raw units   artist =', await bal('musictesting'))

console.log('2. STREAM — 4 keeper pulls, listener signs NOTHING')
for (let i = 0; i < 4; i++) {
  try {
    await keeper.transact({ actions: [{ account: 'ondastream', name: 'pullbal',
      authorization: [{ actor: 'xprmusic', permission: 'active' }],
      data: { listener: 'felixpaw', songId, token: 'eosio.token' } }] }, { blocksBehind: 3, expireSeconds: 60 })
    console.log(`   pull ${i + 1}: OK`)
  } catch (e) { console.log(`   pull ${i + 1}: FAIL`, (e.message || String(e)).split('\n')[0].slice(0, 110)) }
  if (i < 3) await new Promise(r => setTimeout(r, 2500))
}
await new Promise(r => setTimeout(r, 4000))
console.log('   credits =', await credits(), '  artist =', await bal('musictesting'))

console.log('3. WITHDRAW the rest')
const before = await bal('felixpaw')
await listener.transact({ actions: [{ account: 'ondastream', name: 'withdraw',
  authorization: [{ actor: 'felixpaw', permission: 'active' }],
  data: { listener: 'felixpaw', token: 'eosio.token' } }] }, { blocksBehind: 3, expireSeconds: 60 })
await new Promise(r => setTimeout(r, 4000))
console.log(`   felixpaw ${before} -> ${await bal('felixpaw')}   credits left = ${await credits()}`)
