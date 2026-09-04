// A scoped key is only worth having if the scope actually holds. Prove it can
// do its one job and is rejected everywhere else.
import { Api, JsonRpc, JsSignatureProvider } from '@proton/js'
import fs from 'fs'; import os from 'os'; import path from 'path'
const w = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.xpr-testnet/wallets.json'), 'utf8'))
const KEY = w.accounts['ondaadmin@ondarates'].private_key
const rpc = new JsonRpc(['https://test.proton.eosusa.io'], { fetch })
const api = new Api({ rpc, signatureProvider: new JsSignatureProvider([KEY]) })
const auth = [{ actor: 'ondaadmin', permission: 'ondarates' }]
const attempt = async (label, action) => {
  try { const r = await api.transact({ actions: [action] }, { blocksBehind: 3, expireSeconds: 60 })
    console.log(`${label} -> ALLOWED ${r.transaction_id.slice(0, 12)}`) }
  catch (e) { console.log(`${label} -> REJECTED: ${(e.message || String(e)).split('\n')[0].slice(0, 78)}`) }
}
await attempt('settokrate (its one job)  ', { account: 'ondastream', name: 'settokrate',
  authorization: auth, data: { token: 'eosio.token', sym: '4,XPR', perSec: 178, enabled: true } })
await attempt('setwindow  (other admin)  ', { account: 'ondastream', name: 'setwindow',
  authorization: auth, data: { windowSec: 2 } })
await attempt('setowner   (hand over)    ', { account: 'ondastream', name: 'setowner',
  authorization: auth, data: { owner: 'xprmusic' } })
await attempt('transfer   (steal funds)  ', { account: 'eosio.token', name: 'transfer',
  authorization: auth, data: { from: 'ondaadmin', to: 'xprmusic', quantity: '1.0000 XPR', memo: 'scope probe' } })
