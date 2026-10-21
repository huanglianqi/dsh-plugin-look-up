/**
 * dsh-plugin-look-up — Host half.
 *
 * The browser half owns the interaction; this half owns the only privileged
 * step: asking macOS for a definition. `bin/dsh-lookup-dict` is a small signed
 * universal helper that calls DictionaryServices' `DCSCopyTextDefinition`, the
 * same local dictionary data macOS Look Up reads. The Host never needs network
 * access, accessibility permission, or an Apple Events grant.
 *
 * Routes (loopback only, same-origin JSON):
 *   GET  /plugin/look-up/health          → mount, platform and helper status
 *   POST /plugin/look-up/lookup {word}   → { ok, word, definition } | { ok:false, code }
 *   POST /plugin/look-up/open   {word}   → open the word in Dictionary.app
 */

import { execFile } from 'node:child_process'
import { accessSync, constants, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

/** Cordis plugin name. */
export const name = 'look-up'

/** Required Host service: the route registry. */
export const inject = ['webServer']

/** Package name; also the Client bundle row id. */
export const PLUGIN_ID = 'dsh-plugin-look-up'

/** Route prefix owned by this plugin. */
export const ROUTE_PREFIX = '/plugin/look-up'

const execFileAsync = promisify(execFile)
const MANIFEST = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
const HELPER_PATH = fileURLToPath(new URL('./bin/dsh-lookup-dict', import.meta.url))
const MAX_WORD_LENGTH = 64
const MAX_BODY_BYTES = 8 * 1024
const MAX_CACHE_ENTRIES = 256
const HELPER_TIMEOUT_MS = 5000

/** In-memory definition cache; definitions are immutable for a given word. */
const cache = new Map()

/** Whether the packaged helper exists and is executable. */
function helperStatus() {
  if (process.platform !== 'darwin') return 'unsupported'
  try {
    accessSync(HELPER_PATH, constants.X_OK)
    return 'ok'
  } catch {
    return 'missing'
  }
}

/**
 * Whether the request arrived on a loopback Host.
 * @param req - the incoming request.
 * @returns true for 127.0.0.1, localhost, or [::1].
 */
export function loopbackHost(req) {
  const host = req.headers.host
  if (typeof host !== 'string' || host === '') return false
  if (host.startsWith('[')) return host.startsWith('[::1]')
  const name = host.split(':')[0]
  return name === '127.0.0.1' || name === 'localhost'
}

/**
 * Normalize one user-supplied word.
 * @param input - untrusted JSON value.
 * @returns the normalized word, or null when it is not usable.
 */
export function normalizeWord(input) {
  if (typeof input !== 'string') return null
  const word = input.replace(/\s+/gu, ' ').trim()
  if (word.length === 0 || word.length > MAX_WORD_LENGTH) return null
  // Control characters are never part of a dictionary headword and would only
  // make it into process arguments or the Dictionary URL.
  if (/[\u0000-\u001f\u007f]/u.test(word)) return null
  return word
}

/** Write one JSON response. */
function sendJson(res, status, payload) {
  const body = Buffer.from(`${JSON.stringify(payload)}\n`)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.byteLength),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  })
  res.end(body)
}

/**
 * Read a bounded JSON request body.
 * @param req - the incoming request.
 * @returns the parsed JSON object (an empty object for an empty body).
 */
async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('body-too-large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('body-invalid')
  return parsed
}

/** Store one result in the definition cache, evicting the oldest entry. */
function remember(word, value) {
  cache.set(word, value)
  if (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
}

/**
 * Ask the macOS helper for one definition.
 * @param word - a normalized word.
 * @returns a client-facing result object.
 */
async function lookupWord(word) {
  const cached = cache.get(word)
  if (cached !== undefined) return cached

  if (process.platform !== 'darwin') return { ok: false, code: 'unsupported', word }
  if (helperStatus() !== 'ok') return { ok: false, code: 'helper-missing', word }

  let stdout
  try {
    const result = await execFileAsync(HELPER_PATH, [word], {
      timeout: HELPER_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
      windowsHide: true
    })
    stdout = result.stdout
  } catch (error) {
    if (error?.code === 'ETIMEDOUT' || error?.killed === true) return { ok: false, code: 'timeout', word }
    // The helper reports "no entry" as JSON with exit code 0, so a thrown
    // error here means the process itself failed. Some spawn errors still
    // carry usable stdout, but we do not trust partial output.
    return { ok: false, code: 'helper-failed', word }
  }

  let parsed
  try {
    parsed = JSON.parse(stdout.trim())
  } catch {
    return { ok: false, code: 'helper-failed', word }
  }

  const result = parsed.ok === true
    ? { ok: true, word, definition: String(parsed.definition ?? ''), source: 'DictionaryServices' }
    : { ok: false, code: typeof parsed.error === 'string' ? parsed.error : 'no-entry', word }
  if (result.ok) remember(word, result)
  return result
}

/**
 * Open one word in Dictionary.app through its registered `dict:` URL scheme.
 * @param word - a normalized word.
 * @returns a client-facing result object.
 */
async function openInDictionary(word) {
  if (process.platform !== 'darwin') return { ok: false, code: 'unsupported' }
  try {
    await execFileAsync('/usr/bin/open', ['-g', `dict://${encodeURIComponent(word)}`], {
      timeout: HELPER_TIMEOUT_MS,
      encoding: 'utf8'
    })
    return { ok: true }
  } catch {
    return { ok: false, code: 'open-failed' }
  }
}

/**
 * Dispatch one request under the plugin's route prefix.
 * @param ctx - the Host plugin context.
 * @param req - the incoming request.
 * @param res - the response to write.
 */
async function serve(ctx, req, res) {
  if (!loopbackHost(req)) {
    sendJson(res, 403, { ok: false, code: 'loopback-only' })
    return
  }

  const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname

  if (pathname === `${ROUTE_PREFIX}/health`) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { ok: false, code: 'method-not-allowed' })
      return
    }
    const clientModules = typeof ctx.get === 'function' ? ctx.get('clientModules') : undefined
    const clientBundle = clientModules !== undefined && typeof clientModules.clientPath === 'function'
      ? clientModules.clientPath(PLUGIN_ID)
      : undefined
    sendJson(res, 200, {
      ok: true,
      plugin: PLUGIN_ID,
      version: MANIFEST.version,
      platform: process.platform,
      helper: helperStatus(),
      cacheEntries: cache.size,
      clientRegistered: clientBundle !== undefined,
      clientBundle: clientBundle ?? null
    })
    return
  }

  if (pathname !== `${ROUTE_PREFIX}/lookup` && pathname !== `${ROUTE_PREFIX}/open`) {
    sendJson(res, 404, { ok: false, code: 'not-found' })
    return
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, code: 'method-not-allowed' })
    return
  }

  let body
  try {
    body = await readJson(req)
  } catch (error) {
    sendJson(res, error instanceof Error && error.message === 'body-too-large' ? 413 : 400, {
      ok: false,
      code: error instanceof Error ? error.message : 'body-invalid'
    })
    return
  }

  const word = normalizeWord(body.word)
  if (word === null) {
    sendJson(res, 400, { ok: false, code: 'invalid-word' })
    return
  }

  const result = pathname === `${ROUTE_PREFIX}/lookup`
    ? await lookupWord(word)
    : await openInDictionary(word)
  sendJson(res, 200, result)
}

/**
 * Register the plugin's routes for the lifetime of its Loader row.
 * @param ctx - the Host plugin context carrying `webServer`.
 */
export function apply(ctx) {
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: (req, res) => {
        void serve(ctx, req, res)
      }
    }),
    'look-up: routes'
  )
}
