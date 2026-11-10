// Minimal TMDB client + normalizers. Data source: The Movie Database (TMDB).
// This product uses the TMDB API but is not endorsed or certified by TMDB.

const BASE = 'https://api.themoviedb.org/3'
const IMG = 'https://image.tmdb.org/t/p/w500'

export type MediaType = 'movie' | 'tv'

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

async function tmdbGet<T = any>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
  const token = process.env.TMDB_TOKEN
  if (!token) throw new HttpError(503, 'TMDB_TOKEN is not configured on the server')
  const url = new URL(BASE + path)
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') url.searchParams.set(k, String(v))
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } })
  if (res.status === 404) throw new HttpError(404, 'Not found on TMDB')
  if (!res.ok) throw new HttpError(502, `TMDB error ${res.status}`)
  return res.json() as Promise<T>
}

const img = (p?: string | null) => (p ? IMG + p : null)
const year = (d?: string) => (d ? Number(d.slice(0, 4)) || null : null)
const trim = (s: string, n: number) => (s.length > n ? s.slice(0, n).trimEnd() + '…' : s)

function summarizeResult(r: any) {
  const type = r.media_type ?? (r.title ? 'movie' : r.name && r.known_for_department ? 'person' : 'tv')
  if (type === 'person') {
    return {
      type,
      id: r.id,
      name: r.name,
      department: r.known_for_department ?? null,
      profile: img(r.profile_path),
      known_for: (r.known_for ?? []).map((k: any) => k.title ?? k.name).slice(0, 3),
    }
  }
  return {
    type,
    id: r.id,
    title: r.title ?? r.name,
    year: year(r.release_date ?? r.first_air_date),
    rating: r.vote_average ? Math.round(r.vote_average * 10) / 10 : null,
    votes: r.vote_count ?? 0,
    overview: r.overview ? trim(r.overview, 280) : null,
    poster: img(r.poster_path),
  }
}

export async function search(q?: string, limit = 10) {
  const data = q
    ? await tmdbGet('/search/multi', { query: q, include_adult: 'false' })
    : await tmdbGet('/trending/all/day')
  return {
    query: q ?? null,
    mode: q ? 'search' : 'trending',
    results: (data.results ?? []).slice(0, limit).map(summarizeResult),
  }
}

/** Resolve a title either by explicit type+id or by free-text query (best match). */
async function resolveTitle(opts: { q?: string; type?: string; id?: string }): Promise<{ type: MediaType; id: number }> {
  if (opts.id) {
    const type: MediaType = opts.type === 'tv' ? 'tv' : 'movie'
    const id = Number(opts.id)
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'id must be a positive integer')
    return { type, id }
  }
  const q = opts.q || 'Inception'
  const kind = opts.type === 'tv' ? '/search/tv' : opts.type === 'movie' ? '/search/movie' : '/search/multi'
  const data = await tmdbGet(kind, { query: q, include_adult: 'false' })
  const hit = (data.results ?? []).find((r: any) => (r.media_type ?? (opts.type || 'movie')) !== 'person')
  if (!hit) throw new HttpError(404, `No movie or TV title matched "${q}"`)
  return { type: (hit.media_type ?? opts.type ?? 'movie') as MediaType, id: hit.id }
}

export async function title(opts: { q?: string; type?: string; id?: string }) {
  const { type, id } = await resolveTitle(opts)
  const d = await tmdbGet(`/${type}/${id}`, {
    append_to_response: `${type === 'tv' ? 'aggregate_credits' : 'credits'},external_ids,watch/providers,release_dates`,
  })
  const credits = type === 'tv' ? d.aggregate_credits : d.credits
  const cast = (credits?.cast ?? []).slice(0, 10).map((c: any) => ({
    id: c.id,
    name: c.name,
    character: c.character ?? c.roles?.[0]?.character ?? null,
    profile: img(c.profile_path),
  }))
  const directors =
    type === 'movie'
      ? (credits?.crew ?? []).filter((c: any) => c.job === 'Director').map((c: any) => c.name)
      : (d.created_by ?? []).map((c: any) => c.name)
  const us = d['watch/providers']?.results?.US
  return {
    type,
    id,
    imdb_id: d.external_ids?.imdb_id ?? d.imdb_id ?? null,
    title: d.title ?? d.name,
    original_title: d.original_title ?? d.original_name,
    tagline: d.tagline || null,
    overview: d.overview || null,
    year: year(d.release_date ?? d.first_air_date),
    release_date: d.release_date ?? d.first_air_date ?? null,
    status: d.status ?? null,
    runtime_minutes: d.runtime ?? d.episode_run_time?.[0] ?? null,
    seasons: d.number_of_seasons ?? undefined,
    episodes: d.number_of_episodes ?? undefined,
    genres: (d.genres ?? []).map((g: any) => g.name),
    languages: (d.spoken_languages ?? []).map((l: any) => l.english_name),
    countries: (d.production_countries ?? []).map((c: any) => c.name),
    rating: { tmdb: d.vote_average ? Math.round(d.vote_average * 10) / 10 : null, votes: d.vote_count ?? 0 },
    budget_usd: d.budget || undefined,
    revenue_usd: d.revenue || undefined,
    [type === 'movie' ? 'directors' : 'creators']: directors,
    cast,
    where_to_watch_us: us
      ? {
          stream: (us.flatrate ?? []).map((p: any) => p.provider_name),
          rent: (us.rent ?? []).map((p: any) => p.provider_name),
          buy: (us.buy ?? []).map((p: any) => p.provider_name),
        }
      : null,
    poster: img(d.poster_path),
    backdrop: img(d.backdrop_path),
  }
}

export async function reviews(opts: { q?: string; type?: string; id?: string; limit?: string }) {
  const { type, id } = await resolveTitle(opts)
  const limit = Math.min(Math.max(Number(opts.limit) || 5, 1), 20)
  const [d, r] = await Promise.all([tmdbGet(`/${type}/${id}`), tmdbGet(`/${type}/${id}/reviews`)])
  const list = (r.results ?? []).slice(0, limit).map((x: any) => ({
    author: x.author_details?.username || x.author,
    rating: x.author_details?.rating ?? null,
    date: x.created_at?.slice(0, 10) ?? null,
    excerpt: trim(String(x.content ?? '').replace(/\s+/g, ' '), 1200),
    url: x.url,
  }))
  const rated = list.filter((x: any) => typeof x.rating === 'number')
  return {
    type,
    id,
    title: d.title ?? d.name,
    year: year(d.release_date ?? d.first_air_date),
    audience_score: { tmdb: d.vote_average ? Math.round(d.vote_average * 10) / 10 : null, votes: d.vote_count ?? 0 },
    reviewer_average: rated.length ? Math.round((rated.reduce((s: number, x: any) => s + x.rating, 0) / rated.length) * 10) / 10 : null,
    total_reviews: r.total_results ?? list.length,
    reviews: list,
  }
}

export async function person(opts: { q?: string; id?: string }) {
  let id: number
  if (opts.id) {
    id = Number(opts.id)
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'id must be a positive integer')
  } else {
    const q = opts.q || 'Cillian Murphy'
    const s = await tmdbGet('/search/person', { query: q, include_adult: 'false' })
    if (!s.results?.length) throw new HttpError(404, `No person matched "${q}"`)
    id = s.results[0].id
  }
  const p = await tmdbGet(`/person/${id}`, { append_to_response: 'combined_credits,external_ids' })
  const credits = [...(p.combined_credits?.cast ?? [])]
    .filter((c: any) => c.media_type === 'movie' || (c.episode_count ?? 0) >= 3)
    .sort((a: any, b: any) => (b.vote_count ?? 0) - (a.vote_count ?? 0))
  const seen = new Set<string>()
  const filmography = credits
    .filter((c: any) => {
      const k = `${c.media_type}:${c.id}`
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
    .slice(0, 15)
    .map((c: any) => ({
      type: c.media_type,
      id: c.id,
      title: c.title ?? c.name,
      year: year(c.release_date ?? c.first_air_date),
      character: c.character || null,
      rating: c.vote_average ? Math.round(c.vote_average * 10) / 10 : null,
    }))
  return {
    id,
    imdb_id: p.external_ids?.imdb_id ?? p.imdb_id ?? null,
    name: p.name,
    also_known_as: (p.also_known_as ?? []).slice(0, 5),
    known_for_department: p.known_for_department ?? null,
    birthday: p.birthday ?? null,
    deathday: p.deathday ?? null,
    place_of_birth: p.place_of_birth ?? null,
    biography: p.biography ? trim(p.biography, 1500) : null,
    profile: img(p.profile_path),
    credit_count: p.combined_credits?.cast?.length ?? 0,
    top_credits: filmography,
  }
}
