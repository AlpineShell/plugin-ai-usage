const {
  fetchClaudeUsage,
  fetchAntigravityUsage,
  fetchOpencodeUsage,
  resolveOpencodeKey,
  saveOpencodeKey,
} = require('./lib/providers')
const { PROVIDER_IDS, readEnabledProviders, setProviderEnabled } = require('./lib/providerPrefs')
const { createFetchSchedule } = require('./lib/fetchSchedule')

const CHANNEL = 'alpine-shell.ai-usage/usage'
const POLL_INTERVAL_MS = 60000
const PROVIDER_FETCHERS = {
  claude: fetchClaudeUsage,
  antigravity: fetchAntigravityUsage,
  opencode: fetchOpencodeUsage,
}
const STALE_FALLBACK_STATUSES = new Set(['error', 'expired', 'rate_limited'])

module.exports = (ctx) => {
  const lastOk = {}
  const latest = {}
  const schedule = createFetchSchedule()
  let activeRefresh = null

  function forget(providerId) {
    delete lastOk[providerId]
    delete latest[providerId]
    schedule.reset(providerId)
  }

  function shownResult(providerId, result) {
    if (result.status === 'ok') {
      lastOk[providerId] = result
      return result
    }
    if (STALE_FALLBACK_STATUSES.has(result.status) && lastOk[providerId]) {
      return { ...lastOk[providerId], stale: true }
    }
    delete lastOk[providerId]
    return result
  }

  async function currentResult(providerId) {
    if (latest[providerId] && !schedule.isDue(providerId)) return latest[providerId]
    const result = await PROVIDER_FETCHERS[providerId]({ dataDir: ctx.dataDir })
    schedule.record(providerId, result)
    latest[providerId] = shownResult(providerId, result)
    return latest[providerId]
  }

  function providerStatus() {
    const key = resolveOpencodeKey({ dataDir: ctx.dataDir })
    return {
      enabled: readEnabledProviders(ctx.dataDir),
      opencodeKey: { configured: Boolean(key.key), source: key.source },
    }
  }

  async function refresh() {
    if (activeRefresh) return activeRefresh
    activeRefresh = (async () => {
      const enabled = readEnabledProviders(ctx.dataDir)
      const providers = {}
      const enabledIds = PROVIDER_IDS.filter((id) => enabled[id])

      for (const id of PROVIDER_IDS) {
        if (!enabled[id]) forget(id)
      }

      await Promise.all(
        enabledIds.map(async (id) => {
          providers[id] = await currentResult(id)
        }),
      )

      const payload = { providers, enabled, updatedAtMs: Date.now() }
      ctx.publish(CHANNEL, payload)
      return payload
    })()
    try {
      return await activeRefresh
    } finally {
      activeRefresh = null
    }
  }

  refresh().catch((error) => ctx.log('initial refresh failed: ' + (error && error.message)))
  const timer = setInterval(() => {
    refresh().catch((error) => ctx.log('poll failed: ' + (error && error.message)))
  }, POLL_INTERVAL_MS)

  ctx.onCommand(async (name, payload) => {
    if (name === 'refresh') {
      return refresh()
    }
    if (name === 'provider-status') {
      return providerStatus()
    }
    if (name === 'set-provider-enabled') {
      setProviderEnabled(ctx.dataDir, payload && payload.id, payload && payload.enabled)
      if (payload && payload.enabled) delete latest[payload.id]
      await refresh()
      return providerStatus()
    }
    if (name === 'set-opencode-key') {
      const apiKey = payload && typeof payload.apiKey === 'string' ? payload.apiKey : ''
      saveOpencodeKey(ctx.dataDir, apiKey)
      forget('opencode')
      await refresh()
      return providerStatus()
    }
    throw new Error('unknown command: ' + name)
  })

  return () => {
    clearInterval(timer)
  }
}
