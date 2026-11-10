// Prices in USD stablecoin units (pathUSD or USDC.e, 1 ≈ 1 USD).
export const PRICES = {
  search: '0.01',
  title: '0.02',
  reviews: '0.02',
  person: '0.01',
} as const

export const llmsTxt = (base: string, testnet: boolean) => `# ScreenScout

> Pay-per-request movie & TV data for AI agents: title details, cast & crew, actor profiles and audience reviews. No signup and no API key: every paid endpoint answers HTTP 402 with an MPP payment challenge, you pay, retry with the credential, and get JSON plus a Payment-Receipt header.

Payment: Machine Payments Protocol (MPP), Tempo ${testnet ? 'testnet (Moderato, test funds only), currency pathUSD' : 'mainnet, pay in pathUSD or USDC.e (either one; same price)'}.
Discovery: ${base}/openapi.json (x-payment-info on each paid operation)
Data source: TMDB (This product uses the TMDB API but is not endorsed or certified by TMDB.)

## Paid endpoints (GET)

- [Search](${base}/api/search?q=dune): $${PRICES.search} per request. \`q\` = free text; omit for today's trending movies, shows and people.
- [Title](${base}/api/title?q=dune): $${PRICES.title} per request. Full details, genres, runtime, rating, top-10 cast with characters, directors/creators, US streaming/rent/buy providers. Use \`q\`, or \`type=movie|tv\` + \`id\` (TMDB id).
- [Reviews](${base}/api/reviews?q=dune&limit=5): $${PRICES.reviews} per request. Audience score, reviewer average and review excerpts. Same params as Title plus \`limit\` (1-20).
- [Person](${base}/api/person?q=zendaya): $${PRICES.person} per request. Actor biography, birthday, birthplace and top filmography. Use \`q\` (name) or \`id\`.

## Example

\`\`\`
npx mppx ${base}/api/title?q=the+bear${testnet ? ' --network testnet' : ''}
tempo request ${base}/api/person?q=zendaya${testnet ? ' --network testnet' : ''}
\`\`\`

## Free

- ${base}/ : service summary
- ${base}/openapi.json : OpenAPI 3.1 with prices
- ${base}/health : health check
`
