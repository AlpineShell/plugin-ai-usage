const { html, usePluginData, useDarkText, useState, useEffect, PopupMenu } = window.alpine

const WARN_PCT = 70
const DANGER_PCT = 90
const BAR_WIDTH = 132
const BAR_HEIGHT = 8
const STALE_MS = 5 * 60000

function fillColor(pct, dark, stale) {
  if (stale) return dark ? 'rgba(0,0,0,0.3)' : 'rgba(255,255,255,0.35)'
  if (pct >= DANGER_PCT) return 'rgba(239,68,68,0.95)'
  if (pct >= WARN_PCT) return 'rgba(245,158,11,0.95)'
  return dark ? 'rgba(0,0,0,0.8)' : 'rgba(255,255,255,0.9)'
}

function failureText(reason) {
  if (reason === 'signed-out') return 'Sign in to Claude Code to see your usage'
  if (reason === 'expired') return 'Open Claude Code to refresh your login'
  if (reason === 'offline') return "Can't reach Anthropic"
  if (reason === 'rate-limited') return 'Too many requests, trying again soon'
  if (reason && reason.startsWith('http-')) return 'Usage unavailable (HTTP ' + reason.slice(5) + ')'
  return 'Usage unavailable'
}

function formatReset(ms) {
  if (!ms) return null
  const delta = ms - Date.now()
  if (delta <= 0) return 'resetting'
  const mins = Math.round(delta / 60000)
  if (mins < 60) return 'resets in ' + mins + 'm'
  const hours = Math.round(mins / 60)
  if (hours < 24) return 'resets in ' + hours + 'h'
  const days = Math.round(hours / 24)
  return 'resets in ' + days + 'd'
}

function formatAge(ms, now) {
  const mins = Math.max(0, Math.round((now - ms) / 60000))
  if (mins < 60) return 'updated ' + mins + 'm ago'
  const hours = Math.round(mins / 60)
  if (hours < 24) return 'updated ' + hours + 'h ago'
  return 'updated ' + Math.round(hours / 24) + 'd ago'
}

function useNow(everyMs) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs)
    return () => clearInterval(timer)
  }, [everyMs])
  return now
}

function LimitRow({ limit, dark }) {
  const base = dark ? '0,0,0' : '255,255,255'
  const ratio = Math.max(0, Math.min(1, limit.percent / 100))
  // A not-yet-started session has no meaningful reset countdown — say so instead.
  const notStarted = limit.kind === 'session' && limit.active === false
  const reset = notStarted ? null : formatReset(limit.resetsAtMs)
  const footer = notStarted ? 'session not started' : reset
  return html`
    <div style=${{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
      <div style=${{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '20px' }}>
        <span style=${{ fontSize: '12px', color: `rgba(${base},0.8)` }}>${limit.label}</span>
        <span style=${{ fontSize: '12px', fontWeight: 600, color: `rgba(${base},0.95)`, fontVariantNumeric: 'tabular-nums' }}>${Math.round(limit.percent) + '%'}</span>
      </div>
      <div style=${{ height: '5px', borderRadius: '999px', background: `rgba(${base},${dark ? 0.12 : 0.18})`, overflow: 'hidden' }}>
        <div style=${{ width: ratio * 100 + '%', height: '100%', borderRadius: '999px', background: fillColor(limit.percent, dark) }} />
      </div>
      ${footer && html`<span style=${{ fontSize: '10px', color: `rgba(${base},0.45)` }}>${footer}</span>`}
    </div>
  `
}

function UsagePanel({ usage, dark, stale, now }) {
  const base = dark ? '0,0,0' : '255,255,255'
  const rows = usage.limits && usage.limits.length ? usage.limits : [
    { key: 'session', kind: 'session', label: 'Session · 5h', percent: usage.sessionPercent, resetsAtMs: usage.sessionResetsAtMs, active: usage.sessionActive !== false },
  ]
  return html`
    <div style=${{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '12px', minWidth: '200px' }}>
      <div style=${{ display: 'flex', flexDirection: 'column', gap: '12px', filter: stale ? 'grayscale(1)' : 'none', opacity: stale ? 0.6 : 1 }}>
        ${rows.map((limit) => html`<${LimitRow} key=${limit.key || limit.label} limit=${limit} dark=${dark} />`)}
      </div>
      ${stale && html`<span style=${{ fontSize: '10px', color: `rgba(${base},0.45)` }}>${formatAge(usage.updatedAtMs, now)}</span>`}
    </div>
  `
}

function FailurePanel({ reason, dark }) {
  const base = dark ? '0,0,0' : '255,255,255'
  return html`
    <div style=${{ padding: '12px 14px', fontSize: '12px', color: `rgba(${base},0.8)`, whiteSpace: 'nowrap' }}>${failureText(reason)}</div>
  `
}

const SWEEP_WIDTH = 44
const SWEEP_KEYFRAMES =
  '@keyframes claude-usage-sweep{0%{transform:translateX(-' +
  (SWEEP_WIDTH + 4) +
  'px)}100%{transform:translateX(' +
  (BAR_WIDTH + 4) +
  'px)}}'

export default function UsageBar() {
  const dark = useDarkText()
  const usage = usePluginData('claude-usage', null)
  const now = useNow(30000)
  const base = dark ? '0,0,0' : '255,255,255'
  const loading = !usage
  const failed = !!usage && !usage.ok
  const stale = !!usage && usage.ok && now - usage.updatedAtMs > STALE_MS
  const pct = usage && usage.ok ? usage.sessionPercent : 0
  const ratio = Math.max(0, Math.min(1, pct / 100))

  const fill = loading
    ? html`
        <div
          style=${{
            width: SWEEP_WIDTH + 'px',
            height: '100%',
            borderRadius: '999px',
            background: `rgba(${base},${dark ? 0.4 : 0.5})`,
            animation: 'claude-usage-sweep 1.4s ease-in-out infinite',
          }}
        >
          <style>${SWEEP_KEYFRAMES}</style>
        </div>
      `
    : html`
        <div
          style=${{
            width: ratio * 100 + '%',
            height: '100%',
            borderRadius: '999px',
            background: fillColor(pct, dark, stale),
            transition: 'width 400ms ease, background 300ms ease',
          }}
        />
      `

  const trigger = html`
    <div style=${{ display: 'flex', alignItems: 'center', padding: '0 8px 0 2px', height: '100%' }}>
      <div
        style=${{
          width: BAR_WIDTH + 'px',
          height: BAR_HEIGHT + 'px',
          borderRadius: '999px',
          background: failed ? `rgba(${base},${dark ? 0.07 : 0.1})` : `rgba(${base},${dark ? 0.15 : 0.2})`,
          overflow: 'hidden',
        }}
      >
        ${fill}
      </div>
    </div>
  `

  if (loading) return trigger
  const panel = failed
    ? html`<${FailurePanel} reason=${usage.reason} dark=${dark} />`
    : html`<${UsagePanel} usage=${usage} dark=${dark} stale=${stale} now=${now} />`
  return html`<${PopupMenu} trigger=${trigger}>${panel}<//>`
}
