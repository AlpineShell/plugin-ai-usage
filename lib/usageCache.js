const fs = require('fs')
const path = require('path')

const CACHE_FILE_NAME = 'last-known.json'

function cacheFile(dataDir) {
  return dataDir ? path.join(dataDir, CACHE_FILE_NAME) : null
}

function isUsableEntry(entry) {
  return Boolean(entry && typeof entry === 'object' && entry.status === 'ok' && Array.isArray(entry.limits))
}

function readCachedUsage(dataDir) {
  const filePath = cacheFile(dataDir)
  if (!filePath) return {}
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out = {}
    for (const [id, entry] of Object.entries(parsed)) {
      if (isUsableEntry(entry)) out[id] = entry
    }
    return out
  } catch {
    return {}
  }
}

function writeCachedUsage(dataDir, entries) {
  const filePath = cacheFile(dataDir)
  if (!filePath) return
  const clean = {}
  for (const [id, entry] of Object.entries(entries || {})) {
    if (isUsableEntry(entry)) clean[id] = entry
  }
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, JSON.stringify(clean), 'utf8')
  } catch {}
}

module.exports = { CACHE_FILE_NAME, readCachedUsage, writeCachedUsage }
