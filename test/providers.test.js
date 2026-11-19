const { describe, test, expect } = require('bun:test')
const fs = require('fs')
const os = require('os')
const path = require('path')
const {
  clampPercent,
  resetMs,
  fetchJson,
  claudePlanName,
  fetchClaudeUsage,
  parseClaudeUsage,
  parseOpencodeUsage,
  resolveOpencodeKey,
  saveOpencodeKey,
  fetchOpencodeUsage,
  selectPrimaryProvider,
} = require('../lib/providers')
const {
  createAntigravityFetcher,
  parseAntigravityModels,
  parseCredentialBlob,
  tokenFromCredential,
} = require('../lib/antigravity')
const { readEnabledProviders, setProviderEnabled } = require('../lib/providerPrefs')
const { createFetchSchedule, nextBackoffMs, RATE_LIMIT_BASE_MS, RATE_LIMIT_MAX_MS } = require('../lib/fetchSchedule')
const startBackend = require('../backend')

describe('plugin manifest', () => {
  test('is valid for the alpine-shell organisation', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'plugin.json'), 'utf8'))
    expect(manifest.id).toBe('alpine-shell.ai-usage')
    expect(manifest.apiVersion).toBe(1)
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(manifest.main).toBe('backend.js')
    expect(manifest.renderer).toBe('index.js')
    const keys = manifest.contributes.settings.map((setting) => setting.key)
    expect(keys).toEqual(['pillIcon', 'barSource'])
  })
})

describe('Claude usage parser', () => {
  test('maps session, weekly, scoped, and extra limits', () => {
    const parsed = parseClaudeUsage(
      {
        five_hour: { utilization: 42, resets_at: '2026-11-19T14:00:00Z' },
        limits: [
          { kind: 'session', percent: 42, resets_at: '2026-11-19T14:00:00Z', is_active: true },
          { kind: 'weekly_all', percent: 18, resets_at: '2026-11-24T00:00:00Z' },
          { kind: 'weekly_scoped', percent: 65, resets_at: '2026-11-24T00:00:00Z', scope: { model: { display_name: 'Opus' } } },
        ],
        extra_usage: { is_enabled: true, utilization: 12 },
      },
      'max',
      1700000000000,
    )
    expect(parsed.status).toBe('ok')
    expect(parsed.plan).toBe('Max')
    expect(parsed.barKind).toBe('session')
    expect(parsed.barPercent).toBe(42)
    expect(parsed.limits.map((l) => [l.label, l.percent])).toEqual([
      ['Session · 5h', 42],
      ['Weekly', 18],
      ['Weekly · Opus', 65],
      ['Extra usage', 12],
    ])
  })

  test('names the plan with its usage multiplier when the login has one', () => {
    expect(claudePlanName({ subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' })).toBe('Max 20x')
    expect(claudePlanName({ subscriptionType: 'pro', rateLimitTier: 'default_claude_pro' })).toBe('Pro')
    expect(claudePlanName({})).toBeNull()
  })

  test('falls back to weekly limit when plan has no session limit', () => {
    const parsed = parseClaudeUsage(
      {
        five_hour: null,
        seven_day: { utilization: 33, resets_at: '2026-11-24T00:00:00Z' },
      },
      'max_20x',
      1700000000000,
    )
    expect(parsed.barKind).toBe('weekly')
    expect(parsed.barPercent).toBe(33)
    expect(parsed.limits).toHaveLength(1)
    expect(parsed.limits[0].label).toBe('Weekly')
  })
})

describe('Antigravity usage parser and fetcher', () => {
  const helpers = { clampPercent, resetMs }

  test('groups models into the Gemini pool and the Claude and GPT-OSS pool', () => {
    const quota = (remainingFraction, resetTime) => ({ remainingFraction, resetTime })
    const parsed = parseAntigravityModels(
      {
        models: {
          'claude-opus-5-5-low': { displayName: 'Claude Opus 5.5 (Low)', modelProvider: 'MODEL_PROVIDER_ANTHROPIC', quotaInfo: quota(0.763, '2026-11-19T17:33:38Z') },
          'claude-sonnet-5-5-high': { displayName: 'Claude Sonnet 5.5 (High)', modelProvider: 'MODEL_PROVIDER_ANTHROPIC', quotaInfo: quota(0.763, '2026-11-19T17:33:38Z') },
          'gpt-oss-120b-medium': { displayName: 'GPT-OSS 120B (Medium)', modelProvider: 'MODEL_PROVIDER_OPENAI', quotaInfo: quota(0.763, '2026-11-19T17:33:38Z') },
          'gemini-3.8-flash-tiered': { modelProvider: 'MODEL_PROVIDER_GOOGLE', quotaInfo: { resetTime: '2026-11-19T15:24:47Z' } },
          'gemini-3-flash': { displayName: 'Gemini 3 Flash', modelProvider: 'MODEL_PROVIDER_GOOGLE', quotaInfo: { resetTime: '2026-11-19T15:24:47Z' } },
          tab_flash_lite_preview: { modelProvider: 'MODEL_PROVIDER_GOOGLE', quotaInfo: { remainingFraction: 1 } },
          chat_20706: { modelProvider: 'MODEL_PROVIDER_GOOGLE', isInternal: true, quotaInfo: quota(1, '2026-11-19T18:00:00Z') },
        },
      },
      'Google AI Pro',
      { ...helpers, now: 1700000000000 },
    )
    expect(parsed.status).toBe('ok')
    expect(parsed.plan).toBe('Google AI Pro')
    expect(parsed.limits.map((l) => [l.label, Math.round(l.percent), l.active])).toEqual([
      ['Gemini', 100, true],
      ['Claude & GPT-OSS', 24, true],
    ])
    expect(parsed.barPercent).toBe(100)
    expect(parsed.barResetsAtMs).toBe(Date.parse('2026-11-19T15:24:47Z'))
  })

  test('marks an untouched pool idle', () => {
    const parsed = parseAntigravityModels(
      { models: { flash: { modelProvider: 'MODEL_PROVIDER_GOOGLE', quotaInfo: { remainingFraction: 1, resetTime: '2026-11-19T18:00:00Z' } } } },
      null,
      { ...helpers, now: 1700000000000 },
    )
    expect(parsed.limits).toEqual([expect.objectContaining({ label: 'Gemini', percent: 0, active: false })])
  })


  test('reads the credential once, loads the plan and project, then fetches the models', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-antigravity-'))
    try {
      fs.mkdirSync(path.join(tmpHome, '.gemini', 'antigravity-cli', 'cache'), { recursive: true })
      fs.writeFileSync(path.join(tmpHome, '.gemini', 'antigravity-cli', 'cache', 'default_project_id.txt'), 'cached-project\n')
      let credentialReads = 0
      const readCredential = async () => {
        credentialReads += 1
        return { token: { access_token: 'ya29.test', expiry: new Date(Date.now() + 3600000).toISOString() } }
      }
      const calls = []
      const fakeFetch = async (url, opts) => {
        calls.push({ url, body: JSON.parse(opts.body), auth: opts.headers.Authorization })
        if (url.includes('loadCodeAssist')) {
          return { ok: true, status: 200, text: async () => JSON.stringify({ paidTier: { name: 'Google AI Pro' }, currentTier: { name: 'Antigravity' } }) }
        }
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({ models: { pro: { displayName: 'Gemini 2.5 Pro', quotaInfo: { remainingFraction: 0.25, resetTime: '2026-11-20T00:00:00Z' } } } }),
        }
      }
      const fetchUsage = createAntigravityFetcher({ fetchJson, clampPercent, resetMs, readCredential, homedir: tmpHome })
      const first = await fetchUsage({ fetchImpl: fakeFetch })
      const second = await fetchUsage({ fetchImpl: fakeFetch })
      expect(first.status).toBe('ok')
      expect(first.plan).toBe('Google AI Pro')
      expect(first.barPercent).toBeCloseTo(75, 5)
      expect(second.status).toBe('ok')
      expect(credentialReads).toBe(1)
      expect(calls.filter((call) => call.url.includes('loadCodeAssist'))).toHaveLength(1)
      expect(calls[1].body).toEqual({ project: 'cached-project' })
      expect(calls[1].auth).toBe('Bearer ya29.test')
      expect(calls[1].url).toBe('https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels')
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  test('reports a missing sign-in and an expired one without calling Google', async () => {
    let fetched = false
    const fakeFetch = async () => {
      fetched = true
      return { ok: true, status: 200, text: async () => '{}' }
    }
    const missing = createAntigravityFetcher({ fetchJson, clampPercent, resetMs, readCredential: async () => null })
    expect((await missing({ fetchImpl: fakeFetch })).status).toBe('no_credentials')
    const expired = createAntigravityFetcher({
      fetchJson,
      clampPercent,
      resetMs,
      readCredential: async () => ({ token: { access_token: 'ya29.old', expiry: new Date(Date.now() - 1000).toISOString() } }),
    })
    expect((await expired({ fetchImpl: fakeFetch })).status).toBe('expired')
    expect(fetched).toBe(false)
  })

  test('decodes the credential blob Windows hands back', () => {
    const blob = Buffer.from(JSON.stringify({ token: { access_token: 'ya29.a', expiry: '2026-11-19T14:18:14+01:00' } })).toString('base64')
    const token = tokenFromCredential(parseCredentialBlob(blob))
    expect(token.accessToken).toBe('ya29.a')
    expect(token.expiresAtMs).toBe(Date.parse('2026-11-19T14:18:14+01:00'))
    expect(parseCredentialBlob('')).toBeNull()
    expect(tokenFromCredential({})).toBeNull()
  })
})

describe('OpenCode usage parser and key resolution', () => {
  test('parses the response the Go usage endpoint sends today', () => {
    const parsed = parseOpencodeUsage(
      {
        usage: {
          rolling: { status: 'ok', percent: 12, resetsAt: '2026-11-19T18:00:00.000Z' },
          weekly: { status: 'ok', percent: 40, resetsAt: '2026-11-23T00:00:00.000Z' },
          monthly: { status: 'rate-limited', percent: 100, resetsAt: '2026-12-01T00:00:00.000Z' },
        },
      },
      1700000000000,
    )
    expect(parsed.limits.map((l) => [l.label, l.percent])).toEqual([
      ['Rolling · 5h', 12],
      ['Weekly', 40],
      ['Monthly', 100],
    ])
    expect(parsed.barPercent).toBe(12)
    expect(parsed.limits[0].resetsAtMs).toBe(Date.parse('2026-11-19T18:00:00.000Z'))
  })

  test('tells a key without a Go plan apart from a rejected key', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-oc-status-'))
    try {
      const respond = (status) => async () => ({ ok: false, status, text: async () => '{"type":"error"}' })
      const env = { OPENCODE_API_KEY: 'oc_sk_test' }
      const forbidden = await fetchOpencodeUsage({ dataDir: tmpDir, env, homedir: tmpDir, fetchImpl: respond(403) })
      const unauthorized = await fetchOpencodeUsage({ dataDir: tmpDir, env, homedir: tmpDir, fetchImpl: respond(401) })
      expect(forbidden.status).toBe('no_subscription')
      expect(forbidden.plan).toBe('Zen')
      expect(unauthorized.plan).toBeNull()
      expect(unauthorized.status).toBe('auth_error')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('parses top-level rolling5h, weekly, and monthly windows', () => {
    const now = 1700000000000
    const parsed = parseOpencodeUsage(
      {
        rolling5h: { usageDollars: 2.34, limitDollars: 12, usagePercent: 19.5, resetInSec: 7200 },
        weekly: { usageDollars: 8.91, limitDollars: 30, usagePercent: 29.7, resetInSec: 345600 },
        monthly: { usageDollars: 15, limitDollars: 60, usagePercent: 25, resetInSec: 1414800 },
      },
      now,
    )
    expect(parsed.status).toBe('ok')
    expect(parsed.plan).toBe('Go')
    expect(parsed.barPercent).toBe(19.5)
    expect(parsed.limits.map((l) => [l.label, l.percent, l.detail])).toEqual([
      ['Rolling · 5h', 19.5, '$2.34 / $12'],
      ['Weekly', 29.7, '$8.91 / $30'],
      ['Monthly', 25, '$15 / $60'],
    ])
    expect(parsed.limits[0].resetsAtMs).toBe(now + 7200000)
  })

  test('parses nested usage object with rolling key', () => {
    const parsed = parseOpencodeUsage(
      {
        usage: {
          rolling: { percent: 55, resetsAt: '2026-11-19T15:00:00Z' },
          weekly: { percent: 20, resetsAt: '2026-11-23T00:00:00Z' },
        },
      },
      1700000000000,
    )
    expect(parsed.barPercent).toBe(55)
    expect(parsed.limits).toHaveLength(2)
  })

  test('resolves key in priority order: saved settings > auth.json > env', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-oc-'))
    const dataDir = path.join(tmpDir, 'data')
    const homeDir = path.join(tmpDir, 'home')
    try {
      expect(resolveOpencodeKey({ dataDir, env: {}, homedir: homeDir })).toEqual({ key: null, source: null })
      expect(resolveOpencodeKey({ dataDir, env: { OPENCODE_API_KEY: 'env-key' }, homedir: homeDir })).toEqual({
        key: 'env-key',
        source: 'env',
      })
      fs.mkdirSync(path.join(homeDir, '.local', 'share', 'opencode'), { recursive: true })
      fs.writeFileSync(
        path.join(homeDir, '.local', 'share', 'opencode', 'auth.json'),
        JSON.stringify({ 'opencode-go': { type: 'api', key: 'auth-key' } }),
      )
      expect(resolveOpencodeKey({ dataDir, env: { OPENCODE_API_KEY: 'env-key' }, homedir: homeDir })).toEqual({
        key: 'auth-key',
        source: 'auth.json',
      })
      saveOpencodeKey(dataDir, 'saved-key')
      expect(resolveOpencodeKey({ dataDir, env: { OPENCODE_API_KEY: 'env-key' }, homedir: homeDir })).toEqual({
        key: 'saved-key',
        source: 'settings',
      })
      let seenAuth = null
      const res = await fetchOpencodeUsage({
        dataDir,
        env: {},
        homedir: homeDir,
        fetchImpl: async (_url, opts) => {
          seenAuth = opts.headers.Authorization
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ rolling5h: { usagePercent: 40, resetInSec: 1800 } }),
          }
        },
      })
      expect(seenAuth).toBe('Bearer saved-key')
      expect(res.barPercent).toBe(40)
      saveOpencodeKey(dataDir, '')
      expect(resolveOpencodeKey({ dataDir, env: {}, homedir: homeDir })).toEqual({ key: 'auth-key', source: 'auth.json' })
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('selectPrimaryProvider', () => {
  const providers = {
    claude: { id: 'claude', status: 'ok', barPercent: 30 },
    antigravity: { id: 'antigravity', status: 'ok', barPercent: 80 },
    opencode: { id: 'opencode', status: 'no_credentials', barPercent: 0 },
  }

  test('picks highest enabled provider when barSource is highest', () => {
    expect(selectPrimaryProvider(providers, ['claude', 'antigravity', 'opencode'], 'highest').id).toBe('antigravity')
    expect(selectPrimaryProvider(providers, ['claude'], 'highest').id).toBe('claude')
  })

  test('pins to chosen provider and falls back to highest when chosen is unavailable', () => {
    expect(selectPrimaryProvider(providers, ['claude', 'antigravity'], 'claude').id).toBe('claude')
    expect(selectPrimaryProvider(providers, ['claude', 'antigravity', 'opencode'], 'opencode').id).toBe('antigravity')
  })
})

describe('Claude rate limits', () => {
  test('reports a 429 as rate limited with the wait Anthropic asks for', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-claude-'))
    try {
      fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true })
      fs.writeFileSync(
        path.join(tmpHome, '.claude', '.credentials.json'),
        JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat-test', subscriptionType: 'max' } }),
      )
      const fakeFetch = async () => ({
        ok: false,
        status: 429,
        headers: { get: (name) => (name === 'retry-after' ? '600' : null) },
        text: async () => '{"error":{"type":"rate_limit_error"}}',
      })
      const result = await fetchClaudeUsage({ env: {}, homedir: tmpHome, fetchImpl: fakeFetch })
      expect(result.status).toBe('rate_limited')
      expect(result.retryAfterMs).toBe(600000)
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  test('asks Claude every five minutes and backs off further after each refusal', () => {
    let clock = 0
    const schedule = createFetchSchedule(() => clock)
    expect(schedule.isDue('claude')).toBe(true)
    schedule.record('claude', { status: 'ok' })
    clock = 60000
    expect(schedule.isDue('claude')).toBe(false)
    clock = 300000
    expect(schedule.isDue('claude')).toBe(true)
    schedule.record('claude', { status: 'rate_limited', retryAfterMs: null })
    clock += RATE_LIMIT_BASE_MS - 60000
    expect(schedule.isDue('claude')).toBe(false)
    expect(nextBackoffMs(RATE_LIMIT_BASE_MS, null)).toBe(RATE_LIMIT_BASE_MS * 2)
    expect(nextBackoffMs(RATE_LIMIT_MAX_MS, null)).toBe(RATE_LIMIT_MAX_MS)
    expect(nextBackoffMs(0, RATE_LIMIT_MAX_MS * 2)).toBe(RATE_LIMIT_MAX_MS * 2)
    schedule.record('antigravity', { status: 'ok' })
    clock += 60000
    expect(schedule.isDue('antigravity')).toBe(true)
  })
})

describe('provider preferences', () => {
  test('turns every provider on until one is switched off', () => {
    const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-prefs-'))
    try {
      expect(readEnabledProviders(tmpData)).toEqual({ claude: true, antigravity: true, opencode: true })
      expect(setProviderEnabled(tmpData, 'antigravity', false)).toEqual({ claude: true, antigravity: false, opencode: true })
      expect(readEnabledProviders(tmpData)).toEqual({ claude: true, antigravity: false, opencode: true })
      expect(() => setProviderEnabled(tmpData, 'gemini', true)).toThrow('unknown provider')
    } finally {
      fs.rmSync(tmpData, { recursive: true, force: true })
    }
  })
})

describe('backend lifecycle', () => {
  test('publishes only the providers switched on and answers the settings commands', async () => {
    const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-backend-'))
    for (const id of ['claude', 'antigravity', 'opencode']) setProviderEnabled(tmpData, id, false)
    const published = []
    let commandHandler = null
    const ctx = {
      id: 'alpine-shell.ai-usage',
      dataDir: tmpData,
      settings: { get: () => undefined, onChange: () => () => {} },
      publish: (channel, data) => published.push({ channel, data }),
      log: () => {},
      onCommand: (fn) => {
        commandHandler = fn
      },
    }
    const stop = startBackend(ctx)
    try {
      await new Promise((resolve) => setTimeout(resolve, 25))
      expect(published.length).toBeGreaterThanOrEqual(1)
      expect(published[0].channel).toBe('alpine-shell.ai-usage/usage')
      expect(published[0].data.providers).toEqual({})
      expect(published[0].data.enabled).toEqual({ claude: false, antigravity: false, opencode: false })
      const status = await commandHandler('provider-status')
      expect(status.enabled.claude).toBe(false)
      expect(typeof status.opencodeKey.configured).toBe('boolean')
      const saved = await commandHandler('set-opencode-key', { apiKey: 'oc_sk_saved' })
      expect(saved.opencodeKey).toEqual({ configured: true, source: 'settings' })
    } finally {
      stop()
      fs.rmSync(tmpData, { recursive: true, force: true })
    }
  })
})
