// THE test: keeper pulls straight from felixpaw's wallet to the artist.
// A pull-payment contract is NOT tested until a pull from a DIFFERENT account
// succeeds — self-payment passes even when the authority is wrong.
import { Api, JsonRpc, JsSignatureProvider } from '@proton/js'
import fs from 'fs'; import os from 'os'; import path from 'path'
const w = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.xpr-testnet/wallets.json'), 'utf8'))
const rpc = new JsonRpc(['https://test.proton.eosusa.io'], { fetch })
const api = new Api({ rpc, signatureProvider: new JsSignatureProvider([w.accounts.xprmusic.private_key]) })
const songs = JSON.parse(fs.readFileSync(path.join(os.homedir(), 'Developer/xpr-music/app/catalog/songs.json'), 'utf8'))
const songId = songs[0].id
const bal = async a => (await rpc.get_currency_balance('eosio.token', a, 'XPR'))[0]
const [l0, a0] = [await bal('felixpaw'), await bal('musictesting')]
console.log(`before  listener=${l0}  artist=${a0}`)
for (let i = 0; i < 3; i++) {
  try {
    const r = await api.transact({ actions: [{
      account: 'ondastream', name: 'pullpay',
      authorization: [{ actor: 'xprmusic', permission: 'active' }],
      data: { listener: 'felixpaw', songId }
    }]}, { blocksBehind: 3, expireSeconds: 60 })
    console.log(`pull ${i + 1}: OK ${r.transaction_id.slice(0, 16)}…`)
  } catch (e) { console.log(`pull ${i + 1}: FAIL ${(e.message || String(e)).split('\n')[0].slice(0, 160)}`) }
  if (i < 2) await new Promise(r => setTimeout(r, 2500))  // respect the 2s fuse
}
await new Promise(r => setTimeout(r, 4000))
const [l1, a1] = [await bal('felixpaw'), await bal('musictesting')]
console.log(`after   listener=${l1}  artist=${a1}`)
const g = (await rpc.get_table_rows({ json: true, code: 'ondastream', scope: 'ondastream', table: 'grants', limit: 5 })).rows[0]
console.log('grant  :', g ? `spent=${g.spent}/${g.budget} lastPull=${g.lastPull}` : 'none')
