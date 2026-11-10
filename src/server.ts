import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { serve } from '@hono/node-server'
import { Hono, type Context, type MiddlewareHandler } from 'hono'
import { cors } from 'hono/cors'
import { stream } from 'hono/streaming'
import { Mppx, discovery } from 'mppx/hono'
import { Store, tempo } from 'mppx/server'
import { runAgent } from './demo.js'
import { llmsTxt, PRICES } from './llms.js'
import * as tmdb from './tmdb.js'

// pathUSD TIP-20 token (same address on Tempo testnet and mainnet).
const PATHUSD = '0x20c0000000000000000000000000000000000000'
// Bridged USDC (USDC.e) on Tempo mainnet — the default balance token in Tempo wallets.
const USDCE = '0x20c000000000000000000000b9537d11c60e8b50'
const isAddress = (a?: string): a is `0x${string}` => !!a && /^0x[0-9a-fA-F]{40}$/.test(a)

const recipient = process.env.MPP_RECIPIENT
const secretKey = process.env.MPP_SECRET_KEY
const testnet = (process.env.MPP_TESTNET ?? 'true').toLowerCase() !== 'false'
const port = Number(process.env.PORT ?? 4242)
const publicUrl = (process.env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, '')
// Testnet-only wallet that receives the showcase's play-money payments. Never the mainnet wallet.
const sandboxRecipient = process.env.MPP_SANDBOX_RECIPIENT || (testnet ? recipient : undefined)

if (!isAddress(recipient)) throw new Error('MPP_RECIPIENT must be a 0x wallet address')
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

// Showcase sandbox: identical routes, always billed on Tempo testnet (faucet money).
const sandbox = isAddress(sandboxRecipient)
  ? Mppx.create({
      methods: [...tempo.charge({ currencies: [PATHUSD], decimals: 6, recipient: sandboxRecipient, testnet: true, store: Store.memory() })],
      secretKey,
      // The demo agent calls over loopback; name the public host as the realm, as a remote agent would see it.
      realm: new URL(publicUrl).host,
    })
  : null

const app = new Hono()
app.use('*', cors({ origin: '*', exposeHeaders: ['WWW-Authenticate', 'Payment-Receipt', 'Link'] }))
// Machine-discoverable pointers to the API description (RFC 8631 service-desc).
app.use('*', async (c, next) => {
  await next()
  c.header('Link', '</openapi.json>; rel="service-desc"; type="application/json", </llms.txt>; rel="describedby"; type="text/plain"')
})

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
const requireTmdb: MiddlewareHandler = async (c, next) => {
  if (!process.env.TMDB_TOKEN) return c.json({ error: 'Service temporarily unavailable (data source not configured)' }, 503)
  await next()
}
app.use('/api/*', requireTmdb)
app.use('/sandbox/api/*', requireTmdb)

// ---- Paid routes -----------------------------------------------------------
const ROUTES = {
  search: {
    description: 'Search movies, TV shows and people (trending if no query)',
    run: (c: Context) => tmdb.search(c.req.query('q')),
  },
  title: {
    description: 'Full movie/TV title data with cast, crew, genres and where to watch',
    run: (c: Context) => tmdb.title({ q: c.req.query('q'), type: c.req.query('type'), id: c.req.query('id') }),
  },
  reviews: {
    description: 'Audience reviews and scores for a movie or TV show',
    run: (c: Context) =>
      tmdb.reviews({ q: c.req.query('q'), type: c.req.query('type'), id: c.req.query('id'), limit: c.req.query('limit') }),
  },
  person: {
    description: 'Actor/person profile: biography and top filmography',
    run: (c: Context) => tmdb.person({ q: c.req.query('q'), id: c.req.query('id') }),
  },
} as const
type RouteName = keyof typeof ROUTES

const discoveryRoutes = []
for (const [name, r] of Object.entries(ROUTES) as [RouteName, (typeof ROUTES)[RouteName]][]) {
  const charge = mppx.charge({ amount: PRICES[name], description: r.description })
  app.get(`/api/${name}`, charge, handle(r.run))
  discoveryRoutes.push({ handler: charge, method: 'GET', path: `/api/${name}`, summary: r.description })
  if (sandbox) app.get(`/sandbox/api/${name}`, sandbox.charge({ amount: PRICES[name], description: r.description }), handle(r.run))
}

// ---- Showcase --------------------------------------------------------------
const page = () => readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
const wantsHtml = (c: Context) => (c.req.header('accept') ?? '').includes('text/html')

// Tiny per-IP limiter so the public demo can't be hammered.
const hits = new Map<string, number[]>()
const limited = (ip: string, max = 6, windowMs = 60_000) => {
  const now = Date.now()
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < windowMs)
  recent.push(now)
  hits.set(ip, recent)
  return recent.length > max
}

app.post('/demo/run', async (c) => {
  if (!sandbox) return c.json({ error: 'Showcase sandbox is not configured' }, 503)
  const ip = c.req.header('x-forwarded-for')?.split(',')[0].trim() || 'local'
  if (limited(ip)) return c.json({ error: 'Too many demo runs, try again in a minute' }, 429)
  const body = await c.req.json().catch(() => ({}))
  const endpoint = String(body.endpoint ?? 'title') as RouteName
  if (!(endpoint in ROUTES)) return c.json({ error: 'Unknown endpoint' }, 400)
  const q = String(body.q ?? '').slice(0, 80).trim()
  const params = new URLSearchParams()
  if (q) params.set('q', q)
  if (endpoint === 'reviews') params.set('limit', '4')
  const path = `/api/${endpoint}${params.size ? `?${params}` : ''}`

  c.header('Content-Type', 'application/x-ndjson')
  c.header('Cache-Control', 'no-store')
  return stream(c, async (s) => {
    try {
      await runAgent({
        localBase: `http://127.0.0.1:${port}`,
        publicBase: publicUrl,
        path,
        emit: async (step) => {
          await s.write(JSON.stringify(step) + '\n')
        },
      })
    } catch (err) {
      console.error(err)
      await s.write(JSON.stringify({ step: 'error', message: err instanceof Error ? err.message : String(err) }) + '\n')
    }
  })
})

app.get('/demo', (c) => c.html(page()))

// Decorative hero posters (trending today), cached for an hour so it costs almost nothing.
let posters: { at: number; list: string[] } | null = null
app.get('/demo/posters', async (c) => {
  if (!posters || Date.now() - posters.at > 3_600_000) {
    const t = await tmdb.search(undefined, 12).catch(() => null)
    posters = { at: Date.now(), list: (t?.results ?? []).map((r: any) => r.poster).filter(Boolean).slice(0, 4) }
  }
  return c.json(posters.list)
})

// ---- Free routes -----------------------------------------------------------
app.get('/', (c) => {
  if (wantsHtml(c)) return c.html(page())
  return c.json({
    name: 'ScreenScout',
    description: 'Pay-per-request movie & TV data for agents: titles, cast, actors and reviews. No API key — pay with MPP.',
    network: testnet ? 'tempo-testnet' : 'tempo-mainnet',
    currencies: testnet ? ['pathUSD'] : ['pathUSD', 'USDC.e'],
    endpoints: Object.fromEntries(Object.entries(PRICES).map(([k, v]) => [`GET /api/${k}`, `$${v}`])),
    discovery: { openapi: `${publicUrl}/openapi.json`, llms: `${publicUrl}/llms.txt` },
    showcase: `${publicUrl}/demo`,
  })
})
app.get('/health', (c) => c.json({ ok: true }))
app.get('/llms.txt', (c) => c.text(llmsTxt(publicUrl, testnet)))
app.get('/config.json', (c) =>
  c.json({
    network: testnet ? 'testnet' : 'mainnet',
    chainId: testnet ? 42431 : 4217,
    recipient,
    prices: PRICES,
    sandbox: Boolean(sandbox),
  }),
)

// Explicit routes so only the real (mainnet) paid operations are advertised, not the sandbox.
discovery(app, mppx, {
  routes: discoveryRoutes,
  info: { title: 'ScreenScout — Movie & TV Data API', version: '1.0.0' },
  serviceInfo: {
    categories: ['media', 'entertainment', 'data'],
    docs: { homepage: publicUrl, llms: `${publicUrl}/llms.txt` },
  },
})

serve({ fetch: app.fetch, port }, () => {
  console.log(
    `ScreenScout listening on :${port} (${testnet ? 'TESTNET' : 'MAINNET'}) -> paying ${recipient}` +
      (sandbox ? ` | showcase sandbox (testnet) -> ${sandboxRecipient}` : ' | showcase sandbox disabled'),
  )
})
