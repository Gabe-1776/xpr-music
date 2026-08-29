// Move cfg.owner felixpaw -> ondaadmin, and rehome the scoped repricer
// permission onto ondaadmin so nothing project-related hangs off Gabriel's
// personal wallet. Fresh Api per signing set (reuse silently fails).
import { Api, JsonRpc, JsSignatureProvider, Key, Numeric } from '@proton/js'
import fs from 'fs'; import os from 'os'; import path from 'path'
const env = Object.fromEntries(fs.readFileSync(path.join(os.homedir(), '.openclaw/workspace/.env.xpr'), 'utf8')
  .split('\n').filter(l => l.includes('=') && !l.trim().startsWith('#'))
  .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]))
const ADMIN = 'ondaadmin', PERM = 'ondarates'
const rpc = new JsonRpc(['https://test.proton.eosusa.io'], { fetch })
const wp = path.join(os.homedir(), '.xpr-testnet/wallets.json')
const w = JSON.parse(fs.readFileSync(wp, 'utf8'))
const adminKey = w.accounts[ADMIN].private_key

// 1. hand over admin authority (signed by the CURRENT owner, felixpaw)
const asFelix = new Api({ rpc, signatureProvider: new JsSignatureProvider([env.XPR_PRIVATE_KEY]) })
console.log('1. setowner ->', ADMIN)
await asFelix.transact({ actions: [{ account: 'ondastream', name: 'setowner',
  authorization: [{ actor: 'felixpaw', permission: 'active' }], data: { owner: ADMIN } }] },
  { blocksBehind: 3, expireSeconds: 60 })

// 2. new scoped repricer key ON ondaadmin (fresh key — the old one was on felixpaw)
const kp = Key.generateKeyPair(Numeric.KeyType.k1, { secureEnv: true })
const pub = kp.publicKey.toString(), priv = kp.privateKey.toString()
w.accounts[`${ADMIN}@${PERM}`] = { public_key: pub, private_key: priv,
  purpose: `scoped hot key on ${ADMIN} — can ONLY call ondastream::settokrate (Onda price repricer, ONDA_PRICER_PRIVATE_KEY). Replaces felixpaw@ondarates so no project key lives on Gabriel's personal wallet.`,
  created: new Date().toISOString() }
w._updated = new Date().toISOString()
fs.writeFileSync(wp, JSON.stringify(w, null, 2) + '\n')   // save BEFORE broadcast
console.log('2. new scoped key saved:', pub)

const asAdmin = new Api({ rpc, signatureProvider: new JsSignatureProvider([adminKey]) })
await asAdmin.transact({ actions: [
  { account: 'eosio', name: 'updateauth', authorization: [{ actor: ADMIN, permission: 'active' }],
    data: { account: ADMIN, permission: PERM, parent: 'active',
            auth: { threshold: 1, keys: [{ key: pub, weight: 1 }], accounts: [], waits: [] } } },
  { account: 'eosio', name: 'linkauth', authorization: [{ actor: ADMIN, permission: 'active' }],
    data: { account: ADMIN, code: 'ondastream', type: 'settokrate', requirement: PERM } },
]}, { blocksBehind: 3, expireSeconds: 60 })
console.log('   ondarates created + linked on', ADMIN)

// 3. strip the permission off felixpaw entirely
const asFelix2 = new Api({ rpc, signatureProvider: new JsSignatureProvider([env.XPR_PRIVATE_KEY]) })
await asFelix2.transact({ actions: [
  { account: 'eosio', name: 'unlinkauth', authorization: [{ actor: 'felixpaw', permission: 'active' }],
    data: { account: 'felixpaw', code: 'ondastream', type: 'settokrate' } },
  { account: 'eosio', name: 'deleteauth', authorization: [{ actor: 'felixpaw', permission: 'active' }],
    data: { account: 'felixpaw', permission: PERM } },
]}, { blocksBehind: 3, expireSeconds: 60 })
console.log('3. removed ondarates from felixpaw')

await new Promise(r => setTimeout(r, 4000))
const cfg = (await rpc.get_table_rows({ json: true, code: 'ondastream', scope: 'ondastream', table: 'config', limit: 1 })).rows[0]
const fp = (await rpc.get_account('felixpaw')).permissions.map(p => p.perm_name)
const ad = (await rpc.get_account(ADMIN)).permissions.find(p => p.perm_name === PERM)
console.log('\ncfg.owner        :', cfg.owner)
console.log('felixpaw perms   :', fp.join(', '))
console.log('ondaadmin perm   :', ad ? `${ad.perm_name} linked=${JSON.stringify(ad.linked_actions)}` : 'MISSING')
