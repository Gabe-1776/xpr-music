import { readFileSync } from 'node:fs'; import { homedir } from 'node:os'
import { Api, JsonRpc, JsSignatureProvider } from '@proton/js'
const w = JSON.parse(readFileSync(`${homedir()}/.xpr-testnet/wallets.json`, 'utf8'))
const rpc = new JsonRpc(['https://test.proton.eosusa.io'], { fetch })
const rows = (await rpc.get_table_rows({ json: true, code: 'ondastream', scope: 'ondastream', table: 'songs', limit: 300 })).rows
const probes = rows.filter(r => r.artist === 'musictesting' && r.songId.startsWith('zz-ram-probe-') && r.active)
if (!probes.length) { console.log('no active probe rows'); process.exit(0) }
const api = new Api({ rpc, signatureProvider: new JsSignatureProvider([w.accounts.musictesting.private_key]) })
const r = await api.transact({ actions: probes.map(p => ({
  account: 'ondastream', name: 'pausesong',
  authorization: [{ actor: 'musictesting', permission: 'active' }],
  data: { artist: 'musictesting', songId: p.songId } })) }, { blocksBehind: 3, expireSeconds: 60 })
console.log('deactivated', probes.map(p => p.songId).join(', '), r.transaction_id)
