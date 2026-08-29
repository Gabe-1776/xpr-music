// The scary case: can the scoped key modify its OWN permission to widen itself?
// EOSIO's updateauth does require_auth2(account, permission) — so reasoning
// alone is not enough here. Test it.
import { Api, JsonRpc, JsSignatureProvider, Key, Numeric } from '@proton/js'
import fs from 'fs'; import os from 'os'; import path from 'path'
const w = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.xpr-testnet/wallets.json'), 'utf8'))
const api = new Api({ rpc: new JsonRpc(['https://test.proton.eosusa.io'], { fetch }),
  signatureProvider: new JsSignatureProvider([w.accounts['felixpaw@ondarates'].private_key]) })
const attacker = Key.generateKeyPair(Numeric.KeyType.k1, { secureEnv: true }).publicKey.toString()
const auth = [{ actor: 'felixpaw', permission: 'ondarates' }]
const attempt = async (label, action) => {
  try { const r = await api.transact({ actions: [action] }, { blocksBehind: 3, expireSeconds: 60 })
    console.log(`${label} -> ALLOWED ${r.transaction_id.slice(0,12)}  ** ESCALATION **`) }
  catch (e) { console.log(`${label} -> BLOCKED: ${(e.message||String(e)).split('\n')[0].slice(0,72)}`) }
}
// 1. widen ondarates itself (add an attacker key)
await attempt('updateauth ondarates (self-widen)', { account: 'eosio', name: 'updateauth', authorization: auth,
  data: { account: 'felixpaw', permission: 'ondarates', parent: 'active',
          auth: { threshold: 1, keys: [{ key: attacker, weight: 1 }], accounts: [], waits: [] } } })
// 2. take over active outright
await attempt('updateauth active    (takeover) ', { account: 'eosio', name: 'updateauth', authorization: auth,
  data: { account: 'felixpaw', permission: 'active', parent: 'owner',
          auth: { threshold: 1, keys: [{ key: attacker, weight: 1 }], accounts: [], waits: [] } } })
// 3. link itself to a money action
await attempt('linkauth transfer    (grab pay)', { account: 'eosio', name: 'linkauth', authorization: auth,
  data: { account: 'felixpaw', code: 'eosio.token', type: 'transfer', requirement: 'ondarates' } })
