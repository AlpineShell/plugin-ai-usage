const DEFAULT_FETCH_INTERVAL_MS = 60000
const FETCH_INTERVAL_MS = { claude: 300000 }
const DUE_TOLERANCE_MS = 5000
const RATE_LIMIT_BASE_MS = 300000
const RATE_LIMIT_MAX_MS = 1800000

function fetchIntervalMs(providerId) {
  return FETCH_INTERVAL_MS[providerId] || DEFAULT_FETCH_INTERVAL_MS
}

function nextBackoffMs(previousMs, retryAfterMs) {
  const doubled = Math.min(RATE_LIMIT_MAX_MS, Math.max(RATE_LIMIT_BASE_MS, (previousMs || 0) * 2))
  return Math.max(doubled, retryAfterMs || 0)
}

function createFetchSchedule(now = Date.now) {
  const nextFetchAt = {}
  const backoffMs = {}

  return {
    isDue(providerId) {
      return !nextFetchAt[providerId] || now() >= nextFetchAt[providerId] - DUE_TOLERANCE_MS
    },
    record(providerId, result) {
      if (result && result.status === 'rate_limited') {
        backoffMs[providerId] = nextBackoffMs(backoffMs[providerId], result.retryAfterMs)
        nextFetchAt[providerId] = now() + backoffMs[providerId]
        return
      }
      backoffMs[providerId] = 0
      nextFetchAt[providerId] = now() + fetchIntervalMs(providerId)
    },
    reset(providerId) {
      delete nextFetchAt[providerId]
      delete backoffMs[providerId]
    },
  }
}

module.exports = { createFetchSchedule, fetchIntervalMs, nextBackoffMs, RATE_LIMIT_BASE_MS, RATE_LIMIT_MAX_MS }
