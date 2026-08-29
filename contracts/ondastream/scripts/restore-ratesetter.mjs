// Repoint ondarates back at the key we actually hold. Signed by felixpaw@active,
// which is the whole reason the escalation is survivable.
import { Api, JsonRpc, JsSignatureProvider } from '@proton/js'
import fs from 'fs'; import os from 'os'; import path from 'path'
const env = Object.fromEntries(fs.readFileSync(path.join(os.homedir(), '.openclaw/workspace/.env.xpr'), 'utf8')
  .split('\n').filter(l => l.includes('=') && !l.trim().startsWith('#'))
  .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]))
const w = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.xpr-testnet/wallets.json'), 'utf8'))
const pub = w.accounts['felixpaw@ondarates'].public_key
const rpc = new JsonRpc(['https://test.proton.eosusa.io'], { fetch })
const api = new Api({ rpc, signatureProvider: new JsSignatureProvider([env.XPR_PRIVATE_KEY]) })
const r = await api.transact({ actions: [{ account: 'eosio', name: 'updateauth',
  authorization: [{ actor: 'felixpaw', permission: 'active' }],
  data: { account: 'felixpaw', permission: 'ondarates', parent: 'active',
          auth: { threshold: 1, keys: [{ key: pub, weight: 1 }], accounts: [], waits: [] } } }] },
  { blocksBehind: 3, expireSeconds: 60 })
console.log('restored tx:', r.transaction_id)
await new Promise(r => setTimeout(r, 4000))
const p = (await rpc.get_account('felixpaw')).permissions.find(x => x.perm_name === 'ondarates')
console.log('ondarates key now:', p.required_auth.keys[0].key)
console.log('matches our saved key:', p.required_auth.keys[0].key === pub)
console.log('still linked to     :', JSON.stringify(p.linked_actions))
