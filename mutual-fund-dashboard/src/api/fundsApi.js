import { API_BASE_URL, REQUEST_TIMEOUT_MS } from './config'

/** A failed API call, carrying a message that is safe to show to a user. */
export class ApiError extends Error {
  constructor(message, { status = null, cause = null } = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.cause = cause
  }
}

function friendlyMessage(error) {
  if (error.name === 'AbortError' || error.name === 'TimeoutError') {
    return 'The request timed out. Is the scoring API still running?'
  }
  /* The browser deliberately gives JavaScript the same opaque TypeError for a
     refused connection and for a CORS rejection, so this cannot tell them
     apart -- name both causes rather than blame the wrong one. */
  const origin = typeof window === 'undefined' ? 'this page' : window.location.origin
  return (
    `Cannot reach the scoring API at ${API_BASE_URL}. Either the backend is not running, ` +
    `or it is not accepting requests from ${origin}.`
  )
}

async function request(path, { signal, method = 'GET', body } = {}) {
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal

  let response
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      signal: combined,
      method,
      headers: body
        ? { Accept: 'application/json', 'Content-Type': 'application/json' }
        : { Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
  } catch (error) {
    // A caller-driven abort (unmount, superseded request) is not a real failure:
    // rethrow it untouched so the caller can recognise and ignore it.
    if (signal?.aborted) throw error
    throw new ApiError(friendlyMessage(error), { cause: error })
  }

  if (!response.ok) {
    // The backend returns a JSON {"detail": "..."} on 4xx/5xx (FastAPI's
    // convention) -- surface that instead of the generic status line when present.
    let detail
    try {
      detail = (await response.json())?.detail
    } catch {
      /* not JSON -- fall through to the generic message below */
    }
    throw new ApiError(
      typeof detail === 'string' ? detail : `The scoring API returned ${response.status} ${response.statusText}.`,
      { status: response.status },
    )
  }

  try {
    return await response.json()
  } catch (error) {
    throw new ApiError('The scoring API returned a malformed response.', { cause: error })
  }
}

function getJson(path, options) {
  return request(path, options)
}

function postJson(path, body, options) {
  return request(path, { ...options, method: 'POST', body })
}

/**
 * The whole scored universe plus the metadata needed to render it:
 * `{ count, data, columns, groups, ratings, last_updated, next_refresh_at,
 *    last_error, source_mode }`.
 */
export function getFunds(options) {
  return getJson('/api/funds', options)
}

/** Cache/scheduler health, without the row payload. */
export function getStatus(options) {
  return getJson('/api/status', options)
}

/**
 * On-demand date-wise return for a set of schemes -- NOT part of the daily
 * cache, fetched live per scheme by the backend. `{ returns: { "<schcode>":
 * { return_pct, start_date, end_date } | null, ... } }`; a scheme with no
 * data in range (or a fetch failure) comes back null rather than failing the
 * whole request.
 */
export function postPointToPointReturns({ schcodes, startDate, endDate, months }, options) {
  return postJson(
    '/api/returns/point-to-point',
    { schcodes, start_date: startDate, end_date: endDate, months: months ?? null },
    options,
  )
}
