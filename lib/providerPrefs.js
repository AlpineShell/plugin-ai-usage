const fs = require('fs')
const path = require('path')

const PROVIDER_IDS = ['claude', 'antigravity', 'opencode']
const PREFS_FILE_NAME = 'providers.json'

function prefsFile(dataDir) {
  return dataDir ? path.join(dataDir, PREFS_FILE_NAME) : null
}

function readStoredPrefs(dataDir) {
  const filePath = prefsFile(dataDir)
  if (!filePath) return {}
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function readEnabledProviders(dataDir) {
  const stored = readStoredPrefs(dataDir).enabled || {}
  return Object.fromEntries(PROVIDER_IDS.map((id) => [id, stored[id] !== false]))
}

function setProviderEnabled(dataDir, providerId, enabled) {
  if (!PROVIDER_IDS.includes(providerId)) throw new Error('unknown provider: ' + providerId)
  const filePath = prefsFile(dataDir)
  if (!filePath) throw new Error('plugin data directory unavailable')
  const next = { ...readEnabledProviders(dataDir), [providerId]: Boolean(enabled) }
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify({ enabled: next }), 'utf8')
  return next
}

module.exports = { PROVIDER_IDS, readEnabledProviders, setProviderEnabled }
