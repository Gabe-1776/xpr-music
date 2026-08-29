// Create a hot key that can do EXACTLY ONE thing: ondastream::settokrate.
// The repricer runs on a web server, so it must never hold felixpaw@active
// (which owns the catalog and can move funds) nor the ondastream key (which can
// setcode). Same shape as sigil-data's proven `collector` permission.
import { Api, JsonRpc, JsSignatureProvider, Key, Numeric } from '@proton/js'
import fs from 'fs'; import os from 'os'; import path from 'path'
const env = Object.fromEntries(fs.readFileSync(path.join(os.homedir(), '.openclaw/workspace/.env.xpr'), 'utf8')
  .split('\n').filter(l => l.includes('=') && !l.trim().startsWith('#'))
  .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]))
const ACCOUNT = env.XPR_ACCOUNT, PERM = 'ondarates'
const rpc = new JsonRpc(['https://test.proton.eosusa.io'], { fetch })
const api = new Api({ rpc, signatureProvider: new JsSignatureProvider([env.XPR_PRIVATE_KEY]) })

const acct = await rpc.get_account(ACCOUNT)
const existing = acct.permissions.find(p => p.perm_name === PERM)
const linked = (existing?.linked_actions || []).some(l => l.account === 'ondastream' && l.action === 'settokrate')

const kp = Key.generateKeyPair(Numeric.KeyType.k1, { secureEnv: true })
const pub = kp.publicKey.toString(), priv = kp.privateKey.toString()

const actions = [{
  account: 'eosio', name: 'updateauth',
  authorization: [{ actor: ACCOUNT, permission: 'active' }],
  data: { account: ACCOUNT, permission: PERM, parent: 'active',
          auth: { threshold: 1, keys: [{ key: pub, weight: 1 }], accounts: [], waits: [] } },
}]
// linkauth is NOT idempotent — re-linking an identical requirement is rejected.
if (!linked) actions.push({
  account: 'eosio', name: 'linkauth',
  authorization: [{ actor: ACCOUNT, permission: 'active' }],
  data: { account: ACCOUNT, code: 'ondastream', type: 'settokrate', requirement: PERM },
})
const r = await api.transact({ actions }, { blocksBehind: 3, expireSeconds: 60 })
console.log('tx:', r.transaction_id)

const wp = path.join(os.homedir(), '.xpr-testnet/wallets.json')
const w = JSON.parse(fs.readFileSync(wp, 'utf8'))
w.accounts[`${ACCOUNT}@${PERM}`] = {
  public_key: pub, private_key: priv, purpose:
    'scoped hot key on felixpaw — can ONLY call ondastream::settokrate (the Onda price repricer, ONDA_PRICER_PRIVATE_KEY). Cannot move funds, cannot setcode, cannot touch other admin actions.',
  created: new Date().toISOString(),
}
w._updated = new Date().toISOString()
fs.writeFileSync(wp, JSON.stringify(w, null, 2) + '\n')

await new Promise(r => setTimeout(r, 4000))
const after = await rpc.get_account(ACCOUNT)
const p = after.permissions.find(x => x.perm_name === PERM)
console.log('perm    :', p ? `${p.perm_name} <- ${p.parent}` : 'MISSING')
console.log('linked  :', JSON.stringify(p?.linked_actions || []))
console.log('pubkey  :', pub)
console.log('saved to wallets.json as', `${ACCOUNT}@${PERM}`)
