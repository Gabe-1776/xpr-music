// Measure real outbound HTTP from the keeper. @proton/js binds `cross-fetch`
// at import time, so globalThis.fetch is NOT the boundary — patch cross-fetch
// itself, before the keeper (and thus @proton/js) is ever loaded.
import fs from 'fs'; import os from 'os'; import path from 'path'
import { createRequire } from 'node:module'
// MUST resolve from app/ — it has its own node_modules, so the copy under
// contracts/ is a different module instance and patching it sees nothing.
const require = createRequire(path.join(os.homedir(), 'Developer/xpr-music/app/x.js'))

const hits = []
const cf = require('cross-fetch')
const real = cf.default || cf
const wrapped = (...a) => { hits.push(Date.now()); return real(...a) }
if (cf.default) cf.default = wrapped
require.cache[require.resolve('cross-fetch')].exports = cf.default ? cf : wrapped

const w = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.xpr-testnet/wallets.json'), 'utf8'))
process.env.ONDA_KEEPER_ACCOUNT = 'xprmusic'
process.env.ONDA_KEEPER_PRIVATE_KEY = w.accounts.xprmusic.private_key
process.env.ONDA_KEEPER_RPC = 'https://test.proton.eosusa.io'

const keeper = require('./onda-pulse.js')

const live = ['felixpaw', 'musictesting', 'felixpawbot', 'vulcanwallet', 'sigildattst2']
  .map(a => ({ actor: a, songId: 'deep-devotion-f9013a' }))

const t0 = Date.now()
keeper.start(() => live, () => {})
await new Promise(r => setTimeout(r, 14000))
const elapsed = (Date.now() - t0) / 1000
for (const t of keeper._rpcLog) hits.push(t)
let worst = 0
for (const h of hits) worst = Math.max(worst, hits.filter(x => x >= h && x < h + 1000).length)
console.log(`listeners       : ${live.length}`)
console.log(`total HTTP calls: ${hits.length} over ${elapsed.toFixed(1)}s`)
console.log(`average         : ${(hits.length / elapsed).toFixed(2)} /sec`)
console.log(`worst 1s window : ${worst}`)
console.log(hits.length === 0 ? 'INSTRUMENT STILL BLIND — do not trust' : (worst <= 1 ? 'PASS — never exceeded 1 RPC/sec' : 'FAIL'))
process.exit(0)
