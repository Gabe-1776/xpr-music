// Prove xprmusic can now self-pay a pulse. A contract assertion = bandwidth OK.
// A "net usage too high" = still broken.
import { Api, JsonRpc, JsSignatureProvider } from '@proton/js'
import fs from 'fs'; import os from 'os'; import path from 'path'
const wallets = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.xpr-testnet/wallets.json'), 'utf8'))
const rpc = new JsonRpc('https://test.proton.eosusa.io')
const api = new Api({ rpc, signatureProvider: new JsSignatureProvider([wallets.accounts.xprmusic.private_key]) })
try {
  const r = await api.transact({ actions: [{
    account: 'ondastream', name: 'pulse',
    authorization: [{ actor: 'xprmusic', permission: 'active' }],
    data: { listener: 'felixpaw', songId: 'nonexistent-probe' }
  }]}, { blocksBehind: 3, expireSeconds: 60 })
  console.log('unexpectedly succeeded:', r.transaction_id)
} catch (e) {
  const m = (e.message || String(e))
  const net = /net usage|billed|CPU usage/i.test(m)
  console.log(net ? 'STILL A RESOURCE ERROR:' : 'RESOURCE OK — reached contract logic:')
  console.log('  ', m.split('\n')[0].slice(0, 200))
}
