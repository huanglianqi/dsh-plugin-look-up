/**
 * dsh-plugin-look-up — Host half.
 *
 * The browser half owns the interaction; this half owns the only privileged
 * step: asking macOS for full dictionary entries. `bin/dsh-lookup-dict` is a
 * small signed universal helper that renders one entry through
 * DictionaryServices (the same content macOS Dictionary shows), including the
 * dictionary's own stylesheet. The Host never needs network access,
 * accessibility permission, or an Apple Events grant.
 *
 * One helper process performs one dictionary lookup: the private markup API is
 * not stable when several dictionaries are queried in one process, so the Host
 * fans out to a few dictionary-specific helpers in parallel and merges them.
 *
 * Routes (loopback only, same-origin JSON):
 *   GET  /plugin/look-up/health          → mount, platform and helper status
 *   POST /plugin/look-up/lookup {word}   → { ok, word, entries[] } | { ok:false, code }
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
const HELPER_TIMEOUT_MS = 8000
const MAX_HELPER_BUFFER = 8 * 1024 * 1024
const MAX_ENTRIES = 6
const MAX_HTML_BYTES = 2 * 1024 * 1024
const MAX_CSS_BYTES = 512 * 1024
const CACHE_BUDGET_BYTES = 24 * 1024 * 1024

/** Dictionary name fragments queried in addition to the system default. */
const LATIN_FILTERS = ['牛津英汉', 'New Oxford American', 'Oxford Dictionary of English']
const CJK_FILTERS = ['现代汉语规范', '牛津英汉', '商務新詞典']

/** In-memory definition cache, bounded by total bytes as entries are large. */
const cache = new Map()
let cacheBytes = 0

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
  const namePart = host.split(':')[0]
  return namePart === '127.0.0.1' || namePart === 'localhost'
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

/** Store one result in the definition cache, evicting the oldest entries. */
function remember(word, value) {
  const bytes = Buffer.byteLength(JSON.stringify(value))
  if (bytes > 4 * 1024 * 1024) return
  const previous = cache.get(word)
  if (previous !== undefined) cacheBytes -= previous.bytes
  cache.set(word, { value, bytes })
  cacheBytes += bytes
  while (cacheBytes > CACHE_BUDGET_BYTES && cache.size > 1) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    const entry = cache.get(oldest)
    if (entry !== undefined) cacheBytes -= entry.bytes
    cache.delete(oldest)
  }
}

/** `latin`, `cjk`, or `other`, used to choose which dictionaries to ask. */
function scriptOf(word) {
  if (/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/u.test(word)) return 'cjk'
  if (/[A-Za-z\u00c0-\u024f]/u.test(word)) return 'latin'
  return 'other'
}

/**
 * Run one helper process: the system default entry or one named dictionary.
 * @param word - a normalized word.
 * @param filter - dictionary name fragment, or null for the system default.
 * @returns the parsed helper payload, or null when it failed or missed.
 */
async function runHelper(word, filter) {
  const args = filter === null ? [word, '--entries'] : [word, '--dictionary', filter]
  try {
    const { stdout } = await execFileAsync(HELPER_PATH, args, {
      timeout: HELPER_TIMEOUT_MS,
      maxBuffer: MAX_HELPER_BUFFER,
      encoding: 'utf8',
      windowsHide: true
    })
    const parsed = JSON.parse(stdout.trim())
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    // A helper that cannot find the dictionary exits 0 with an empty list; a
    // crash or timeout only loses this one perspective.
    return null
  }
}

/** Validate and bound one helper entry. */
function normalizeEntry(entry, isDefault) {
  if (entry === null || typeof entry !== 'object' || typeof entry.html !== 'string') return null
  if (entry.html.length === 0 || entry.html.length > MAX_HTML_BYTES) return null
  return {
    dictionary: typeof entry.dictionary === 'string' ? entry.dictionary : '',
    shortName: typeof entry.shortName === 'string' ? entry.shortName : '',
    title: typeof entry.title === 'string' ? entry.title : '',
    id: typeof entry.id === 'string' ? entry.id : '',
    html: entry.html,
    css: typeof entry.css === 'string' ? entry.css.slice(0, MAX_CSS_BYTES) : '',
    default: isDefault
  }
}

/** Merge entries by dictionary entry id, preferring a named duplicate over `System default`. */
function mergeEntries(entries) {
  const merged = new Map()
  for (const entry of entries) {
    const key = entry.id !== '' ? entry.id : `${entry.dictionary}\u0000${entry.title}`
    const previous = merged.get(key)
    if (previous === undefined) {
      merged.set(key, entry)
      continue
    }
    const keepDefault = previous.default || entry.default
    const preferred = previous.default && !entry.default ? entry : previous
    merged.set(key, { ...preferred, default: keepDefault })
  }
  return [...merged.values()].slice(0, MAX_ENTRIES)
}

/**
 * Ask the macOS helper(s) for one word.
 * @param word - a normalized word.
 * @returns a client-facing result object.
 */
async function lookupWord(word) {
  const cached = cache.get(word)
  if (cached !== undefined) return cached.value

  if (process.platform !== 'darwin') return { ok: false, code: 'unsupported', word }
  if (helperStatus() !== 'ok') return { ok: false, code: 'helper-missing', word }

  const script = scriptOf(word)
  const filters = script === 'latin' ? LATIN_FILTERS : script === 'cjk' ? CJK_FILTERS : []
  const payloads = await Promise.all([runHelper(word, null), ...filters.map((filter) => runHelper(word, filter))])

  const entries = []
  for (const payload of payloads) {
    if (payload === null || payload.ok !== true || !Array.isArray(payload.entries)) continue
    const isDefault = payload.default === true
    for (const raw of payload.entries) {
      const entry = normalizeEntry(raw, isDefault)
      if (entry !== null) entries.push(entry)
    }
  }

  if (entries.length === 0) return { ok: false, code: 'no-entry', word }
  const result = {
    ok: true,
    word,
    entries: mergeEntries(entries),
    source: 'DictionaryServices'
  }
  remember(word, result)
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
    await execFileAsync('/usr/bin/open', [`dict://${encodeURIComponent(word)}`], {
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
      helperVersion: 4,
      cacheEntries: cache.size,
      cacheBytes,
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
