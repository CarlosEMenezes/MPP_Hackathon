// Live showcase agent. Runs the full MPP flow against ScreenScout's *testnet* sandbox routes
// (play money from the Tempo faucet) and reports each protocol step as it happens.
import { Mppx as MppxClient, tempo as tempoClient } from 'mppx/client'
import { createClient, http } from 'viem'
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import { waitForTransactionReceipt } from 'viem/actions'
import { Actions } from 'viem/tempo'
import { tempoModerato } from 'viem/tempo/chains'

const PATHUSD = '0x20c0000000000000000000000000000000000000'
const EXPLORER = 'https://explore.testnet.tempo.xyz'
const chain = createClient({ chain: tempoModerato, transport: http() })

export type Step = { step: string; at: number; [k: string]: unknown }

// ---- one shared, faucet-funded payer wallet per process ------------------------------
let payer: PrivateKeyAccount | null = null
let funding: Promise<PrivateKeyAccount> | null = null

async function balanceOf(address: `0x${string}`) {
  const b = await Actions.token.getBalance(chain, { account: address, token: PATHUSD }).catch(() => undefined)
  return b?.amount ?? 0n
}

async function fund(account: PrivateKeyAccount) {
  const hashes = await Actions.faucet.fund(chain, { account })
  await Promise.all(hashes.map((hash) => waitForTransactionReceipt(chain, { hash })))
  // RPC balance reads can lag the faucet receipt; wait until the funds are visible.
  for (let i = 0; i < 20 && (await balanceOf(account.address)) === 0n; i++) await new Promise((r) => setTimeout(r, 500))
}

async function getPayer(): Promise<{ account: PrivateKeyAccount; funded: boolean }> {
  if (payer && (await balanceOf(payer.address)) > 1_000_000n) return { account: payer, funded: false }
  funding ??= (async () => {
    const account = payer ?? privateKeyToAccount(generatePrivateKey())
    await fund(account)
    payer = account
    return account
  })().finally(() => (funding = null))
  return { account: await funding, funded: true }
}

// ---- helpers ---------------------------------------------------------------------------
const b64urlJson = (s: string) => {
  try {
    return JSON.parse(Buffer.from(s, 'base64url').toString('utf8'))
  } catch {
    return null
  }
}

/** Parse every `Payment ...` challenge out of a WWW-Authenticate header. */
export function parseChallenges(header: string | null) {
  if (!header) return []
  return header
    .split(/,\s*(?=Payment\s)/)
    .map((part) => {
      const params: Record<string, string> = {}
      for (const m of part.matchAll(/(\w+)="([^"]*)"/g)) params[m[1]] = m[2]
      const request = params.request ? b64urlJson(params.request) : null
      return {
        id: params.id,
        realm: params.realm,
        method: params.method,
        intent: params.intent,
        description: params.description,
        expires: params.expires,
        request,
      }
    })
    .filter((c) => c.method)
}

// ---- the agent run ---------------------------------------------------------------------
export async function runAgent(opts: {
  localBase: string // where we actually call (self, over loopback)
  publicBase: string // what we display
  path: string // e.g. /api/title?q=dune
  emit: (s: Step) => void | Promise<void>
}) {
  const t0 = Date.now()
  const emit = (step: string, data: Record<string, unknown> = {}) => opts.emit({ step, at: Date.now() - t0, ...data })
  const local = opts.localBase + '/sandbox' + opts.path
  const shown = opts.publicBase + '/sandbox' + opts.path

  // 1. Ask for the resource, no payment.
  await emit('request', { method: 'GET', url: shown })
  const first = await fetch(local)
  const challenges = parseChallenges(first.headers.get('www-authenticate'))
  // 2. Server answers 402 with a challenge naming the price.
  await emit('challenge', {
    status: first.status,
    statusText: first.statusText,
    header: (first.headers.get('www-authenticate') ?? '').slice(0, 160) + '…',
    challenges,
  })
  if (first.status !== 402) throw new Error(`Expected 402, got ${first.status}`)

  // 3. Pay with a testnet wallet, then retry with the credential.
  await emit('wallet', { note: 'Preparing a faucet-funded Tempo testnet wallet' })
  const { account, funded } = await getPayer()
  await emit('wallet', { address: account.address, funded, balance: Number(await balanceOf(account.address)) / 1e6 })

  let credential: string | null = null
  const recordingFetch: typeof fetch = async (input, init) => {
    const auth = new Headers(init?.headers).get('authorization')
    if (auth?.startsWith('Payment ')) {
      credential = auth
      await emit('credential', { header: auth.slice(0, 96) + '…', length: auth.length })
    }
    return fetch(input, init)
  }
  const client = MppxClient.create({ methods: [...tempoClient({ account })], polyfill: false, fetch: recordingFetch })
  await emit('paying', { amount: challenges[0]?.request?.amount, currency: challenges[0]?.request?.currency })
  const paid = await client.fetch(local)
  const receiptHeader = paid.headers.get('payment-receipt')
  const receipt = receiptHeader ? b64urlJson(receiptHeader) : null
  const body = await paid.json().catch(() => null)

  // 4. Result + receipt.
  await emit('receipt', {
    status: paid.status,
    receipt,
    explorer: receipt?.reference ? `${EXPLORER}/receipt/${receipt.reference}` : null,
    credentialSent: Boolean(credential),
  })
  await emit('result', { status: paid.status, body })
  await emit('done', { ms: Date.now() - t0 })
}
