// Backend for the Claude Code Usage plugin. Runs in an isolated Electron utilityProcess
// (started by the shell only when this plugin is installed + enabled). It reads the local
// Claude Code credentials, polls the Anthropic usage endpoint, and publishes the result on
// the `claude-usage` channel that the plugin's topbar widget subscribes to.

const os = require('os')
const path = require('path')
const fs = require('fs')

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const TIMEOUT_MS = 15000
const STALE_MS = 5 * 60000
const RATE_LIMIT_BACKOFF_MS = 5 * 60000
const MAX_BACKOFF_MS = 60 * 60000

let lastGood = null
let retryAtMs = 0

function credentialsFile() {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  return path.join(dir, '.credentials.json')
}

function emptyUsage() {
  return {
    ok: false,
    sessionPercent: 0,
    sessionResetsAtMs: null,
    sessionActive: false,
    limits: [],
    subscriptionType: null,
    updatedAtMs: 0,
  }
}

// Only a missing file means signed out. Claude Code rewrites this file when it
// refreshes the token, so any other read or parse error is thrown and treated
// as a passing failure that keeps the last numbers.
function readOAuth() {
  try {
    const parsed = JSON.parse(fs.readFileSync(credentialsFile(), 'utf8'))
    return (parsed && parsed.claudeAiOauth) || null
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

function resetMs(value) {
  const ms = value ? Date.parse(value) : NaN
  return Number.isFinite(ms) ? ms : null
}

function labelForLimit(limit) {
  if (limit.kind === 'session') return 'Session · 5h'
  if (limit.kind === 'weekly_all') return 'Weekly'
  if (limit.kind === 'weekly_scoped') {
    const model = limit.scope && limit.scope.model && limit.scope.model.display_name
    return model ? 'Weekly · ' + model : 'Weekly · scoped'
  }
  return limit.kind || 'Limit'
}

function mapLimits(data) {
  const raw = Array.isArray(data.limits) ? data.limits : []
  const limits = raw.map((limit) => ({
    key:
      (limit.kind || 'limit') +
      (limit.scope && limit.scope.model && limit.scope.model.display_name ? ':' + limit.scope.model.display_name : ''),
    kind: limit.kind || 'limit',
    label: labelForLimit(limit),
    percent: typeof limit.percent === 'number' ? limit.percent : 0,
    resetsAtMs: resetMs(limit.resets_at),
    // The API marks a window `is_active: false` before it has started (e.g. no
    // session opened yet). Treat a missing flag as active for back-compat.
    active: limit.is_active !== false,
    severity: limit.severity || 'normal',
  }))
  const extra = data.extra_usage
  if (extra && extra.is_enabled && typeof extra.utilization === 'number') {
    limits.push({ key: 'extra', kind: 'extra', label: 'Extra usage', percent: extra.utilization, resetsAtMs: null, active: true, severity: 'normal' })
  }
  return limits
}

function sessionPercentFrom(data, limits) {
  if (data.five_hour && typeof data.five_hour.utilization === 'number') return data.five_hour.utilization
  const session = limits.find((l) => l.kind === 'session')
  return session ? session.percent : 0
}

// A session is "not started" until the first message opens the 5h window. The
// API signals this with `is_active: false` on the session limit; fall back to
// the five_hour window (any usage, or a future reset) when the flag is absent.
function sessionActiveFrom(data, limits) {
  const session = limits.find((l) => l.kind === 'session')
  if (session) return session.active
  const fh = data.five_hour
  if (!fh || typeof fh.utilization !== 'number') return false
  const reset = resetMs(fh.resets_at)
  return fh.utilization > 0 || (reset != null && reset > Date.now())
}

// Sign-in problems publish a failure right away. Anything else keeps the last
// numbers for a few minutes so one dropped request does not blank the bar.
function failure(reason) {
  if (reason === 'signed-out' || reason === 'expired') lastGood = null
  else if (lastGood && Date.now() - lastGood.updatedAtMs < STALE_MS) return lastGood
  return { ...emptyUsage(), reason, updatedAtMs: Date.now() }
}

function retryDelayMs(header) {
  const seconds = Number(header)
  const ms = header && Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now()
  if (!Number.isFinite(ms)) return RATE_LIMIT_BACKOFF_MS
  return Math.max(0, Math.min(ms, MAX_BACKOFF_MS))
}

// Never refresh the token here: that would rotate Claude Code's refresh token
// and sign the user out of Claude Code.
async function fetchUsage() {
  let oauth
  try {
    oauth = readOAuth()
  } catch {
    return failure('bad-response')
  }
  if (!oauth || !oauth.accessToken) return failure('signed-out')
  if (typeof oauth.expiresAt === 'number' && oauth.expiresAt <= Date.now()) return failure('expired')
  if (Date.now() < retryAtMs) return failure('rate-limited')
  let res
  try {
    res = await fetch(USAGE_URL, {
      headers: {
        Authorization: 'Bearer ' + oauth.accessToken,
        'anthropic-beta': 'oauth-2025-04-20',
        'anthropic-version': '2023-06-01',
        'User-Agent': 'alpine-shell',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    return failure('offline')
  }
  if (res.status === 401) return failure('expired')
  if (res.status === 429) {
    retryAtMs = Date.now() + retryDelayMs(res.headers.get('retry-after'))
    return failure('rate-limited')
  }
  if (!res.ok) return failure('http-' + res.status)
  let data
  try {
    data = await res.json()
  } catch {
    return failure('bad-response')
  }
  if (!data || typeof data !== 'object') return failure('bad-response')
  const limits = mapLimits(data)
  lastGood = {
    ok: true,
    sessionPercent: sessionPercentFrom(data, limits),
    sessionResetsAtMs: resetMs(data.five_hour && data.five_hour.resets_at),
    sessionActive: sessionActiveFrom(data, limits),
    limits,
    subscriptionType: oauth.subscriptionType || null,
    updatedAtMs: Date.now(),
  }
  return lastGood
}

module.exports = (ctx) => ctx.poll('claude-usage', fetchUsage, 60000)
