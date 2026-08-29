// Enroll xprmusic in XPR's free NET/CPU allocation.
// felixpaw's action goes FIRST so ONLY_BILL_FIRST_AUTHORIZER bills it for the
// whole tx — xprmusic has NET=0 and cannot pay for its own enrollment.
// NEVER stakexpr: proven no-op that eats funds.
import { Api, JsonRpc, JsSignatureProvider } from '@proton/js'
import fs from 'fs'
import os from 'os'
import path from 'path'

const TARGET = 'xprmusic'
const ENDPOINT = 'https://test.proton.eosusa.io'

const env = Object.fromEntries(
  fs.readFileSync(path.join(os.homedir(), '.openclaw/workspace/.env.xpr'), 'utf8')
    .split('\n').filter(l => l.includes('=') && !l.trim().startsWith('#'))
    .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
)
const FUNDER = env.XPR_ACCOUNT
const wallets = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.xpr-testnet/wallets.json'), 'utf8'))
const targetKey = wallets.accounts[TARGET].private_key

const rpc = new JsonRpc(ENDPOINT)
const api = new Api({ rpc, signatureProvider: new JsSignatureProvider([env.XPR_PRIVATE_KEY, targetKey]) })

const before = await rpc.get_account(TARGET)
console.log(`before: NET max=${before.net_limit.max} CPU max=${before.cpu_limit.max}`)
if (before.net_limit.max > 0) { console.log('already enrolled — nothing to do'); process.exit(0) }

const res = await api.transact({
  actions: [
    { // FIRST = pays bandwidth for the whole transaction
      account: 'eosio.token', name: 'transfer',
      authorization: [{ actor: FUNDER, permission: 'active' }],
      data: { from: FUNDER, to: TARGET, quantity: '0.0001 XPR', memo: 'newaccres bandwidth' }
    },
    {
      account: 'eosio.proton', name: 'newaccres',
      authorization: [{ actor: TARGET, permission: 'active' }],
      data: { account: TARGET }
    }
  ]
}, { blocksBehind: 3, expireSeconds: 60 })

console.log('tx:', res.transaction_id)
await new Promise(r => setTimeout(r, 4000))
const after = await rpc.get_account(TARGET)
console.log(`after:  NET max=${after.net_limit.max} CPU max=${after.cpu_limit.max}`)
console.log(after.net_limit.max > 0 ? 'ENROLLED' : 'STILL ZERO — investigate')
