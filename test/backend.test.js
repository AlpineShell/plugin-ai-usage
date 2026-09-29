const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const BACKEND = path.join(__dirname, '..', 'backend.js')
const START = 1800000000000
const MINUTE = 60000
const abortAfter = AbortSignal.timeout.bind(AbortSignal)

const USAGE = {
  five_hour: { utilization: 42, resets_at: new Date(START + 60 * MINUTE).toISOString() },
  limits: [{ kind: 'session', percent: 42, resets_at: new Date(START + 60 * MINUTE).toISOString(), is_active: true }],
}

function response(status, body = {}, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => (name.toLowerCase() in headers ? headers[name.toLowerCase()] : null) },
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  }
}

function load(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-usage-'))
  const home = path.join(tmp, 'home')
  const claudeDir = path.join(home, '.claude')
  fs.mkdirSync(claudeDir, { recursive: true })
  const configDir = process.env.CLAUDE_CONFIG_DIR
  delete process.env.CLAUDE_CONFIG_DIR
  t.after(() => {
    if (configDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = configDir
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  const env = {
    tmp,
    claudeDir,
    now: START,
    calls: 0,
    timeoutMs: null,
    lastRequest: null,
    respond: () => response(200, USAGE),
    writeLogin(oauth, dir = claudeDir) {
      fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: oauth }))
    },
  }
  t.mock.method(os, 'homedir', () => home)
  t.mock.method(Date, 'now', () => env.now)
  t.mock.method(AbortSignal, 'timeout', (ms) => {
    env.timeoutMs = ms
    return abortAfter(20)
  })
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    env.calls++
    env.lastRequest = options
    return env.respond(url, options)
  })

  delete require.cache[BACKEND]
  require(BACKEND)({
    poll: (channel, fn, everyMs) => {
      assert.equal(channel, 'claude-usage')
      assert.equal(everyMs, MINUTE)
      env.poll = fn
    },
  })
  return env
}

function signedIn(t) {
  const env = load(t)
  env.writeLogin({ accessToken: 'token', expiresAt: START + 8 * 60 * MINUTE, subscriptionType: 'max' })
  return env
}

test('reports signed-out without a login file, and sends no request', async (t) => {
  const env = load(t)
  const usage = await env.poll()
  assert.equal(usage.ok, false)
  assert.equal(usage.reason, 'signed-out')
  assert.equal(usage.updatedAtMs, START)
  assert.equal(usage.sessionPercent, 0)
  assert.deepEqual(usage.limits, [])
  assert.equal(env.calls, 0)
})

test('reports signed-out when the login has no access token', async (t) => {
  const env = load(t)
  env.writeLogin({ refreshToken: 'refresh' })
  assert.equal((await env.poll()).reason, 'signed-out')
  assert.equal(env.calls, 0)
})

test('publishes the numbers, with a 15 second timeout on the request', async (t) => {
  const env = signedIn(t)
  const usage = await env.poll()
  assert.equal(usage.ok, true)
  assert.equal(usage.sessionPercent, 42)
  assert.equal(usage.subscriptionType, 'max')
  assert.equal(usage.updatedAtMs, START)
  assert.equal(env.lastRequest.headers.Authorization, 'Bearer token')
  assert.ok(env.lastRequest.signal instanceof AbortSignal)
  assert.equal(env.timeoutMs, 15000)
})

test('skips the request once the token has expired and drops the kept numbers', async (t) => {
  const env = load(t)
  env.writeLogin({ accessToken: 'token', expiresAt: START + 30000 })
  assert.equal((await env.poll()).ok, true)
  env.now += MINUTE
  const usage = await env.poll()
  assert.equal(usage.ok, false)
  assert.equal(usage.reason, 'expired')
  assert.equal(env.calls, 1)
})

test('drops the kept numbers on a 401', async (t) => {
  const env = signedIn(t)
  await env.poll()
  env.now += MINUTE
  env.respond = () => response(401)
  assert.equal((await env.poll()).reason, 'expired')
  env.now += MINUTE
  env.respond = () => {
    throw new TypeError('fetch failed')
  }
  const usage = await env.poll()
  assert.equal(usage.ok, false)
  assert.equal(usage.reason, 'offline')
})

test('keeps the last numbers for five minutes when requests fail, then reports offline', async (t) => {
  const env = signedIn(t)
  await env.poll()
  env.now += MINUTE
  env.respond = () => {
    throw new TypeError('fetch failed')
  }
  let usage = await env.poll()
  assert.equal(usage.ok, true)
  assert.equal(usage.updatedAtMs, START)
  env.now += MINUTE
  env.respond = () => response(500)
  usage = await env.poll()
  assert.equal(usage.ok, true)
  assert.equal(usage.updatedAtMs, START)
  env.now = START + 5 * MINUTE
  env.respond = () => {
    throw new TypeError('fetch failed')
  }
  usage = await env.poll()
  assert.equal(usage.ok, false)
  assert.equal(usage.reason, 'offline')
  assert.equal(usage.updatedAtMs, env.now)
})

test('reports offline when the request times out', async (t) => {
  const env = signedIn(t)
  env.respond = (url, options) =>
    new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason)))
  assert.equal((await env.poll()).reason, 'offline')
})

test('reports the status of other HTTP errors', async (t) => {
  const env = signedIn(t)
  env.respond = () => response(503)
  assert.equal((await env.poll()).reason, 'http-503')
})

test('reports bad-response for a body that is not JSON or is null', async (t) => {
  const env = signedIn(t)
  env.respond = () => response(200, '{not json')
  assert.equal((await env.poll()).reason, 'bad-response')
  env.respond = () => response(200, 'null')
  assert.equal((await env.poll()).reason, 'bad-response')
})

test('keeps the last numbers while the login file is half written', async (t) => {
  const env = signedIn(t)
  await env.poll()
  const file = path.join(env.claudeDir, '.credentials.json')
  for (const partial of ['{"claudeAiOauth":{"accessT', '']) {
    fs.writeFileSync(file, partial)
    env.now += MINUTE
    const usage = await env.poll()
    assert.equal(usage.ok, true)
    assert.equal(usage.sessionPercent, 42)
    assert.equal(usage.updatedAtMs, START)
  }
  assert.equal(env.calls, 1)
  env.now = START + 5 * MINUTE
  const usage = await env.poll()
  assert.equal(usage.ok, false)
  assert.equal(usage.reason, 'bad-response')
})

test('does not report signed-out for a half-written login file before the first numbers', async (t) => {
  const env = load(t)
  fs.writeFileSync(path.join(env.claudeDir, '.credentials.json'), '{"claudeAiOauth":{"accessT')
  assert.equal((await env.poll()).reason, 'bad-response')
})

test('waits out a Retry-After in seconds after a 429, keeping the last numbers', async (t) => {
  const env = signedIn(t)
  await env.poll()
  env.now += MINUTE
  env.respond = () => response(429, {}, { 'retry-after': '150' })
  assert.equal((await env.poll()).ok, true)
  env.now += 2 * MINUTE
  assert.equal((await env.poll()).ok, true)
  assert.equal(env.calls, 2)
  env.now += 31000
  env.respond = () => response(200, USAGE)
  const usage = await env.poll()
  assert.equal(usage.ok, true)
  assert.equal(usage.updatedAtMs, env.now)
  assert.equal(env.calls, 3)
})

test('reports rate-limited when there are no recent numbers, and sends no request while waiting', async (t) => {
  const env = signedIn(t)
  env.respond = () => response(429, {}, { 'retry-after': '600' })
  assert.equal((await env.poll()).reason, 'rate-limited')
  env.now += 5 * MINUTE
  assert.equal((await env.poll()).reason, 'rate-limited')
  assert.equal(env.calls, 1)
})

test('waits out a Retry-After given as an HTTP date', async (t) => {
  const env = signedIn(t)
  env.respond = () => response(429, {}, { 'retry-after': new Date(START + 200000).toUTCString() })
  await env.poll()
  env.now += 180000
  await env.poll()
  assert.equal(env.calls, 1)
  env.now += 30000
  env.respond = () => response(200, USAGE)
  assert.equal((await env.poll()).ok, true)
  assert.equal(env.calls, 2)
})

test('waits five minutes after a 429 without Retry-After', async (t) => {
  const env = signedIn(t)
  env.respond = () => response(429)
  await env.poll()
  env.now += 5 * MINUTE - 1000
  await env.poll()
  assert.equal(env.calls, 1)
  env.now += 2000
  await env.poll()
  assert.equal(env.calls, 2)
})

test('waits at most an hour after a 429', async (t) => {
  const env = signedIn(t)
  env.respond = () => response(429, {}, { 'retry-after': '999999' })
  await env.poll()
  env.now += 59 * MINUTE
  await env.poll()
  assert.equal(env.calls, 1)
  env.now += 61000
  env.respond = () => response(200, USAGE)
  assert.equal((await env.poll()).ok, true)
  assert.equal(env.calls, 2)
})

test('reads the login from CLAUDE_CONFIG_DIR when it is set', async (t) => {
  const env = signedIn(t)
  const custom = path.join(env.tmp, 'custom')
  fs.mkdirSync(custom)
  env.writeLogin({ accessToken: 'custom-token', expiresAt: START + 60 * MINUTE }, custom)
  process.env.CLAUDE_CONFIG_DIR = custom
  assert.equal((await env.poll()).ok, true)
  assert.equal(env.lastRequest.headers.Authorization, 'Bearer custom-token')
  fs.rmSync(path.join(custom, '.credentials.json'))
  assert.equal((await env.poll()).reason, 'signed-out')
})

test('fetches when the login has no expiry', async (t) => {
  const env = load(t)
  env.writeLogin({ accessToken: 'token' })
  assert.equal((await env.poll()).ok, true)
  assert.equal(env.calls, 1)
})
