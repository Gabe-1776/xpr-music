// Move admin authority OFF the contract account.
// Every admin action (setrate/setwindow/setkeeper/setpaused/settokrate/setowner)
// authorizes against cfg.owner, so once owner lives elsewhere the contract
// account's keys can eventually be destroyed — code frozen, toggles still live.
// Owner becomes felixpaw: Gabriel's own wallet, NOT on any server.
import { Api, JsonRpc, JsSignatureProvider } from '@proton/js'
import fs from 'fs'; import os from 'os'; import path from 'path'
const w = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.xpr-testnet/wallets.json'), 'utf8'))
const rpc = new JsonRpc(['https://test.proton.eosusa.io'], { fetch })
// Signed by the CURRENT owner, which is still `ondastream` itself.
const api = new Api({ rpc, signatureProvider: new JsSignatureProvider([w.accounts.ondastream.private_key]) })
const cfg = async () => (await rpc.get_table_rows({ json: true, code: 'ondastream', scope: 'ondastream', table: 'config', limit: 1 })).rows[0]
console.log('before:', JSON.stringify(await cfg()))
const r = await api.transact({ actions: [{
  account: 'ondastream', name: 'setowner',
  authorization: [{ actor: 'ondastream', permission: 'active' }],
  data: { owner: 'felixpaw' },
}]}, { blocksBehind: 3, expireSeconds: 60 })
console.log('tx:', r.transaction_id)
await new Promise(r => setTimeout(r, 4000))
console.log('after :', JSON.stringify(await cfg()))
