// Buy exactly the measured RAM musictesting needs for 34 song rows (+margin),
// paid by felixpaw. Reports real XPR cost — RAM pricing here is far steeper
// than naive formulas predict, so verify rather than assume.
import { Api, JsonRpc, JsSignatureProvider } from '@proton/js'
import fs from 'fs'; import os from 'os'; import path from 'path'
const env = Object.fromEntries(
  fs.readFileSync(path.join(os.homedir(), '.openclaw/workspace/.env.xpr'), 'utf8')
    .split('\n').filter(l => l.includes('=') && !l.trim().startsWith('#'))
    .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]))
const FUNDER = env.XPR_ACCOUNT, TARGET = 'musictesting'
const NEED = 34 * 159, MARGIN = 2000
const rpc = new JsonRpc('https://test.proton.eosusa.io')
const api = new Api({ rpc, signatureProvider: new JsSignatureProvider([env.XPR_PRIVATE_KEY]) })
const acct = await rpc.get_account(TARGET)
const free = acct.ram_quota - acct.ram_usage
const bytes = Math.max(0, NEED + MARGIN - free)
console.log(`free=${free} need=${NEED} -> buying ${bytes} bytes`)
if (!bytes) { console.log('enough already'); process.exit(0) }
const bal = async () => (await rpc.get_currency_balance('eosio.token', FUNDER, 'XPR'))[0]
const b4 = await bal()
const r = await api.transact({ actions: [{
  account: 'eosio', name: 'buyrambytes',
  authorization: [{ actor: FUNDER, permission: 'active' }],
  data: { payer: FUNDER, receiver: TARGET, bytes }
}]}, { blocksBehind: 3, expireSeconds: 60 })
await new Promise(r => setTimeout(r, 4000))
const a2 = await rpc.get_account(TARGET)
console.log('tx:', r.transaction_id)
console.log(`ram free: ${free} -> ${a2.ram_quota - a2.ram_usage}`)
console.log(`funder XPR: ${b4} -> ${await bal()}`)
