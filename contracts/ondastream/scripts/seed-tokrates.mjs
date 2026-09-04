// Seed the payable-token table. Contract+symbol is the identity — `xtokens`
// hosts BOTH XUSDC and METAL, so the contract name alone is ambiguous.
// XPR/XUSDC keep their live values so nothing Gabriel has tested changes;
// the three new tokens are priced off XUSDC's $0.00005/sec anchor.
import { Api, JsonRpc, JsSignatureProvider } from '@proton/js'
import fs from 'fs'; import os from 'os'; import path from 'path'
const w = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.xpr-testnet/wallets.json'), 'utf8'))
const rpc = new JsonRpc(['https://test.proton.eosusa.io'], { fetch })
// cfg.owner is still `ondastream` itself, so the contract key signs settokrate.
const api = new Api({ rpc, signatureProvider: new JsSignatureProvider([w.accounts.ondastream.private_key]) })
const TOKENS = [
  { contract: 'eosio.token', sym: '4,XPR',     perSec: 1,     note: 'live value, unchanged' },
  { contract: 'xtokens',     sym: '6,XUSDC',   perSec: 50,    note: 'live value, unchanged ($0.00005/s)' },
  { contract: 'loan.token',  sym: '4,LOAN',    perSec: 1282,  note: '$0.00005/s @ $0.00039' },
  { contract: 'xtokens',     sym: '8,METAL',   perSec: 50000, note: '$0.00005/s @ $0.10' },
  { contract: 'xmd.token',   sym: '6,XMD',     perSec: 50,    note: '$0.00005/s @ $1 (stable)' },
]
for (const t of TOKENS) {
  const r = await api.transact({ actions: [{
    account: 'ondastream', name: 'settokrate',
    authorization: [{ actor: 'ondastream', permission: 'active' }],
    data: { token: t.contract, sym: t.sym, perSec: t.perSec, enabled: true },
  }] }, { blocksBehind: 3, expireSeconds: 60 })
  console.log(`${t.sym.padEnd(10)} @ ${t.contract.padEnd(12)} perSec=${String(t.perSec).padStart(6)}  ${t.note}`)
}
await new Promise(r => setTimeout(r, 4000))
const rows = (await rpc.get_table_rows({ json: true, code: 'ondastream', scope: 'ondastream', table: 'tokrates', limit: 20 })).rows
console.log('\non-chain tokrates:', rows.length)
for (const r of rows) console.log(' ', r.tokenContract, 'symRaw=' + r.symRaw, 'perSec=' + r.perSec, 'enabled=' + r.enabled)
