import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'

import { apply, normalizeWord } from '../index.js'

/** Mount the plugin on a fake Host context and return its route handler. */
function mount() {
  let handler
  const ctx = {
    effect(callback) {
      callback()
    },
    webServer: {
      register(route) {
        handler = route.handler
        return () => {}
      }
    },
    get() {
      return undefined
    }
  }
  apply(ctx)
  assert.equal(typeof handler, 'function')
  return handler
}

/** Invoke one route with a mock request. */
function call(handler, { method = 'GET', url = '/plugin/look-up/health', host = '127.0.0.1:43120', body = '' } = {}) {
  const req = Readable.from(body === '' ? [] : [Buffer.from(body)])
  req.method = method
  req.url = url
  req.headers = { host, 'content-type': 'application/json' }
  return new Promise((resolve) => {
    const res = {
      writeHead(status, headers) {
        this.status = status
        this.headers = headers
      },
      end(data) {
        resolve({ status: this.status, body: JSON.parse(String(data)) })
      }
    }
    handler(req, res)
  })
}

test('normalizeWord collapses whitespace and rejects unusable input', () => {
  assert.equal(normalizeWord('  look \n up '), 'look up')
  assert.equal(normalizeWord('学习'), '学习')
  assert.equal(normalizeWord(''), null)
  assert.equal(normalizeWord('   '), null)
  assert.equal(normalizeWord('a'.repeat(65)), null)
  assert.equal(normalizeWord('bad\u0000word'), null)
  assert.equal(normalizeWord(42), null)
  assert.equal(normalizeWord(null), null)
})

test('health reports the mounted plugin and the helper', async () => {
  const result = await call(mount())
  assert.equal(result.status, 200)
  assert.equal(result.body.plugin, 'dsh-plugin-look-up')
  assert.equal(result.body.ok, true)
  assert.ok(['ok', 'missing', 'unsupported'].includes(result.body.helper))
})

test('lookup returns full HTML entries with a native stylesheet', async () => {
  const result = await call(mount(), {
    method: 'POST',
    url: '/plugin/look-up/lookup',
    body: JSON.stringify({ word: 'serendipity' })
  })
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true)
  assert.ok(Array.isArray(result.body.entries) && result.body.entries.length >= 1)
  const entry = result.body.entries[0]
  assert.match(entry.html, /serendipity/u)
  assert.ok(entry.css.length > 1000, 'dictionary stylesheet should be included')
  assert.equal(typeof entry.dictionary, 'string')
})

test('lookup includes a Chinese dictionary entry for a Chinese word', async () => {
  const result = await call(mount(), {
    method: 'POST',
    url: '/plugin/look-up/lookup',
    body: JSON.stringify({ word: '学习' })
  })
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true)
  assert.ok(result.body.entries.length >= 1)
  assert.ok(result.body.entries.some((entry) => /学习/u.test(entry.html)))
})

test('lookup explains an unknown word instead of failing', async () => {
  const result = await call(mount(), {
    method: 'POST',
    url: '/plugin/look-up/lookup',
    body: JSON.stringify({ word: 'zzzznotawordzzzz' })
  })
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, false)
  assert.equal(result.body.code, 'no-entry')
})

test('lookup rejects an invalid word and a huge body', async () => {
  const handler = mount()
  const invalid = await call(handler, {
    method: 'POST',
    url: '/plugin/look-up/lookup',
    body: JSON.stringify({ word: '   ' })
  })
  assert.equal(invalid.status, 400)
  assert.equal(invalid.body.code, 'invalid-word')

  const huge = await call(handler, {
    method: 'POST',
    url: '/plugin/look-up/lookup',
    body: JSON.stringify({ word: 'a'.repeat(9000) })
  })
  assert.equal(huge.status, 413)
})

test('the route is loopback-only and method-checked', async () => {
  const handler = mount()
  const remote = await call(handler, { host: '192.168.1.10:43120' })
  assert.equal(remote.status, 403)
  assert.equal(remote.body.code, 'loopback-only')

  const wrongMethod = await call(handler, { url: '/plugin/look-up/lookup' })
  assert.equal(wrongMethod.status, 405)

  const missing = await call(handler, { url: '/plugin/look-up/nope' })
  assert.equal(missing.status, 404)
})
