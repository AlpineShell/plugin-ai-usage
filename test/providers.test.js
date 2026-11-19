const { describe, test, expect } = require('bun:test')
const fs = require('fs')
const os = require('os')
const path = require('path')
const {
  parseClaudeUsage,
  parseGeminiUsage,
  fetchGeminiUsage,
  parseOpencodeUsage,
  resolveOpencodeKey,
  saveOpencodeKey,
  fetchOpencodeUsage,
  selectPrimaryProvider,
  formatGeminiModelName,
} = require('../lib/providers')
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
    expect(keys).toEqual(['claudeEnabled', 'geminiEnabled', 'opencodeEnabled', 'pillIcon', 'barSource'])
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

describe('Gemini usage parser and fetcher', () => {
  test('formats model names cleanly', () => {
    expect(formatGeminiModelName('gemini-2.5-pro-preview')).toBe('Gemini 2.5 Pro')
    expect(formatGeminiModelName('models/gemini-2.5-flash')).toBe('Gemini 2.5 Flash')
  })

  test('converts remainingFraction to used percent and sorts Pro before Flash', () => {
    const parsed = parseGeminiUsage(
      {
        buckets: [
          { modelId: 'gemini-2.5-flash', remainingFraction: 0.9, resetTime: '2026-11-20T00:00:00Z' },
          { modelId: 'gemini-2.5-pro', remainingFraction: 0.4, resetTime: '2026-11-20T00:00:00Z' },
          { modelId: 'gemini-2.5-pro', remainingFraction: 0.7, resetTime: '2026-11-20T00:00:00Z' },
        ],
      },
      'pro',
      1700000000000,
    )
    expect(parsed.status).toBe('ok')
    expect(parsed.plan).toBe('Pro')
    expect(parsed.barPercent).toBeCloseTo(60, 5)
    expect(parsed.limits.map((l) => l.label)).toEqual(['Gemini 2.5 Pro', 'Gemini 2.5 Flash'])
    expect(parsed.limits[0].percent).toBeCloseTo(60, 5)
    expect(parsed.limits[1].percent).toBeCloseTo(10, 5)
  })

  test('loads project from loadCodeAssist and queries retrieveUserQuota', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-gemini-'))
    try {
      fs.mkdirSync(path.join(tmpHome, '.gemini'), { recursive: true })
      fs.writeFileSync(
        path.join(tmpHome, '.gemini', 'oauth_creds.json'),
        JSON.stringify({ access_token: 'test-token', expiry_date: Date.now() + 3600000 }),
      )
      const calls = []
      const fakeFetch = async (url, opts) => {
        calls.push({ url, body: JSON.parse(opts.body) })
        if (url.includes('loadCodeAssist')) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ cloudaicompanionProject: 'proj-123', currentTier: { name: 'Google AI Pro' } }),
          }
        }
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              buckets: [{ modelId: 'gemini-2.5-pro', remainingFraction: 0.25, resetTime: '2026-11-20T00:00:00Z' }],
            }),
        }
      }
      const result = await fetchGeminiUsage({ env: {}, homedir: tmpHome, fetchImpl: fakeFetch })
      expect(result.status).toBe('ok')
      expect(result.plan).toBe('Google AI Pro')
      expect(result.barPercent).toBeCloseTo(75, 5)
      expect(calls[1].body).toEqual({ project: 'proj-123' })
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true })
    }
  })
})

describe('OpenCode Go usage parser and key resolution', () => {
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
    gemini: { id: 'gemini', status: 'ok', barPercent: 80 },
    opencode: { id: 'opencode', status: 'no_credentials', barPercent: 0 },
  }

  test('picks highest enabled provider when barSource is highest', () => {
    expect(selectPrimaryProvider(providers, ['claude', 'gemini', 'opencode'], 'highest').id).toBe('gemini')
    expect(selectPrimaryProvider(providers, ['claude'], 'highest').id).toBe('claude')
  })

  test('pins to chosen provider and falls back to highest when chosen is unavailable', () => {
    expect(selectPrimaryProvider(providers, ['claude', 'gemini'], 'claude').id).toBe('claude')
    expect(selectPrimaryProvider(providers, ['claude', 'gemini', 'opencode'], 'opencode').id).toBe('gemini')
  })
})

describe('backend lifecycle', () => {
  test('publishes enabled providers and handles opencode-key-status command', async () => {
    const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-backend-'))
    const published = []
    let commandHandler = null
    const settingsValues = { claudeEnabled: false, geminiEnabled: false, opencodeEnabled: false }
    const listeners = new Set()
    const ctx = {
      id: 'alpine-shell.ai-usage',
      dataDir: tmpData,
      settings: {
        get: (key) => settingsValues[key],
        onChange: (fn) => {
          listeners.add(fn)
          return () => listeners.delete(fn)
        },
      },
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
      const status = await commandHandler('opencode-key-status')
      expect(typeof status.configured).toBe('boolean')
    } finally {
      stop()
      fs.rmSync(tmpData, { recursive: true, force: true })
    }
  })
})
