// Prove the separation is real in BOTH directions: the new owner can toggle,
// and the contract's own key can no longer. If the second half succeeds, the
// split is cosmetic and freezing the contract later would be unsafe.
import { Api, JsonRpc, JsSignatureProvider } from '@proton/js'
import fs from 'fs'; import os from 'os'; import path from 'path'
const env = Object.fromEntries(fs.readFileSync(path.join(os.homedir(), '.openclaw/workspace/.env.xpr'), 'utf8')
  .split('\n').filter(l => l.includes('=') && !l.trim().startsWith('#'))
  .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]))
const w = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.xpr-testnet/wallets.json'), 'utf8'))
const rpc = new JsonRpc(['https://test.proton.eosusa.io'], { fetch })
const asOwner = new Api({ rpc, signatureProvider: new JsSignatureProvider([env.XPR_PRIVATE_KEY]) })
const asContract = new Api({ rpc, signatureProvider: new JsSignatureProvider([w.accounts.ondastream.private_key]) })
const setwindow = (api, actor) => api.transact({ actions: [{
  account: 'ondastream', name: 'setwindow',
  authorization: [{ actor, permission: 'active' }], data: { windowSec: 2 } }] },
  { blocksBehind: 3, expireSeconds: 60 })

try { const r = await setwindow(asOwner, 'felixpaw'); console.log('1. felixpaw (new owner) setwindow  -> OK', r.transaction_id.slice(0, 12)) }
catch (e) { console.log('1. felixpaw setwindow -> FAILED:', (e.message || '').split('\n')[0].slice(0, 110)) }
try { await setwindow(asContract, 'ondastream'); console.log('2. ondastream (contract key) setwindow -> SUCCEEDED  ** SPLIT IS COSMETIC **') }
catch (e) { console.log('2. ondastream (contract key) setwindow -> correctly BLOCKED:', (e.message || '').split('\n')[0].slice(0, 90)) }
