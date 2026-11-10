import 'dotenv/config'
import { serve } from '@hono/node-server'
import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import { Mppx, discovery } from 'mppx/hono'
import { Store, tempo } from 'mppx/server'
import { llmsTxt, PRICES } from './llms.js'
import * as tmdb from './tmdb.js'

// pathUSD TIP-20 token (same address on Tempo testnet and mainnet).
const PATHUSD = '0x20c0000000000000000000000000000000000000'
// Bridged USDC (USDC.e) on Tempo mainnet — the default balance token in Tempo wallets.
const USDCE = '0x20c000000000000000000000b9537d11c60e8b50'

const recipient = process.env.MPP_RECIPIENT as `0x${string}` | undefined
const secretKey = process.env.MPP_SECRET_KEY
const testnet = (process.env.MPP_TESTNET ?? 'true').toLowerCase() !== 'false'
const port = Number(process.env.PORT ?? 4242)
const publicUrl = (process.env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, '')

if (!recipient || !/^0x[0-9a-fA-F]{40}$/.test(recipient)) throw new Error('MPP_RECIPIENT must be a 0x wallet address')
if (!secretKey) throw new Error('MPP_SECRET_KEY is required (openssl rand -hex 32)')

const mppx = Mppx.create({
  methods: [
    // One charge offer per token; the 402 lists both and the payer picks one.
    // USDC.e only exists on mainnet, so testnet offers pathUSD alone.
    ...tempo.charge({
      currencies: testnet ? [PATHUSD] : [PATHUSD, USDCE],
      decimals: 6,
      recipient,
      testnet,
      // Single long-lived process (Railway) -> in-memory replay protection is fine.
      store: Store.memory(),
    }),
  ],
  secretKey,
})

const app = new Hono()
app.use('*', cors({ origin: '*', exposeHeaders: ['WWW-Authenticate', 'Payment-Receipt'] }))

// Wrap a TMDB call so errors become clean JSON.
const handle = (fn: (c: Context) => Promise<unknown>) => async (c: Context) => {
  try {
    const data = await fn(c)
    return c.json({ data, source: 'TMDB', attribution: 'This product uses the TMDB API but is not endorsed or certified by TMDB.' })
  } catch (err) {
    const status = err instanceof tmdb.HttpError ? err.status : 500
    console.error(err)
    return c.json({ error: err instanceof Error ? err.message : 'Internal error' }, status as 400)
  }
}

// Refuse BEFORE charging if the data source is not configured, so nobody pays for a 503.
app.use('/api/*', async (c, next) => {
  if (!process.env.TMDB_TOKEN) return c.json({ error: 'Service temporarily unavailable (data source not configured)' }, 503)
  await next()
})

// ---- Paid routes -----------------------------------------------------------
app.get(
  '/api/search',
  mppx.charge({ amount: PRICES.search, description: 'Search movies, TV shows and people (trending if no query)' }),
  handle((c) => tmdb.search(c.req.query('q'))),
)

app.get(
  '/api/title',
  mppx.charge({ amount: PRICES.title, description: 'Full movie/TV title data with cast, crew, genres and where to watch' }),
  handle((c) => tmdb.title({ q: c.req.query('q'), type: c.req.query('type'), id: c.req.query('id') })),
)

app.get(
  '/api/reviews',
  mppx.charge({ amount: PRICES.reviews, description: 'Audience reviews and scores for a movie or TV show' }),
  handle((c) =>
    tmdb.reviews({ q: c.req.query('q'), type: c.req.query('type'), id: c.req.query('id'), limit: c.req.query('limit') }),
  ),
)

app.get(
  '/api/person',
  mppx.charge({ amount: PRICES.person, description: 'Actor/person profile: biography and top filmography' }),
  handle((c) => tmdb.person({ q: c.req.query('q'), id: c.req.query('id') })),
)

// ---- Free routes -----------------------------------------------------------
app.get('/', (c) =>
  c.json({
    name: 'ScreenScout',
    description: 'Pay-per-request movie & TV data for agents: titles, cast, actors and reviews. No API key — pay with MPP.',
    network: testnet ? 'tempo-testnet' : 'tempo-mainnet',
    currencies: testnet ? ['pathUSD'] : ['pathUSD', 'USDC.e'],
    endpoints: Object.fromEntries(Object.entries(PRICES).map(([k, v]) => [`GET /api/${k}`, `$${v}`])),
    discovery: { openapi: `${publicUrl}/openapi.json`, llms: `${publicUrl}/llms.txt` },
  }),
)
app.get('/health', (c) => c.json({ ok: true }))
app.get('/llms.txt', (c) => c.text(llmsTxt(publicUrl, testnet)))

discovery(app, mppx, {
  auto: true,
  info: { title: 'ScreenScout — Movie & TV Data API', version: '1.0.0' },
  serviceInfo: {
    categories: ['media', 'entertainment', 'data'],
    docs: { homepage: publicUrl, llms: `${publicUrl}/llms.txt` },
  },
})

serve({ fetch: app.fetch, port }, () => {
  console.log(`ScreenScout listening on :${port} (${testnet ? 'TESTNET' : 'MAINNET'}) -> paying ${recipient}`)
})
