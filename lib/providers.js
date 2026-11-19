const os = require('os')
const path = require('path')
const fs = require('fs')
const { createAntigravityFetcher } = require('./antigravity')

const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const OPENCODE_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage'
const FETCH_TIMEOUT_MS = 15000

function clampPercent(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, value))
}

function resetMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value
  }
  const ms = typeof value === 'string' && value ? Date.parse(value) : NaN
  return Number.isFinite(ms) ? ms : null
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
}

async function fetchJson(url, options, fetchImpl = globalThis.fetch) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetchImpl(url, { ...options, signal: controller.signal })
    const text = await res.text()
    let data = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = null
    }
    return { ok: res.ok, status: res.status, data }
  } catch (error) {
    return { ok: false, status: 0, data: null, error: error && error.message ? error.message : 'network error' }
  } finally {
    clearTimeout(timer)
  }
}

function formatPlanName(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  const clean = value.trim().replace(/[_-]+/g, ' ')
  return clean.replace(/\b\w/g, (ch) => ch.toUpperCase())
}

function claudeCredentialsPath(env = process.env, homedir = os.homedir()) {
  const baseDir = env.CLAUDE_CONFIG_DIR || path.join(homedir, '.claude')
  return path.join(baseDir, '.credentials.json')
}

function readClaudeOAuth(env = process.env, homedir = os.homedir()) {
  const parsed = readJsonFile(claudeCredentialsPath(env, homedir))
  return parsed && parsed.claudeAiOauth ? parsed.claudeAiOauth : null
}

function labelForClaudeLimit(limit) {
  if (limit.kind === 'session') return 'Session · 5h'
  if (limit.kind === 'weekly_all') return 'Weekly'
  if (limit.kind === 'weekly_scoped') {
    const model = limit.scope && limit.scope.model && limit.scope.model.display_name
    return model ? 'Weekly · ' + model : 'Weekly · scoped'
  }
  return limit.kind || 'Limit'
}

function mapClaudeLimits(data) {
  const raw = Array.isArray(data.limits) ? data.limits : []
  const limits = raw.map((limit) => ({
    key:
      (limit.kind || 'limit') +
      (limit.scope && limit.scope.model && limit.scope.model.display_name ? ':' + limit.scope.model.display_name : ''),
    kind: limit.kind || 'limit',
    label: labelForClaudeLimit(limit),
    percent: clampPercent(limit.percent),
    resetsAtMs: resetMs(limit.resets_at),
    active: limit.is_active !== false,
    severity: limit.severity || 'normal',
  }))
  if (limits.length === 0) {
    if (data.five_hour && typeof data.five_hour.utilization === 'number') {
      const fhReset = resetMs(data.five_hour.resets_at)
      const active = data.five_hour.utilization > 0 || (fhReset != null && fhReset > Date.now())
      limits.push({
        key: 'session',
        kind: 'session',
        label: 'Session · 5h',
        percent: clampPercent(data.five_hour.utilization),
        resetsAtMs: fhReset,
        active,
        severity: 'normal',
      })
    }
    if (data.seven_day && typeof data.seven_day.utilization === 'number') {
      limits.push({
        key: 'weekly_all',
        kind: 'weekly_all',
        label: 'Weekly',
        percent: clampPercent(data.seven_day.utilization),
        resetsAtMs: resetMs(data.seven_day.resets_at),
        active: true,
        severity: 'normal',
      })
    }
  }
  const extra = data.extra_usage
  if (extra && extra.is_enabled && typeof extra.utilization === 'number') {
    limits.push({
      key: 'extra',
      kind: 'extra',
      label: 'Extra usage',
      percent: clampPercent(extra.utilization),
      resetsAtMs: null,
      active: true,
      severity: 'normal',
    })
  }
  return limits
}

function claudeBarFrom(data, limits) {
  const session = limits.find((limit) => limit.kind === 'session')
  if (session) return { kind: 'session', percent: session.percent, resetsAtMs: session.resetsAtMs }
  if (data.five_hour && typeof data.five_hour.utilization === 'number') {
    return { kind: 'session', percent: clampPercent(data.five_hour.utilization), resetsAtMs: resetMs(data.five_hour.resets_at) }
  }
  const weekly = limits.find((limit) => limit.kind === 'weekly_all')
  if (weekly) return { kind: 'weekly', percent: weekly.percent, resetsAtMs: weekly.resetsAtMs }
  if (data.seven_day && typeof data.seven_day.utilization === 'number') {
    return { kind: 'weekly', percent: clampPercent(data.seven_day.utilization), resetsAtMs: resetMs(data.seven_day.resets_at) }
  }
  return { kind: 'session', percent: 0, resetsAtMs: null }
}

function claudePlanName(oauth) {
  const base = formatPlanName(oauth && oauth.subscriptionType)
  const multiplier = oauth && typeof oauth.rateLimitTier === 'string' ? oauth.rateLimitTier.match(/(\d+)x\b/i) : null
  return base && multiplier ? `${base} ${multiplier[1]}x` : base
}

function parseClaudeUsage(data, subscriptionType, now = Date.now()) {
  const limits = mapClaudeLimits(data || {})
  const bar = claudeBarFrom(data || {}, limits)
  return {
    id: 'claude',
    status: 'ok',
    plan: formatPlanName(subscriptionType),
    barKind: bar.kind,
    barPercent: bar.percent,
    barResetsAtMs: bar.resetsAtMs,
    limits,
    updatedAtMs: now,
  }
}

async function fetchClaudeUsage({ env = process.env, homedir = os.homedir(), fetchImpl = globalThis.fetch } = {}) {
  const oauth = readClaudeOAuth(env, homedir)
  if (!oauth || !oauth.accessToken) {
    return { id: 'claude', status: 'no_credentials', plan: null, barPercent: 0, limits: [], updatedAtMs: Date.now() }
  }
  const res = await fetchJson(
    CLAUDE_USAGE_URL,
    {
      headers: {
        Authorization: 'Bearer ' + oauth.accessToken,
        'anthropic-beta': 'oauth-2025-04-20',
        'anthropic-version': '2023-06-01',
        'User-Agent': 'alpine-shell',
      },
    },
    fetchImpl,
  )
  if (!res.ok || !res.data) {
    return {
      id: 'claude',
      status: res.status === 401 || res.status === 403 ? 'auth_error' : 'error',
      plan: claudePlanName(oauth),
      barPercent: 0,
      limits: [],
      updatedAtMs: Date.now(),
    }
  }
  return parseClaudeUsage(res.data, claudePlanName(oauth))
}

function opencodeKeyFile(dataDir) {
  return dataDir ? path.join(dataDir, 'opencode-key.json') : null
}

function readSavedOpencodeKey(dataDir) {
  const filePath = opencodeKeyFile(dataDir)
  if (!filePath) return null
  const parsed = readJsonFile(filePath)
  const key = parsed && typeof parsed.apiKey === 'string' ? parsed.apiKey.trim() : ''
  return key || null
}

function saveOpencodeKey(dataDir, apiKey) {
  const filePath = opencodeKeyFile(dataDir)
  if (!filePath) throw new Error('plugin data directory unavailable')
  const trimmed = typeof apiKey === 'string' ? apiKey.trim() : ''
  if (!trimmed) {
    fs.rmSync(filePath, { force: true })
    return { configured: false }
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify({ apiKey: trimmed }), { encoding: 'utf8', mode: 0o600 })
  return { configured: true }
}

function extractKeyFromAuthEntry(entry) {
  if (typeof entry === 'string' && entry.trim()) return entry.trim()
  if (!entry || typeof entry !== 'object') return null
  const candidate = entry.key || entry.access || entry.apiKey || entry.token
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : null
}

function opencodeAuthPaths(env = process.env, homedir = os.homedir()) {
  const paths = [path.join(homedir, '.local', 'share', 'opencode', 'auth.json')]
  if (env.XDG_DATA_HOME) paths.unshift(path.join(env.XDG_DATA_HOME, 'opencode', 'auth.json'))
  if (env.APPDATA) paths.push(path.join(env.APPDATA, 'opencode', 'auth.json'))
  if (env.LOCALAPPDATA) paths.push(path.join(env.LOCALAPPDATA, 'opencode', 'auth.json'))
  return [...new Set(paths)]
}

function resolveOpencodeKey({ dataDir = null, env = process.env, homedir = os.homedir() } = {}) {
  const saved = readSavedOpencodeKey(dataDir)
  if (saved) return { key: saved, source: 'settings' }
  for (const filePath of opencodeAuthPaths(env, homedir)) {
    const parsed = readJsonFile(filePath)
    if (!parsed || typeof parsed !== 'object') continue
    for (const providerKey of ['opencode-go', 'opencode', 'opencode-zen']) {
      const found = extractKeyFromAuthEntry(parsed[providerKey])
      if (found) return { key: found, source: 'auth.json' }
    }
  }
  const envKey = (env.OPENCODE_GO_API_KEY || env.OPENCODE_API_KEY || env.OPENCODE_ZEN_API_KEY || '').trim()
  if (envKey) return { key: envKey, source: 'env' }
  return { key: null, source: null }
}

function formatDollars(amount) {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return null
  return '$' + (Number.isInteger(amount) ? String(amount) : amount.toFixed(2))
}

function parseOpencodeWindow(key, label, raw, now) {
  if (!raw || typeof raw !== 'object') return null
  let percent = null
  if (typeof raw.usagePercent === 'number' && Number.isFinite(raw.usagePercent)) {
    percent = raw.usagePercent
  } else if (typeof raw.percent === 'number' && Number.isFinite(raw.percent)) {
    percent = raw.percent
  } else if (
    typeof raw.usageDollars === 'number' &&
    typeof raw.limitDollars === 'number' &&
    raw.limitDollars > 0
  ) {
    percent = (raw.usageDollars / raw.limitDollars) * 100
  }
  if (percent === null) return null
  let resetsAtMs = resetMs(raw.resetsAt || raw.resets_at || raw.resetAt)
  if (resetsAtMs === null && typeof raw.resetInSec === 'number' && Number.isFinite(raw.resetInSec) && raw.resetInSec > 0) {
    resetsAtMs = now + raw.resetInSec * 1000
  }
  const usedStr = formatDollars(raw.usageDollars)
  const limitStr = formatDollars(raw.limitDollars)
  const detail = usedStr && limitStr ? `${usedStr} / ${limitStr}` : null
  return {
    key,
    kind: key,
    label,
    percent: clampPercent(percent),
    resetsAtMs,
    detail,
    active: true,
    severity: 'normal',
  }
}

function parseOpencodeUsage(data, now = Date.now()) {
  const root = data && typeof data.usage === 'object' && data.usage !== null ? data.usage : data || {}
  const limits = [
    parseOpencodeWindow('rolling5h', 'Rolling · 5h', root.rolling5h || root.rolling || root.fiveHour || root.five_hour, now),
    parseOpencodeWindow('weekly', 'Weekly', root.weekly || root.sevenDay || root.seven_day, now),
    parseOpencodeWindow('monthly', 'Monthly', root.monthly || root.thirtyDay || root.thirty_day, now),
  ].filter(Boolean)
  const primary =
    limits.find((limit) => limit.kind === 'rolling5h') ||
    limits.reduce((best, item) => (!best || item.percent > best.percent ? item : best), null)
  return {
    id: 'opencode',
    status: 'ok',
    plan: 'Go',
    barKind: primary ? primary.kind : 'rolling5h',
    barPercent: primary ? primary.percent : 0,
    barResetsAtMs: primary ? primary.resetsAtMs : null,
    limits,
    updatedAtMs: now,
  }
}

async function fetchOpencodeUsage({ dataDir = null, env = process.env, homedir = os.homedir(), fetchImpl = globalThis.fetch } = {}) {
  const resolved = resolveOpencodeKey({ dataDir, env, homedir })
  if (!resolved.key) {
    return { id: 'opencode', status: 'no_credentials', plan: null, barPercent: 0, limits: [], updatedAtMs: Date.now() }
  }
  const res = await fetchJson(
    OPENCODE_USAGE_URL,
    {
      headers: {
        Authorization: 'Bearer ' + resolved.key,
        'User-Agent': 'alpine-shell',
      },
    },
    fetchImpl,
  )
  if (!res.ok || !res.data || res.data.type === 'error') {
    const status = opencodeFailureStatus(res.status)
    return {
      id: 'opencode',
      status,
      plan: status === 'no_subscription' ? 'Zen' : null,
      barPercent: 0,
      limits: [],
      updatedAtMs: Date.now(),
    }
  }
  return parseOpencodeUsage(res.data)
}

function opencodeFailureStatus(httpStatus) {
  if (httpStatus === 401) return 'auth_error'
  if (httpStatus === 403) return 'no_subscription'
  return 'error'
}

const fetchAntigravityUsage = createAntigravityFetcher({ fetchJson, clampPercent, resetMs })

function selectPrimaryProvider(providers, enabledIds, barSource = 'highest') {
  const okProviders = enabledIds
    .map((id) => providers && providers[id])
    .filter((entry) => entry && entry.status === 'ok')
  if (okProviders.length === 0) return null
  if (barSource && barSource !== 'highest') {
    const chosen = okProviders.find((entry) => entry.id === barSource)
    if (chosen) return chosen
  }
  return okProviders.reduce((best, entry) => (!best || entry.barPercent > best.barPercent ? entry : best), null)
}

module.exports = {
  clampPercent,
  resetMs,
  parseClaudeUsage,
  fetchClaudeUsage,
  fetchJson,
  claudePlanName,
  fetchAntigravityUsage,
  resolveOpencodeKey,
  saveOpencodeKey,
  parseOpencodeUsage,
  fetchOpencodeUsage,
  selectPrimaryProvider,
}
