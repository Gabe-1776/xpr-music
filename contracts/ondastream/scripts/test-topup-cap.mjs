// Prove a deposit cannot be drained faster than the rate it was made under,
// even by someone who can call settokrate. This is what makes a top-up as safe
// as a grant.
import { Api, JsonRpc, JsSignatureProvider } from '@proton/js'
import fs from 'fs'; import os from 'os'; import path from 'path'
const env = Object.fromEntries(fs.readFileSync(path.join(os.homedir(), '.openclaw/workspace/.env.xpr'), 'utf8')
  .split('\n').filter(l => l.includes('=') && !l.trim().startsWith('#'))
  .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]))
const w = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.xpr-testnet/wallets.json'), 'utf8'))
const rpc = new JsonRpc(['https://test.proton.eosusa.io'], { fetch })
const owner = new Api({ rpc, signatureProvider: new JsSignatureProvider([env.XPR_PRIVATE_KEY]) })
const keeper = new Api({ rpc, signatureProvider: new JsSignatureProvider([w.accounts.xprmusic.private_key]) })
const songId = JSON.parse(fs.readFileSync(path.join(os.homedir(), 'Developer/xpr-music/app/catalog/songs.json'), 'utf8'))[0].id
const TOKEN = { contract: 'eosio.token', sym: '4,XPR' }
const bals = async () => (await rpc.get_table_rows({ json: true, code: 'ondastream', scope: 'ondastream', table: 'balances', limit: 5 })).rows
const setRate = (perSec) => owner.transact({ actions: [{ account: 'ondastream', name: 'settokrate',
  authorization: [{ actor: 'felixpaw', permission: 'active' }],
  data: { token: 'eosio.token', sym: '4,XPR', perSec, enabled: true } }] }, { blocksBehind: 3, expireSeconds: 60 })
const pull = async () => {
  try {
    await keeper.transact({ actions: [{ account: 'ondastream', name: 'pullbal',
      authorization: [{ actor: 'xprmusic', permission: 'active' }],
      data: { listener: 'felixpaw', songId, token: TOKEN } }] }, { blocksBehind: 3, expireSeconds: 60 })
    return 'CHARGED'
  } catch (e) { return 'BLOCKED: ' + (e.message || String(e)).split('\n')[0].slice(0, 70) }
}
console.log('1. deposit 1.0000 XPR at the normal rate (perSec=178)')
await owner.transact({ actions: [{ account: 'eosio.token', name: 'transfer',
  authorization: [{ actor: 'felixpaw', permission: 'active' }],
  data: { from: 'felixpaw', to: 'ondastream', quantity: '1.0000 XPR', memo: 'onda' } }] }, { blocksBehind: 3, expireSeconds: 60 })
await new Promise(r => setTimeout(r, 4000))
const b = (await bals())[0]
console.log(`   balance=${b.amount} raw   maxPerTick=${b.maxPerTick}  (= 178 x 2 x 8)`)
console.log('2. normal pull ->', await pull())
console.log('3. HOSTILE repricing: perSec 178 -> 5000 (a tick would be 10000 raw)')
await setRate(5000); await new Promise(r => setTimeout(r, 3000))
console.log('   pull at inflated rate ->', await pull())
console.log('4. restore perSec=178')
await setRate(178); await new Promise(r => setTimeout(r, 3000))
console.log('   pull after restore ->', await pull())
console.log('5. withdraw')
await owner.transact({ actions: [{ account: 'ondastream', name: 'withdraw',
  authorization: [{ actor: 'felixpaw', permission: 'active' }], data: { listener: 'felixpaw', token: TOKEN } }] }, { blocksBehind: 3, expireSeconds: 60 })
await new Promise(r => setTimeout(r, 4000))
console.log('   balances left:', (await bals()).length)
