// Create `ondaadmin` — a purpose-built admin account so the project stops being
// managed from Gabriel's personal wallet.
//
// RULE (paid for on mainnet): save the generated private key to disk BEFORE
// broadcasting anything. If a later step throws after the account exists but
// before the key is persisted, the account is real, on-chain, and unusable.
// RULE: a fresh Api per transact when the signing-key set changes — reusing one
// silently fails with "does not have signatures for it".
import { Api, JsonRpc, JsSignatureProvider, Key, Numeric } from '@proton/js'
import fs from 'fs'; import os from 'os'; import path from 'path'
const NAME = 'ondaadmin'
const env = Object.fromEntries(fs.readFileSync(path.join(os.homedir(), '.openclaw/workspace/.env.xpr'), 'utf8')
  .split('\n').filter(l => l.includes('=') && !l.trim().startsWith('#'))
  .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]))
const CREATOR = env.XPR_ACCOUNT
const rpc = new JsonRpc(['https://test.proton.eosusa.io'], { fetch })

try { await rpc.get_account(NAME); console.log(`${NAME} already exists — nothing to do`); process.exit(0) } catch {}

const kp = Key.generateKeyPair(Numeric.KeyType.k1, { secureEnv: true })
const pub = kp.publicKey.toString(), priv = kp.privateKey.toString()

// ---- persist BEFORE broadcasting ----
const wp = path.join(os.homedir(), '.xpr-testnet/wallets.json')
const w = JSON.parse(fs.readFileSync(wp, 'utf8'))
w.accounts[NAME] = { public_key: pub, private_key: priv,
  purpose: 'Onda project ADMIN account. cfg.owner of the ondastream contract — owns setrate/setwindow/setkeeper/setpaused/settokrate/setowner. Exists so the project is not administered from felixpaw (Gabriel personal wallet). Hosts the ondarates scoped repricer permission.',
  created: new Date().toISOString() }
w._updated = new Date().toISOString()
fs.writeFileSync(wp, JSON.stringify(w, null, 2) + '\n')
console.log('key saved to wallets.json BEFORE broadcast:', pub)

const auth = { threshold: 1, keys: [{ key: pub, weight: 1 }], accounts: [], waits: [] }
const creatorApi = new Api({ rpc, signatureProvider: new JsSignatureProvider([env.XPR_PRIVATE_KEY]) })
const r1 = await creatorApi.transact({ actions: [
  { account: 'eosio', name: 'newaccount', authorization: [{ actor: CREATOR, permission: 'active' }],
    data: { creator: CREATOR, name: NAME, owner: auth, active: auth } },
  { account: 'eosio', name: 'buyrambytes', authorization: [{ actor: CREATOR, permission: 'active' }],
    data: { payer: CREATOR, receiver: NAME, bytes: 4000 } },
]}, { blocksBehind: 3, expireSeconds: 60 })
console.log('created tx:', r1.transaction_id)

// Fresh Api — different signing set (needs the NEW account's key too).
await new Promise(r => setTimeout(r, 3000))
const bothApi = new Api({ rpc, signatureProvider: new JsSignatureProvider([env.XPR_PRIVATE_KEY, priv]) })
const r2 = await bothApi.transact({ actions: [
  // Creator first: ONLY_BILL_FIRST_AUTHORIZER pays, since a raw newaccount has no bandwidth.
  { account: 'eosio.token', name: 'transfer', authorization: [{ actor: CREATOR, permission: 'active' }],
    data: { from: CREATOR, to: NAME, quantity: '0.0001 XPR', memo: 'newaccres bandwidth' } },
  { account: 'eosio.proton', name: 'newaccres', authorization: [{ actor: NAME, permission: 'active' }],
    data: { account: NAME } },
]}, { blocksBehind: 3, expireSeconds: 60 })
console.log('newaccres tx:', r2.transaction_id)

await new Promise(r => setTimeout(r, 4000))
const a = await rpc.get_account(NAME)
console.log(`${NAME}: NET=${a.net_limit.max} CPU=${a.cpu_limit.max} RAM free=${a.ram_quota - a.ram_usage}`)
