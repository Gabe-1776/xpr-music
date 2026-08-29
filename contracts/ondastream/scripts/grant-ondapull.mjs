// One-signature grant: replace the dead sigilsub link, create `ondapull`
// (authority = ondastream@eosio.code, parent active), scope it to ONLY
// eosio.token::transfer, and record the capped grant — atomically.
// NEVER add `waits` to an authority on this chain: the wait can never be
// satisfied and it permanently bricks the account (proven on sigildatasub).
import { Api, JsonRpc, JsSignatureProvider } from '@proton/js'
import fs from 'fs'; import os from 'os'; import path from 'path'
const env = Object.fromEntries(
  fs.readFileSync(path.join(os.homedir(), '.openclaw/workspace/.env.xpr'), 'utf8')
    .split('\n').filter(l => l.includes('=') && !l.trim().startsWith('#'))
    .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]))
const LISTENER = env.XPR_ACCOUNT, PERM = 'ondapull', CONTRACT = 'ondastream'
const MAX_PER_TICK = 4          // 0.0004 XPR — 2x one 2s window at rate 1/s
const BUDGET = 1000             // 0.1000 XPR total, ~16 min of listening
const rpc = new JsonRpc(['https://test.proton.eosusa.io'], { fetch })
const api = new Api({ rpc, signatureProvider: new JsSignatureProvider([env.XPR_PRIVATE_KEY]) })

const acct = await rpc.get_account(LISTENER)
const linked = []
for (const p of acct.permissions) for (const l of (p.linked_actions || []))
  if (l.account === 'eosio.token' && l.action === 'transfer') linked.push(p.perm_name)
console.log('existing eosio.token::transfer link ->', linked.length ? linked.join(',') : '(none)')

const actions = []
// linkauth is NOT idempotent and one (account,code,action) has ONE requirement,
// so an existing link must be removed before a different perm can claim it.
for (const pn of linked) if (pn !== PERM) actions.push({
  account: 'eosio', name: 'unlinkauth',
  authorization: [{ actor: LISTENER, permission: 'active' }],
  data: { account: LISTENER, code: 'eosio.token', type: 'transfer' } })
actions.push({
  account: 'eosio', name: 'updateauth',
  authorization: [{ actor: LISTENER, permission: 'active' }],
  data: { account: LISTENER, permission: PERM, parent: 'active', auth: {
    threshold: 1, keys: [], waits: [],
    accounts: [{ permission: { actor: CONTRACT, permission: 'eosio.code' }, weight: 1 }] } } })
if (!linked.includes(PERM)) actions.push({
  account: 'eosio', name: 'linkauth',
  authorization: [{ actor: LISTENER, permission: 'active' }],
  data: { account: LISTENER, code: 'eosio.token', type: 'transfer', requirement: PERM } })
actions.push({
  account: CONTRACT, name: 'grant',
  authorization: [{ actor: LISTENER, permission: 'active' }],
  data: { listener: LISTENER, perm: PERM, token: 'eosio.token',
          maxPerTick: MAX_PER_TICK, budget: BUDGET,
          expiresAt: Math.floor(Date.now() / 1000) + 7 * 24 * 3600 } })

const r = await api.transact({ actions }, { blocksBehind: 3, expireSeconds: 60 })
console.log('granted tx:', r.transaction_id)
await new Promise(r => setTimeout(r, 4000))
const after = await rpc.get_account(LISTENER)
const perm = after.permissions.find(p => p.perm_name === PERM)
console.log('perm     :', perm ? JSON.stringify(perm.required_auth.accounts) : 'MISSING')
console.log('linked   :', perm ? JSON.stringify(perm.linked_actions) : '-')
const rows = (await rpc.get_table_rows({ json: true, code: CONTRACT, scope: CONTRACT, table: 'grants', limit: 10 })).rows
console.log('grants   :', JSON.stringify(rows))
