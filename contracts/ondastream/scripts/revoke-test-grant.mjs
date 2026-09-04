// The player UI still opens a lock, but the keeper routes to `pullpay` whenever
// a grant exists — which would charge the listener twice. Retire the test grant
// until the UI knows about modes. Re-grant with grant-ondapull.mjs.
import { Api, JsonRpc, JsSignatureProvider } from '@proton/js'
import fs from 'fs'; import os from 'os'; import path from 'path'
const env = Object.fromEntries(fs.readFileSync(path.join(os.homedir(), '.openclaw/workspace/.env.xpr'), 'utf8')
  .split('\n').filter(l => l.includes('=') && !l.trim().startsWith('#'))
  .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]))
const rpc = new JsonRpc(['https://test.proton.eosusa.io'], { fetch })
const api = new Api({ rpc, signatureProvider: new JsSignatureProvider([env.XPR_PRIVATE_KEY]) })
const r = await api.transact({ actions: [
  { account: 'ondastream', name: 'revoke',
    authorization: [{ actor: 'felixpaw', permission: 'active' }], data: { listener: 'felixpaw' } },
  // Also drop the chain-level link, so nothing can pull even if a row reappears.
  { account: 'eosio', name: 'unlinkauth',
    authorization: [{ actor: 'felixpaw', permission: 'active' }],
    data: { account: 'felixpaw', code: 'eosio.token', type: 'transfer' } },
]}, { blocksBehind: 3, expireSeconds: 60 })
console.log('revoked tx:', r.transaction_id)
await new Promise(r => setTimeout(r, 4000))
const rows = (await rpc.get_table_rows({ json: true, code: 'ondastream', scope: 'ondastream', table: 'grants', limit: 5 })).rows
const acct = await rpc.get_account('felixpaw')
const perm = acct.permissions.find(p => p.perm_name === 'ondapull')
console.log('grants rows      :', rows.length)
console.log('ondapull linked  :', perm ? JSON.stringify(perm.linked_actions || []) : 'perm gone')
