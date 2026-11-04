/**
 * CPA base URL normalization.
 *
 * The preferred input is a plain origin such as `http://127.0.0.1:8317`. A
 * path prefix is kept (`/proxy` → `/proxy/v1`), and a trailing `/v1` or
 * `/backend-api` is recognized and stripped first. Query, fragment, and
 * embedded credentials are rejected rather than silently dropped.
 */

/** `client_version` sent to `/v1/models`; any value makes CPA answer with its rich Codex catalog. */
export const CLIENT_VERSION = 'dsh'

export interface CpaEndpoints {
  /** Normalized root, without `/v1`; equal inputs compare equal. */
  root: string
  /** OpenAI Responses base; the SDK appends `/responses`. */
  inferenceBaseUrl: string
  /** Catalog endpoint, `{root}/v1/models?client_version=dsh`. */
  modelsUrl: string
}

export function resolveEndpoints(input: string): CpaEndpoints {
  let raw = input.trim()
  if (!raw) throw new Error('CPA base URL is empty')
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `http://${raw}`

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`invalid CPA base URL: ${input}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`CPA base URL must use http or https: ${input}`)
  }
  if (url.search || url.hash) {
    throw new Error(`CPA base URL must not contain a query or fragment: ${input}`)
  }
  if (url.username || url.password) {
    throw new Error('CPA base URL must not embed credentials; store the API key with /cpa-key instead')
  }

  let path = url.pathname.replace(/\/+$/, '')
  if (path.endsWith('/backend-api')) path = path.slice(0, -'/backend-api'.length)
  else if (path.endsWith('/v1')) path = path.slice(0, -'/v1'.length)
  const root = `${url.origin}${path}`

  return {
    root,
    inferenceBaseUrl: `${root}/v1`,
    modelsUrl: `${root}/v1/models?client_version=${encodeURIComponent(CLIENT_VERSION)}`,
  }
}
