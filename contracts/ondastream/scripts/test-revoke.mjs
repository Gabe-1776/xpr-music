// Prove the cryptographic backstop: after unlinkauth the pull MUST fail even
// though the contract's grants row still says it may pull.
import { Api, JsonRpc, JsSignatureProvider } from '@proton/js'
import fs from 'fs'; import os from 'os'; import path from 'path'
const env = Object.fromEntries(fs.readFileSync(path.join(os.homedir(), '.openclaw/workspace/.env.xpr'), 'utf8')
  .split('\n').filter(l => l.includes('=') && !l.trim().startsWith('#'))
  .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]))
const w = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.xpr-testnet/wallets.json'), 'utf8'))
const rpc = new JsonRpc(['https://test.proton.eosusa.io'], { fetch })
const listenerApi = new Api({ rpc, signatureProvider: new JsSignatureProvider([env.XPR_PRIVATE_KEY]) })
const keeperApi = new Api({ rpc, signatureProvider: new JsSignatureProvider([w.accounts.xprmusic.private_key]) })
const songId = JSON.parse(fs.readFileSync(path.join(os.homedir(), 'Developer/xpr-music/app/catalog/songs.json'), 'utf8'))[0].id
const pull = async () => {
  try {
    await keeperApi.transact({ actions: [{ account: 'ondastream', name: 'pullpay',
      authorization: [{ actor: 'xprmusic', permission: 'active' }],
      data: { listener: 'felixpaw', songId } }] }, { blocksBehind: 3, expireSeconds: 60 })
    return 'SUCCEEDED'
  } catch (e) { return 'BLOCKED: ' + (e.message || String(e)).split('\n')[0].slice(0, 120) }
}
console.log('1. revoking on-chain (unlinkauth — the real backstop, not the soft table flag)')
await listenerApi.transact({ actions: [{ account: 'eosio', name: 'unlinkauth',
  authorization: [{ actor: 'felixpaw', permission: 'active' }],
  data: { account: 'felixpaw', code: 'eosio.token', type: 'transfer' } }] }, { blocksBehind: 3, expireSeconds: 60 })
await new Promise(r => setTimeout(r, 4000))
console.log('2. pull after revoke ->', await pull())
console.log('3. grants row still present?', (await rpc.get_table_rows({ json: true, code: 'ondastream', scope: 'ondastream', table: 'grants', limit: 5 })).rows.length > 0)
console.log('4. re-linking so the demo keeps working')
await listenerApi.transact({ actions: [{ account: 'eosio', name: 'linkauth',
  authorization: [{ actor: 'felixpaw', permission: 'active' }],
  data: { account: 'felixpaw', code: 'eosio.token', type: 'transfer', requirement: 'ondapull' } }] }, { blocksBehind: 3, expireSeconds: 60 })
await new Promise(r => setTimeout(r, 4000))
console.log('5. pull after re-link ->', await pull())
