const {
  fetchClaudeUsage,
  fetchAntigravityUsage,
  fetchOpencodeUsage,
  resolveOpencodeKey,
  saveOpencodeKey,
} = require('./lib/providers')
const { launchAntigravityLogin } = require('./lib/antigravity')
const { PROVIDER_IDS, readEnabledProviders, setProviderEnabled } = require('./lib/providerPrefs')
const { createFetchSchedule } = require('./lib/fetchSchedule')
const { readCachedUsage, writeCachedUsage } = require('./lib/usageCache')

const CHANNEL = 'alpine-shell.ai-usage/usage'
const POLL_INTERVAL_MS = 60000
const DEFAULT_FETCHERS = {
  claude: fetchClaudeUsage,
  antigravity: fetchAntigravityUsage,
  opencode: fetchOpencodeUsage,
}
const STALE_FALLBACK_STATUSES = new Set(['error', 'expired', 'rate_limited'])

function startBackend(
  ctx,
  { fetchers = DEFAULT_FETCHERS, pollIntervalMs = POLL_INTERVAL_MS, launchLogin = launchAntigravityLogin } = {},
) {
  const lastOk = readCachedUsage(ctx.dataDir)
  const latest = {}
  const schedule = createFetchSchedule()
  let activeRefresh = null

  function persistCache() {
    writeCachedUsage(ctx.dataDir, lastOk)
  }

  function forget(providerId) {
    if (lastOk[providerId]) {
      delete lastOk[providerId]
      persistCache()
    }
    delete latest[providerId]
    schedule.reset(providerId)
  }

  function shownResult(providerId, result) {
    if (result.status === 'ok') {
      lastOk[providerId] = result
      persistCache()
      return result
    }
    if (STALE_FALLBACK_STATUSES.has(result.status) && lastOk[providerId]) {
      return { ...lastOk[providerId], stale: true, staleReason: result.status }
    }
    if (lastOk[providerId]) {
      delete lastOk[providerId]
      persistCache()
    }
    return result
  }

  async function currentResult(providerId, options = {}) {
    if (!options.force && latest[providerId] && !schedule.isDue(providerId)) return latest[providerId]
    const result = await fetchers[providerId]({
      dataDir: ctx.dataDir,
      forceCredentialRead: Boolean(options.forceCredentialRead),
    })
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

  function publishInitialCache() {
    const enabled = readEnabledProviders(ctx.dataDir)
    const providers = {}
    for (const id of PROVIDER_IDS) {
      if (enabled[id] && lastOk[id]) {
        providers[id] = { ...lastOk[id], stale: true, staleReason: 'cached' }
      }
    }
    if (Object.keys(providers).length > 0) {
      ctx.publish(CHANNEL, { providers, enabled, updatedAtMs: Date.now() })
    }
  }

  async function refresh({ forceProvider = null } = {}) {
    if (activeRefresh && !forceProvider) return activeRefresh
    const run = (async () => {
      const enabled = readEnabledProviders(ctx.dataDir)
      const providers = {}
      const enabledIds = PROVIDER_IDS.filter((id) => enabled[id])

      for (const id of PROVIDER_IDS) {
        if (!enabled[id]) forget(id)
      }

      await Promise.all(
        enabledIds.map(async (id) => {
          const force = forceProvider === id
          providers[id] = await currentResult(id, { force, forceCredentialRead: force })
        }),
      )

      const payload = { providers, enabled, updatedAtMs: Date.now() }
      ctx.publish(CHANNEL, payload)
      return payload
    })()
    activeRefresh = run
    try {
      return await run
    } finally {
      if (activeRefresh === run) activeRefresh = null
    }
  }

  publishInitialCache()
  refresh().catch((error) => ctx.log('initial refresh failed: ' + (error && error.message)))
  const timer = setInterval(() => {
    refresh().catch((error) => ctx.log('poll failed: ' + (error && error.message)))
  }, pollIntervalMs)

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
    if (name === 'refresh-antigravity-signin') {
      launchLogin({
        onExit: () => {
          delete latest.antigravity
          schedule.reset('antigravity')
          refresh({ forceProvider: 'antigravity' }).catch((error) =>
            ctx.log('post-login refresh failed: ' + (error && error.message)),
          )
        },
      })
      return providerStatus()
    }
    throw new Error('unknown command: ' + name)
  })

  return () => {
    clearInterval(timer)
  }
}

startBackend.startBackend = startBackend
module.exports = startBackend
