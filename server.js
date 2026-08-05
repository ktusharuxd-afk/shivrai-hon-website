require('dotenv').config()
const express = require('express')
const cors = require('cors')
const axios = require('axios')
const cron = require('node-cron')
const { createClient } = require('@supabase/supabase-js')

const app = express()
app.use(cors())
app.use(express.json())

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const RPC_USER = process.env.RPC_USER || 'shivraiuser'
const RPC_PASS = process.env.RPC_PASS || 'HonPass2026'

// ══════════════════════════════════════
// DYNAMIC RPC URL — Supabase se read karto
// ══════════════════════════════════════
let RPC_URL = process.env.RPC_URL || 'http://localhost:8332'

async function refreshRpcUrl() {
  try {
    const { data } = await supabase
      .from('hon_config')
      .select('rpc_url')
      .eq('id', 1)
      .single()
    if (data?.rpc_url && data.rpc_url !== RPC_URL) {
      RPC_URL = data.rpc_url
      console.log('✅ RPC_URL updated:', RPC_URL)
    }
  } catch(e) {}
}

// Every 30 seconds refresh RPC URL from Supabase
setInterval(refreshRpcUrl, 30000)
refreshRpcUrl() // On startup

// ── RPC ──
async function rpc(method, params = []) {
  try {
    const res = await axios.post(RPC_URL, {
      jsonrpc: '1.0', id: 'web', method, params
    }, {
      auth: { username: RPC_USER, password: RPC_PASS },
      timeout: 10000
    })
    return { success: true, result: res.data.result }
  } catch (e) {
    return { success: false, error: e.message }
  }
}

// ── Auto-ping Supabase every 3 days ──
cron.schedule('0 0 */3 * *', async () => {
  try {
    await supabase.from('hon_ping').update({ last_ping: new Date().toISOString() }).eq('id', 1)
    console.log('✅ Supabase ping sent')
  } catch(e) {}
})

// Ping on startup
;(async () => {
  try { await supabase.from('hon_ping').update({ last_ping: new Date().toISOString() }).eq('id', 1) } catch(e) {}
  console.log('✅ Initial ping sent')
})()

// ══════════════════════════════════════
// ROUTES
// ══════════════════════════════════════

app.get('/', (req, res) => res.json({ status: 'SHIVRAI HON API', version: '2.0.0' }))

// Node Status
app.get('/api/node/status', async (req, res) => {
  try {
    const info = await rpc('getblockchaininfo')
    const net = await rpc('getnetworkinfo')
    if (info.success && info.result) {
      res.json({ online: true, blocks: info.result.blocks, connections: net.result?.connections || 0, difficulty: info.result.difficulty, chain: info.result.chain })
    } else {
      res.json({ online: false, error: info.error || 'Node offline' })
    }
  } catch(e) { res.json({ online: false, error: e.message }) }
})

// Explorer - Blocks
app.get('/api/blocks', async (req, res) => {
  try {
    const info = await rpc('getblockchaininfo')
    if (!info.success) return res.json([])
    const blocks = []
    let hash = info.result.bestblockhash
    for (let i = 0; i < 10 && hash; i++) {
      const block = await rpc('getblock', [hash])
      if (block.success) { blocks.push(block.result); hash = block.result.previousblockhash }
      else break
    }
    res.json(blocks)
  } catch(e) { res.json([]) }
})

app.get('/api/block/:hash', async (req, res) => {
  const block = await rpc('getblock', [req.params.hash])
  if (block.success) res.json(block.result)
  else res.status(404).json({ error: 'Block not found' })
})

app.get('/api/blockhash/:height', async (req, res) => {
  const hash = await rpc('getblockhash', [parseInt(req.params.height)])
  if (hash.success) res.json(hash.result)
  else res.status(404).json({ error: 'Not found' })
})

// Wallet Balance
app.get('/api/wallet/balance', async (req, res) => {
  const { address } = req.query
  if (!address) return res.status(400).json({ error: 'Address required' })
  await rpc('loadwallet', ['honwallet']).catch(() => {})
  const bal = await rpc('getreceivedbyaddress', [address, 1])
  res.json({ address, balance: bal.success ? parseFloat(bal.result || 0) : 0 })
})

// New Address
app.post('/api/wallet/new-address', async (req, res) => {
  const { user_id } = req.body
  if (!user_id) return res.status(400).json({ error: 'user_id required' })
  const { data: existing } = await supabase.from('hon_wallets').select('address').eq('user_id', user_id).single()
  if (existing) return res.json({ address: existing.address })
  await rpc('loadwallet', ['honwallet']).catch(() => {})
  const addr = await rpc('getnewaddress', ['', 'bech32'])
  if (!addr.success) return res.status(500).json({ error: 'Address generation failed' })
  await supabase.from('hon_wallets').insert({ user_id, address: addr.result })
  await supabase.from('hon_earnings').upsert({ user_id, amount: 0, blocks_mined: 0 }, { onConflict: 'user_id' })
  res.json({ address: addr.result })
})

// Mining Share
app.post('/api/mining/share', async (req, res) => {
  const { user_id, address } = req.body
  if (!user_id || !address) return res.status(400).json({ error: 'Missing fields' })
  await rpc('loadwallet', ['honwallet']).catch(() => {})
  const result = await rpc('generatetoaddress', [1, address])
  if (result.success) {
    // Get current earnings
    const { data: earnings } = await supabase.from('hon_earnings').select('*').eq('user_id', user_id).single()
    const newAmount = (earnings?.amount || 0) + 2000
    const newBlocks = (earnings?.blocks_mined || 0) + 1
    
    if (earnings) {
      // UPDATE existing row
      await supabase.from('hon_earnings')
        .update({ amount: newAmount, blocks_mined: newBlocks, updated_at: new Date().toISOString() })
        .eq('user_id', user_id)
    } else {
      // INSERT new row
      await supabase.from('hon_earnings')
        .insert({ user_id, amount: newAmount, blocks_mined: newBlocks, updated_at: new Date().toISOString() })
    }
    return res.json({ success: true, block_hash: result.result?.[0], reward: 2000, total_earned: newAmount, blocks_mined: newBlocks })
  }
  res.json({ success: false, error: result.error })
})

// Mining Stats
app.get('/api/mining/stats/:user_id', async (req, res) => {
  const { data } = await supabase.from('hon_earnings').select('*').eq('user_id', req.params.user_id).single()
  res.json({ total_earned: data?.amount || 0, blocks_mined: data?.blocks_mined || 0, block_reward: 2000 })
})

// Send HON
app.post('/api/wallet/send', async (req, res) => {
  const { to_address, amount } = req.body
  if (!to_address || !amount) return res.status(400).json({ error: 'Missing fields' })
  await rpc('loadwallet', ['honwallet']).catch(() => {})
  const result = await rpc('sendtoaddress', [to_address, parseFloat(amount)])
  if (result.success) res.json({ success: true, txid: result.result })
  else res.status(500).json({ success: false, error: result.error })
})

// Ping
app.get('/api/ping', async (req, res) => {
  const { data } = await supabase.from('hon_ping').select('last_ping').eq('id', 1).single()
  res.json({ status: 'ok', last_ping: data?.last_ping })
})

// Config - get current RPC URL (for debugging)
app.get('/api/config', async (req, res) => {
  res.json({ rpc_url: RPC_URL.replace(/:[^:@]+@/, ':***@') })
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`🚀 SHIVRAI HON API running on port ${PORT}`)
  console.log(`📡 RPC URL: ${RPC_URL}`)
})
