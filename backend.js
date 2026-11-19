const {
  fetchClaudeUsage,
  fetchAntigravityUsage,
  fetchOpencodeUsage,
  resolveOpencodeKey,
  saveOpencodeKey,
} = require('./lib/providers')
const { PROVIDER_IDS, readEnabledProviders, setProviderEnabled } = require('./lib/providerPrefs')

const CHANNEL = 'alpine-shell.ai-usage/usage'
const POLL_INTERVAL_MS = 60000
const PROVIDER_FETCHERS = {
  claude: fetchClaudeUsage,
  antigravity: fetchAntigravityUsage,
  opencode: fetchOpencodeUsage,
}
const STALE_FALLBACK_STATUSES = new Set(['error', 'expired'])

module.exports = (ctx) => {
  const lastOk = {}
  let activeRefresh = null

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
        if (!enabled[id]) delete lastOk[id]
      }

      await Promise.all(
        enabledIds.map(async (id) => {
          const result = await PROVIDER_FETCHERS[id]({ dataDir: ctx.dataDir })
          if (result.status === 'ok') {
            lastOk[id] = result
            providers[id] = result
            return
          }
          if (STALE_FALLBACK_STATUSES.has(result.status) && lastOk[id]) {
            providers[id] = { ...lastOk[id], stale: true }
            return
          }
          delete lastOk[id]
          providers[id] = result
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
      await refresh()
      return providerStatus()
    }
    if (name === 'set-opencode-key') {
      const apiKey = payload && typeof payload.apiKey === 'string' ? payload.apiKey : ''
      saveOpencodeKey(ctx.dataDir, apiKey)
      await refresh()
      return providerStatus()
    }
    throw new Error('unknown command: ' + name)
  })

  return () => {
    clearInterval(timer)
  }
}
