// Measure the true RAM cost of one songs row paid by musictesting, so the
// buyrambytes amount is measured, not guessed (RAM here is steeply priced).
import { Api, JsonRpc, JsSignatureProvider } from '@proton/js'
import fs from 'fs'; import os from 'os'; import path from 'path'
const w = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.xpr-testnet/wallets.json'), 'utf8'))
const rpc = new JsonRpc('https://test.proton.eosusa.io')
const api = new Api({ rpc, signatureProvider: new JsSignatureProvider([w.accounts.musictesting.private_key]) })
const usage = async () => (await rpc.get_account('musictesting')).ram_usage
const before = await usage()
const probeId = 'zz-ram-probe-' + Date.now().toString(36)
const r = await api.transact({ actions: [{
  account: 'ondastream', name: 'setsong',
  authorization: [{ actor: 'musictesting', permission: 'active' }],
  data: { artist: 'musictesting', songId: probeId, payout: 'musictesting' }
}]}, { blocksBehind: 3, expireSeconds: 60 })
await new Promise(r => setTimeout(r, 4000))
const after = await usage()
console.log('probe id     :', probeId)
console.log('tx           :', r.transaction_id)
console.log('ram before   :', before)
console.log('ram after    :', after)
console.log('bytes/row    :', after - before)
console.log('34 rows need :', (after - before) * 34, 'bytes')
