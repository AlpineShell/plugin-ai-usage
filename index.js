const {
  html,
  useState,
  useEffect,
  useId,
  usePluginData,
  usePluginSetting,
  useDarkText,
  sendCommand,
  PopupMenu,
} = window.alpine

const PLUGIN_ID = 'alpine-shell.ai-usage'
const DATA_CHANNEL = 'alpine-shell.ai-usage/usage'

const WARN_PCT = 70
const DANGER_PCT = 90
const BAR_WIDTH = 76
const BAR_HEIGHT = 5
const SWEEP_WIDTH = 28

const PROVIDER_META = {
  claude: { label: 'Claude', emptyHint: 'Sign in with Claude Code', defaultIcon: 'clawd' },
  antigravity: {
    label: 'Antigravity',
    emptyHint: 'Sign in with the Antigravity CLI',
    expiredHint: 'Refresh sign-in in Settings',
    defaultIcon: 'antigravity',
  },
  opencode: { label: 'OpenCode', emptyHint: 'Add API key in Settings', defaultIcon: 'opencode' },
}

const PROVIDER_ORDER = ['claude', 'antigravity', 'opencode']

function enabledProviderIds(enabled) {
  return PROVIDER_ORDER.filter((id) => !enabled || enabled[id] !== false)
}

const SWEEP_KEYFRAMES =
  '@keyframes ai-usage-sweep{0%{transform:translateX(-' +
  (SWEEP_WIDTH + 4) +
  'px)}100%{transform:translateX(' +
  (BAR_WIDTH + 4) +
  'px)}}'

const SEGMENT_GAP = 3

function fillColor(pct, dark) {
  if (pct >= DANGER_PCT) return 'rgba(239,68,68,0.95)'
  if (pct >= WARN_PCT) return 'rgba(245,158,11,0.95)'
  return dark ? 'rgba(0,0,0,0.82)' : 'rgba(255,255,255,0.92)'
}

function byUsageDescending(segments) {
  return [...segments].sort((a, b) => b.barPercent - a.barPercent || PROVIDER_ORDER.indexOf(a.id) - PROVIDER_ORDER.indexOf(b.id))
}

function segmentsForProvider(entry) {
  if (!entry || entry.status !== 'ok') return []
  if (entry.id === 'antigravity' && Array.isArray(entry.limits) && entry.limits.length > 1) {
    return entry.limits.map((limit) => ({
      id: entry.id,
      key: `${entry.id}:${limit.key || limit.label}`,
      barPercent: limit.percent,
    }))
  }
  return [{ id: entry.id, key: entry.id, barPercent: entry.barPercent }]
}

function barSegments(providers, enabledIds, barSource) {
  const ids = !barSource || barSource === 'all' ? enabledIds : barSource === 'highest' ? [] : [barSource]
  return ids.flatMap((id) => segmentsForProvider(providers && providers[id]))
}

function BarFill({ percent, color }) {
  const ratio = Math.max(0, Math.min(1, percent / 100))
  return html`
    <div
      style=${{
        width: ratio * 100 + '%',
        height: '100%',
        borderRadius: '999px',
        background: color,
        transition: 'width 400ms ease, background 300ms ease',
      }}
    />
  `
}

function stackedFillWidths(segments) {
  const share = (BAR_WIDTH - SEGMENT_GAP * (segments.length - 1)) / segments.length
  return segments.map((entry) => (share * Math.max(0, Math.min(100, entry.barPercent))) / 100)
}

const MIN_VISIBLE_PIECE_PX = 0.5
const MIN_FILL_PX = BAR_HEIGHT + 1

function stackedPieces(segments) {
  const widths = stackedFillWidths(segments)
  const fills = segments
    .map((entry, index) => ({
      key: entry.key || entry.id,
      percent: entry.barPercent,
      width: Math.max(MIN_FILL_PX, widths[index]),
    }))
    .filter((piece) => piece.percent > 0)
  const usedWidth = fills.reduce((sum, piece) => sum + piece.width, 0) + SEGMENT_GAP * Math.max(0, fills.length - 1)
  const freeWidth = BAR_WIDTH - usedWidth - (fills.length > 0 ? SEGMENT_GAP : 0)
  return { fills, freeWidth: freeWidth >= MIN_VISIBLE_PIECE_PX ? freeWidth : 0 }
}

function StackedBar({ segments, dark }) {
  const base = dark ? '0,0,0' : '255,255,255'
  const { fills, freeWidth } = stackedPieces(byUsageDescending(segments))
  const piece = (width, background, marginLeft) => ({
    flex: '0 0 auto',
    width: width + 'px',
    marginLeft: marginLeft + 'px',
    height: '100%',
    borderRadius: '999px',
    background,
    transition: 'width 400ms ease, margin-left 400ms ease, background 300ms ease',
  })
  return html`
    <div style=${{ display: 'flex', width: BAR_WIDTH + 'px', height: BAR_HEIGHT + 'px' }}>
      ${fills.map(
        (fill, index) =>
          html`<div key=${fill.key} style=${piece(fill.width, fillColor(fill.percent, dark), index > 0 ? SEGMENT_GAP : 0)} />`,
      )}
      ${freeWidth > 0 &&
      html`<div key="free" style=${piece(freeWidth, `rgba(${base},${dark ? 0.14 : 0.18})`, fills.length > 0 ? SEGMENT_GAP : 0)} />`}
    </div>
  `
}

function formatDuration(totalMinutes) {
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor((totalMinutes % 1440) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}min` : `${hours}h`
  return `${Math.max(1, minutes)}min`
}

function formatResetClock(ms) {
  const at = new Date(ms)
  const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (at.toDateString() === new Date().toDateString()) return time
  return at.toLocaleDateString([], { weekday: 'short' }) + ' ' + time
}

function formatReset(ms, stale = false) {
  if (!ms) return null
  const delta = ms - Date.now()
  if (delta <= 0) return stale ? 'reset passed' : 'resetting'
  return `resets in ${formatDuration(Math.ceil(delta / 60000))} · ${formatResetClock(ms)}`
}

function formatAge(updatedAtMs) {
  if (!updatedAtMs) return null
  const mins = Math.floor((Date.now() - updatedAtMs) / 60000)
  if (mins < 1) return 'just now'
  return `${formatDuration(mins)} ago`
}

function staleReasonLabel(reason) {
  if (reason === 'rate_limited') return 'rate limited'
  if (reason === 'expired') return 'sign-in expired'
  if (reason === 'error') return 'offline'
  return null
}

function staleFooter(entry) {
  if (!entry || !entry.stale) return null
  const age = formatAge(entry.updatedAtMs)
  const reason = staleReasonLabel(entry.staleReason)
  const parts = [age ? `cached ${age}` : 'cached', reason].filter(Boolean)
  return parts.join(' · ')
}

function ClawdIcon({ size = 12 }) {
  const height = Math.round(size * 0.875 * 10) / 10
  return html`
    <svg width=${size} height=${height} viewBox="0 0 16 14" style=${{ display: 'block', flexShrink: 0 }}>
      <path
        fill="#D97757"
        fillRule="evenodd"
        d="M2 1H14V6H16V9H14V11H13V14H11.6V11H10.6V14H9.2V11H6.8V14H5.4V11H4.4V14H3V11H2V9H0V6H2V1ZM4 3.5V6H5.5V3.5H4ZM10.5 3.5V6H12V3.5H10.5Z"
      />
    </svg>
  `
}

const CLAUDE_LOGO_PATH =
  'M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z'

const ANTIGRAVITY_LOGO_PATH =
  'M21.751 22.607c1.34 1.005 3.35.335 1.508-1.508C17.73 15.74 18.904 1 12.037 1 5.17 1 6.342 15.74.815 21.1c-2.01 2.009.167 2.511 1.507 1.506 5.192-3.517 4.857-9.714 9.715-9.714 4.857 0 4.522 6.197 9.714 9.715z'

const OPENCODE_LOGO_PATH = 'M16 6H8v12h8V6zm4 16H4V2h16v20z'

function ClaudeIcon({ size = 12 }) {
  return html`
    <svg width=${size} height=${size} viewBox="0 0 24 24" style=${{ display: 'block', flexShrink: 0 }}>
      <path fill="#D97757" d=${CLAUDE_LOGO_PATH} />
    </svg>
  `
}

function AntigravityIcon({ size = 12 }) {
  const gradId = useId()
  return html`
    <svg width=${size} height=${size} viewBox="0 0 24 24" style=${{ display: 'block', flexShrink: 0 }}>
      <defs>
        <linearGradient id=${gradId} x1="0" y1="1" x2="1" y2="0">
          <stop offset="0%" stopColor="#00B95C" />
          <stop offset="40%" stopColor="#3186FF" />
          <stop offset="75%" stopColor="#FC413D" />
          <stop offset="100%" stopColor="#FFE432" />
        </linearGradient>
      </defs>
      <path fill=${`url(#${gradId})`} d=${ANTIGRAVITY_LOGO_PATH} />
    </svg>
  `
}

function OpencodeIcon({ size = 12, dark }) {
  const fill = dark ? 'rgba(0,0,0,0.85)' : 'rgba(255,255,255,0.92)'
  return html`
    <svg width=${size} height=${size} viewBox="0 0 24 24" style=${{ display: 'block', flexShrink: 0 }}>
      <path fill=${fill} fillRule="evenodd" d=${OPENCODE_LOGO_PATH} />
    </svg>
  `
}

function ProviderIcon({ kind, size = 12, dark }) {
  if (kind === 'none') return null
  if (kind === 'claude') return html`<${ClaudeIcon} size=${size} />`
  if (kind === 'antigravity') return html`<${AntigravityIcon} size=${size} />`
  if (kind === 'opencode') return html`<${OpencodeIcon} size=${size} dark=${dark} />`
  return html`<${ClawdIcon} size=${size} />`
}

function selectPrimary(providers, enabledIds, barSource) {
  const okList = enabledIds
    .map((id) => providers && providers[id])
    .filter((entry) => entry && entry.status === 'ok')
  if (okList.length === 0) return null
  if (barSource && barSource !== 'highest') {
    const picked = okList.find((entry) => entry.id === barSource)
    if (picked) return picked
  }
  return okList.reduce((best, item) => (!best || item.barPercent > best.barPercent ? item : best), null)
}

function statusLabel(providerId, entry) {
  if (!entry) return 'Loading'
  if (entry.status === 'no_credentials') return PROVIDER_META[providerId].emptyHint
  if (entry.status === 'expired') return PROVIDER_META[providerId].expiredHint || 'Authentication expired'
  if (entry.status === 'auth_error') return 'Authentication expired'
  if (entry.status === 'no_subscription') return 'Pay as you go, no limits to show'
  if (entry.status === 'rate_limited') return 'Rate limited · retrying soon'
  if (entry.status === 'error') return 'Unable to reach service'
  return null
}

function LimitRow({ limit, dark, stale }) {
  const base = dark ? '0,0,0' : '255,255,255'
  const ratio = Math.max(0, Math.min(1, limit.percent / 100))
  const idle = limit.active === false
  const reset = idle ? null : formatReset(limit.resetsAtMs, stale)
  const footerParts = []
  if (limit.detail) footerParts.push(limit.detail)
  if (idle && limit.kind === 'session') footerParts.push('session not started')
  else if (reset) footerParts.push(reset)
  const footer = footerParts.join(' · ')

  return html`
    <div style=${{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
      <div style=${{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '20px' }}>
        <span style=${{ fontSize: '12px', color: `rgba(${base},0.8)` }}>${limit.label}</span>
        <span style=${{ fontSize: '12px', fontWeight: 600, color: `rgba(${base},0.95)`, fontVariantNumeric: 'tabular-nums' }}>
          ${Math.round(limit.percent) + '%'}
        </span>
      </div>
      <div style=${{ height: '5px', borderRadius: '999px', background: `rgba(${base},${dark ? 0.12 : 0.18})`, overflow: 'hidden' }}>
        <div style=${{ width: ratio * 100 + '%', height: '100%', borderRadius: '999px', background: fillColor(limit.percent, dark) }} />
      </div>
      ${footer && html`<span style=${{ fontSize: '10px', color: `rgba(${base},0.48)` }}>${footer}</span>`}
    </div>
  `
}

function ProviderSection({ providerId, entry, dark, showHeader }) {
  const base = dark ? '0,0,0' : '255,255,255'
  const meta = PROVIDER_META[providerId]
  const message = statusLabel(providerId, entry)
  const rows = entry && entry.status === 'ok' && Array.isArray(entry.limits) ? entry.limits : []
  const cachedNote = entry && entry.status === 'ok' ? staleFooter(entry) : null

  return html`
    <div style=${{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      ${showHeader &&
      html`
        <div style=${{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
          <div style=${{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <${ProviderIcon} kind=${meta.defaultIcon} size=${12} dark=${dark} />
            <span style=${{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.01em', color: `rgba(${base},0.9)` }}>
              ${meta.label}
            </span>
          </div>
          ${entry &&
          entry.plan &&
          html`
            <span
              style=${{
                fontSize: '10px',
                color: `rgba(${base},0.55)`,
                border: `1px solid rgba(${base},0.16)`,
                borderRadius: '999px',
                padding: '1px 6px',
                lineHeight: '14px',
              }}
            >
              ${entry.plan}
            </span>
          `}
        </div>
      `}
      ${message
        ? html`<span style=${{ fontSize: '11px', color: `rgba(${base},0.5)` }}>${message}</span>`
        : rows.length > 0
          ? html`
              <div style=${{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                ${rows.map((limit) => html`<${LimitRow} key=${limit.key || limit.label} limit=${limit} dark=${dark} stale=${Boolean(entry.stale)} />`)}
              </div>
            `
          : html`<span style=${{ fontSize: '11px', color: `rgba(${base},0.5)` }}>No active limits</span>`}
      ${cachedNote && html`<span style=${{ fontSize: '10px', color: `rgba(${base},0.42)` }}>${cachedNote}</span>`}
    </div>
  `
}

function UsagePanel({ providers, enabledIds, dark }) {
  const base = dark ? '0,0,0' : '255,255,255'
  if (enabledIds.length === 0) {
    return html`
      <div style=${{ width: '240px', boxSizing: 'border-box', padding: '12px 14px 14px', fontSize: '12px', color: `rgba(${base},0.65)` }}>
        Enable a provider in Settings
      </div>
    `
  }
  const showHeader = enabledIds.length > 1 || enabledIds[0] !== 'claude' || Boolean(providers && providers.claude && providers.claude.status !== 'ok')

  return html`
    <div style=${{ width: '240px', boxSizing: 'border-box', padding: '12px 14px 14px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
      ${enabledIds.map(
        (id, index) => html`
          <div key=${id} style=${{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            ${index > 0 && html`<div style=${{ height: '1px', background: `rgba(${base},0.09)` }} />`}
            <${ProviderSection} providerId=${id} entry=${providers && providers[id]} dark=${dark} showHeader=${showHeader} />
          </div>
        `,
      )}
    </div>
  `
}

export default function UsagePill() {
  const dark = useDarkText()
  const snapshot = usePluginData(DATA_CHANNEL, null)
  const [pillIcon] = usePluginSetting(PLUGIN_ID, 'pillIcon')
  const [barSource] = usePluginSetting(PLUGIN_ID, 'barSource')

  const enabledIds = enabledProviderIds(snapshot && snapshot.enabled)
  const providers = snapshot && snapshot.providers ? snapshot.providers : null
  const showAll = !barSource || barSource === 'all'
  const primary = selectPrimary(providers, enabledIds, showAll ? 'highest' : barSource)
  const segments = barSegments(providers, enabledIds, barSource)
  const splitBar = segments.length > 1

  const base = dark ? '0,0,0' : '255,255,255'
  const waitingForInitial = enabledIds.length > 0 && !providers
  const pct = primary ? primary.barPercent : 0

  const resolvedIconKind =
    pillIcon === 'auto'
      ? primary
        ? PROVIDER_META[primary.id].defaultIcon
        : enabledIds.length > 0
          ? PROVIDER_META[enabledIds[0]].defaultIcon
          : 'clawd'
      : pillIcon || 'none'

  const showIcon = resolvedIconKind !== 'none'

  const fill = waitingForInitial
    ? html`
        <div
          style=${{
            width: SWEEP_WIDTH + 'px',
            height: '100%',
            borderRadius: '999px',
            background: `rgba(${base},${dark ? 0.4 : 0.5})`,
            animation: 'ai-usage-sweep 1.4s ease-in-out infinite',
          }}
        >
          <style>${SWEEP_KEYFRAMES}</style>
        </div>
      `
    : html`<${BarFill} percent=${pct} color=${fillColor(pct, dark)} />`

  const trigger = html`
    <div style=${{ display: 'flex', alignItems: 'center', height: '100%', padding: '0 2px' }}>
      <div
        style=${{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          height: '18px',
          padding: showIcon ? '0 7px 0 5px' : '0 7px',
          borderRadius: '999px',
          background: 'transparent',
          border: dark ? '1px solid rgba(0,0,0,0.22)' : '1px solid rgba(255,255,255,0.28)',
          boxSizing: 'border-box',
        }}
      >
        ${showIcon && html`<${ProviderIcon} kind=${resolvedIconKind} size=${12} dark=${dark} />`}
        ${splitBar && !waitingForInitial
          ? html`<${StackedBar} segments=${segments} dark=${dark} />`
          : html`
              <div
                style=${{
                  width: BAR_WIDTH + 'px',
                  height: BAR_HEIGHT + 'px',
                  borderRadius: '999px',
                  background: `rgba(${base},${dark ? 0.14 : 0.18})`,
                  overflow: 'hidden',
                }}
              >
                ${fill}
              </div>
            `}
      </div>
    </div>
  `

  return html`
    <${PopupMenu} trigger=${trigger}>
      <${UsagePanel} providers=${providers} enabledIds=${enabledIds} dark=${dark} />
    <//>
  `
}

const SETTINGS_CARD = 'rounded-card bg-fill-ghost divide-y divide-line-hairline overflow-hidden'
const SETTINGS_ROW = 'flex min-h-12 items-center justify-between gap-4 px-3.5 py-2.5'
const SECTION_LABEL = 'pl-1 text-[11px] font-medium text-ink-quiet'
const BUTTON_BASE =
  'focus-ring inline-flex cursor-pointer items-center justify-center gap-2 rounded-field font-medium transition-colors disabled:pointer-events-none disabled:opacity-60 h-7 px-3 text-dense'
const BUTTON_VARIANTS = {
  primary: 'bg-fill-solid text-on-solid hover:bg-fill-solid-hover',
  soft: 'bg-ink-primary/8 text-ink-primary hover:bg-ink-primary/13',
  ghost: 'bg-transparent text-ink-primary hover:bg-fill-ghost',
  dangerSoft: 'bg-ink-primary/8 text-danger hover:bg-danger/12',
}
const DEFAULT_PROVIDER_STATUS = {
  enabled: { claude: true, antigravity: true, opencode: true },
  opencodeKey: { configured: false, source: null },
}

function normalizeProviderStatus(value) {
  const source = value && typeof value === 'object' ? value : {}
  const opencodeKey = source.opencodeKey && typeof source.opencodeKey === 'object' ? source.opencodeKey : {}
  return {
    enabled: { ...DEFAULT_PROVIDER_STATUS.enabled, ...(source.enabled && typeof source.enabled === 'object' ? source.enabled : {}) },
    opencodeKey: { configured: Boolean(opencodeKey.configured), source: opencodeKey.source || null },
  }
}

function SettingsButton({ variant = 'soft', disabled, onClick, children }) {
  return html`
    <button type="button" disabled=${disabled} onClick=${onClick} className=${`${BUTTON_BASE} ${BUTTON_VARIANTS[variant]}`}>
      ${children}
    </button>
  `
}

function SettingsToggle({ checked, label, onChange }) {
  return html`
    <button
      type="button"
      role="switch"
      aria-checked=${checked}
      aria-label=${label}
      onClick=${() => onChange(!checked)}
      className=${`focus-ring relative h-[22px] w-[38px] shrink-0 cursor-pointer rounded-full transition-colors duration-200 ease-state ${
        checked ? 'bg-fill-solid' : 'bg-fill-track'
      }`}
    >
      <span
        className=${`absolute top-[3px] h-4 w-4 rounded-full shadow-[0_1px_2px_rgba(0,0,0,0.25)] transition-[left,background-color] duration-200 ease-state ${
          checked ? 'left-[19px] bg-on-solid' : 'left-[3px] bg-toggle-knob'
        }`}
      />
    </button>
  `
}

function CogIcon() {
  return html`
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path
        d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"
      />
      <circle cx="12" cy="12" r="3" />
    </svg>
  `
}

function CogButton({ label, onClick }) {
  return html`
    <button
      type="button"
      aria-label=${label}
      title=${label}
      onClick=${onClick}
      className="focus-ring flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-field text-ink-quiet transition-colors hover:bg-fill-ghost hover:text-ink-primary"
    >
      <${CogIcon} />
    </button>
  `
}

function providerSummary(providerId, enabled, entry, opencodeKey) {
  if (!enabled) return 'Off'
  if (providerId === 'opencode' && !opencodeKey.configured) return 'No API key'
  if (!entry) return 'Checking'
  if (entry.status === 'ok') {
    const label = entry.plan || 'Connected'
    if (!entry.stale) return label
    const reason = staleReasonLabel(entry.staleReason)
    return reason ? `${label} · cached (${reason})` : `${label} · cached`
  }
  if (entry.status === 'no_credentials') return 'Not signed in'
  if (entry.status === 'expired') return 'Sign-in expired'
  if (entry.status === 'auth_error') return 'Key or sign-in refused'
  if (entry.status === 'no_subscription') return 'Zen · pay as you go'
  if (entry.status === 'rate_limited') return 'Rate limited, retrying soon'
  return 'Unavailable'
}

function OpencodeKeyEditor({ opencodeKey, busy, onSave, onCancel }) {
  const [value, setValue] = useState('')
  const canSave = !busy && value.trim().length > 0
  const savedHere = opencodeKey.source === 'settings'

  return html`
    <div className="flex flex-col gap-2 px-3.5 py-2.5">
      <div
        className="flex h-8 items-center gap-2 rounded-field border border-line-hairline bg-surface-2 px-3 transition-colors focus-within:border-line-strong"
      >
        <input
          type="password"
          autoFocus
          value=${value}
          aria-label="OpenCode API key"
          placeholder=${opencodeKey.configured ? 'New API key' : 'oc_sk_...'}
          onChange=${(event) => setValue(event.target.value)}
          onKeyDown=${(event) => {
            if (event.key === 'Enter' && canSave) onSave(value)
            if (event.key === 'Escape') onCancel()
          }}
          className="w-full bg-transparent text-dense text-ink-primary outline-none placeholder:text-ink-faint"
        />
      </div>
      <div className="flex items-center gap-2">
        <${SettingsButton} variant="primary" disabled=${!canSave} onClick=${() => onSave(value)}>Save<//>
        <${SettingsButton} variant="ghost" disabled=${busy} onClick=${onCancel}>Cancel<//>
        ${savedHere &&
        html`
          <div className="ml-auto">
            <${SettingsButton} variant="dangerSoft" disabled=${busy} onClick=${() => onSave('')}>Remove key<//>
          </div>
        `}
      </div>
    </div>
  `
}

function antigravitySignInAction(entry) {
  if (!entry) return null
  if (entry.status === 'no_credentials') return 'Sign in'
  if (entry.status === 'expired' || entry.status === 'auth_error') return 'Refresh sign-in'
  if (entry.status === 'ok' && entry.stale && entry.staleReason === 'expired') return 'Refresh sign-in'
  return null
}

function ProviderRow({
  providerId,
  enabled,
  entry,
  opencodeKey,
  dark,
  editingKey,
  busy,
  onToggle,
  onEditKey,
  onRefreshAntigravity,
}) {
  const meta = PROVIDER_META[providerId]
  const isOpencode = providerId === 'opencode'
  const showKeyAction = isOpencode && enabled && !editingKey
  const antigravityAction = providerId === 'antigravity' && enabled ? antigravitySignInAction(entry) : null

  return html`
    <div className=${SETTINGS_ROW}>
      <div className="flex min-w-0 items-center gap-3">
        <${ProviderIcon} kind=${meta.defaultIcon} size=${16} dark=${dark} />
        <div className="min-w-0">
          <div className="text-sm text-ink-primary">${meta.label}</div>
          <div className="mt-0.5 text-xs text-ink-quiet">${providerSummary(providerId, enabled, entry, opencodeKey)}</div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        ${antigravityAction &&
        html`<${SettingsButton} variant="soft" disabled=${busy} onClick=${onRefreshAntigravity}>${antigravityAction}<//>`}
        ${showKeyAction &&
        (opencodeKey.configured
          ? html`<${CogButton} label="Change API key" onClick=${onEditKey} />`
          : html`<${SettingsButton} variant="soft" onClick=${onEditKey}>Set up<//>`)}
        <${SettingsToggle} checked=${enabled} label=${meta.label} onChange=${(next) => onToggle(providerId, next)} />
      </div>
    </div>
  `
}

export function SettingsPage() {
  const dark = useDarkText()
  const snapshot = usePluginData(DATA_CHANNEL, null)
  const [status, setStatus] = useState(DEFAULT_PROVIDER_STATUS)
  const [editingKey, setEditingKey] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    sendCommand(PLUGIN_ID, 'provider-status')
      .then((res) => {
        if (alive && res && res.ok && res.value) setStatus(normalizeProviderStatus(res.value))
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  const providers = snapshot && snapshot.providers ? snapshot.providers : {}

  async function runCommand(name, payload) {
    setBusy(true)
    try {
      const res = await sendCommand(PLUGIN_ID, name, payload)
      if (res && res.ok && res.value) setStatus(normalizeProviderStatus(res.value))
      return Boolean(res && res.ok)
    } finally {
      setBusy(false)
    }
  }

  function handleToggle(providerId, enabled) {
    setStatus((current) => ({ ...current, enabled: { ...current.enabled, [providerId]: enabled } }))
    if (providerId === 'opencode' && !enabled) setEditingKey(false)
    runCommand('set-provider-enabled', { id: providerId, enabled })
  }

  async function handleSaveKey(apiKey) {
    if (await runCommand('set-opencode-key', { apiKey })) setEditingKey(false)
  }

  return html`
    <section className="flex flex-col gap-2">
      <h2 className=${SECTION_LABEL}>Providers</h2>
      <div className=${SETTINGS_CARD}>
        ${PROVIDER_ORDER.map(
          (id) => html`
            <div key=${id}>
              <${ProviderRow}
                providerId=${id}
                enabled=${status.enabled[id] !== false}
                entry=${providers[id]}
                opencodeKey=${status.opencodeKey}
                dark=${dark}
                editingKey=${editingKey}
                busy=${busy}
                onToggle=${handleToggle}
                onEditKey=${() => setEditingKey(true)}
                onRefreshAntigravity=${() => runCommand('refresh-antigravity-signin')}
              />
              ${id === 'opencode' &&
              editingKey &&
              status.enabled.opencode !== false &&
              html`
                <${OpencodeKeyEditor}
                  opencodeKey=${status.opencodeKey}
                  busy=${busy}
                  onSave=${handleSaveKey}
                  onCancel=${() => setEditingKey(false)}
                />
              `}
            </div>
          `,
        )}
      </div>
    </section>
  `
}
