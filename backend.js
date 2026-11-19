const {
  fetchClaudeUsage,
  fetchGeminiUsage,
  fetchOpencodeUsage,
  resolveOpencodeKey,
  saveOpencodeKey,
} = require('./lib/providers')

const CHANNEL = 'alpine-shell.ai-usage/usage'
const POLL_INTERVAL_MS = 60000
const PROVIDER_FETCHERS = {
  claude: fetchClaudeUsage,
  gemini: fetchGeminiUsage,
  opencode: fetchOpencodeUsage,
}
const PROVIDER_SETTING_KEYS = {
  claude: 'claudeEnabled',
  gemini: 'geminiEnabled',
  opencode: 'opencodeEnabled',
}

function isProviderEnabled(settings, providerId) {
  const value = settings.get(PROVIDER_SETTING_KEYS[providerId])
  return value !== false
}

module.exports = (ctx) => {
  const lastOk = {}
  let activeRefresh = null

  async function refresh() {
    if (activeRefresh) return activeRefresh
    activeRefresh = (async () => {
      const providers = {}
      const enabledIds = Object.keys(PROVIDER_FETCHERS).filter((id) => isProviderEnabled(ctx.settings, id))

      for (const id of Object.keys(PROVIDER_FETCHERS)) {
        if (!enabledIds.includes(id)) {
          delete lastOk[id]
        }
      }

      await Promise.all(
        enabledIds.map(async (id) => {
          const result = await PROVIDER_FETCHERS[id]({ dataDir: ctx.dataDir })
          if (result.status === 'ok') {
            lastOk[id] = result
            providers[id] = result
            return
          }
          if (result.status === 'error' && lastOk[id]) {
            providers[id] = { ...lastOk[id], stale: true }
            return
          }
          delete lastOk[id]
          providers[id] = result
        }),
      )

      const payload = { providers, updatedAtMs: Date.now() }
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

  const unsubscribeSettings = ctx.settings.onChange((key) => {
    if (Object.values(PROVIDER_SETTING_KEYS).includes(key)) {
      refresh().catch((error) => ctx.log('settings refresh failed: ' + (error && error.message)))
    }
  })

  ctx.onCommand(async (name, payload) => {
    if (name === 'refresh') {
      return refresh()
    }
    if (name === 'opencode-key-status') {
      const resolved = resolveOpencodeKey({ dataDir: ctx.dataDir })
      return { configured: Boolean(resolved.key), source: resolved.source }
    }
    if (name === 'set-opencode-key') {
      const apiKey = payload && typeof payload.apiKey === 'string' ? payload.apiKey : ''
      const saved = saveOpencodeKey(ctx.dataDir, apiKey)
      await refresh()
      const resolved = resolveOpencodeKey({ dataDir: ctx.dataDir })
      return { ...saved, configured: Boolean(resolved.key), source: resolved.source }
    }
    throw new Error('unknown command: ' + name)
  })

  return () => {
    clearInterval(timer)
    unsubscribeSettings()
  }
}
