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
  gemini: { label: 'Gemini', emptyHint: 'Sign in with Gemini CLI', defaultIcon: 'gemini' },
  opencode: { label: 'OpenCode Go', emptyHint: 'Add API key in Settings', defaultIcon: 'opencode' },
}

const PROVIDER_ORDER = ['claude', 'gemini', 'opencode']

const SWEEP_KEYFRAMES =
  '@keyframes ai-usage-sweep{0%{transform:translateX(-' +
  (SWEEP_WIDTH + 4) +
  'px)}100%{transform:translateX(' +
  (BAR_WIDTH + 4) +
  'px)}}'

function fillColor(pct, dark) {
  if (pct >= DANGER_PCT) return 'rgba(239,68,68,0.95)'
  if (pct >= WARN_PCT) return 'rgba(245,158,11,0.95)'
  return dark ? 'rgba(0,0,0,0.82)' : 'rgba(255,255,255,0.92)'
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

function ClaudeIcon({ size = 12 }) {
  return html`
    <svg width=${size} height=${size} viewBox="0 0 16 16" style=${{ display: 'block', flexShrink: 0 }}>
      <path
        fill="#D97757"
        d="M8 1L9.3 5.5L13.2 2.8L10.5 6.7L15 8L10.5 9.3L13.2 13.2L9.3 10.5L8 15L6.7 10.5L2.8 13.2L5.5 9.3L1 8L5.5 6.7L2.8 2.8L6.7 5.5L8 1Z"
      />
    </svg>
  `
}

function GeminiIcon({ size = 12 }) {
  const gradId = useId()
  return html`
    <svg width=${size} height=${size} viewBox="0 0 16 16" style=${{ display: 'block', flexShrink: 0 }}>
      <defs>
        <linearGradient id=${gradId} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#4285F4" />
          <stop offset="55%" stopColor="#9B72CB" />
          <stop offset="100%" stopColor="#D96570" />
        </linearGradient>
      </defs>
      <path
        fill=${`url(#${gradId})`}
        d="M8 0.8C8.4 4.8 11.2 7.6 15.2 8C11.2 8.4 8.4 11.2 8 15.2C7.6 11.2 4.8 8.4 0.8 8C4.8 7.6 7.6 4.8 8 0.8Z"
      />
    </svg>
  `
}

function OpencodeIcon({ size = 12, dark }) {
  const stroke = dark ? 'rgba(0,0,0,0.85)' : 'rgba(255,255,255,0.92)'
  const inner = dark ? 'rgba(0,0,0,0.42)' : 'rgba(255,255,255,0.45)'
  return html`
    <svg width=${size} height=${size} viewBox="0 0 16 16" style=${{ display: 'block', flexShrink: 0 }}>
      <rect x="2" y="1.5" width="12" height="13" rx="2.2" fill="none" stroke=${stroke} strokeWidth="2" />
      <rect x="5.5" y="5.5" width="5" height="6" rx="0.8" fill=${inner} />
    </svg>
  `
}

function ProviderIcon({ kind, size = 12, dark }) {
  if (kind === 'none') return null
  if (kind === 'claude') return html`<${ClaudeIcon} size=${size} />`
  if (kind === 'gemini') return html`<${GeminiIcon} size=${size} />`
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
  if (entry.status === 'auth_error') return 'Authentication expired'
  if (entry.status === 'error') return 'Unable to reach service'
  return null
}

function LimitRow({ limit, dark }) {
  const base = dark ? '0,0,0' : '255,255,255'
  const ratio = Math.max(0, Math.min(1, limit.percent / 100))
  const notStarted = limit.kind === 'session' && limit.active === false
  const reset = notStarted ? null : formatReset(limit.resetsAtMs)
  const footerParts = []
  if (limit.detail) footerParts.push(limit.detail)
  if (notStarted) footerParts.push('session not started')
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
                ${rows.map((limit) => html`<${LimitRow} key=${limit.key || limit.label} limit=${limit} dark=${dark} />`)}
              </div>
            `
          : html`<span style=${{ fontSize: '11px', color: `rgba(${base},0.5)` }}>No active limits</span>`}
    </div>
  `
}

function UsagePanel({ providers, enabledIds, dark }) {
  const base = dark ? '0,0,0' : '255,255,255'
  if (enabledIds.length === 0) {
    return html`
      <div style=${{ padding: '12px 14px', minWidth: '200px', fontSize: '12px', color: `rgba(${base},0.65)` }}>
        Enable a provider in Settings
      </div>
    `
  }
  const showHeader = enabledIds.length > 1 || enabledIds[0] !== 'claude' || Boolean(providers && providers.claude && providers.claude.status !== 'ok')

  return html`
    <div style=${{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '12px', minWidth: '216px' }}>
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
  const [claudeEnabled] = usePluginSetting(PLUGIN_ID, 'claudeEnabled')
  const [geminiEnabled] = usePluginSetting(PLUGIN_ID, 'geminiEnabled')
  const [opencodeEnabled] = usePluginSetting(PLUGIN_ID, 'opencodeEnabled')
  const [pillIcon] = usePluginSetting(PLUGIN_ID, 'pillIcon')
  const [barSource] = usePluginSetting(PLUGIN_ID, 'barSource')

  const enabledMap = {
    claude: claudeEnabled !== false,
    gemini: geminiEnabled !== false,
    opencode: opencodeEnabled !== false,
  }
  const enabledIds = PROVIDER_ORDER.filter((id) => enabledMap[id])
  const providers = snapshot && snapshot.providers ? snapshot.providers : null
  const primary = selectPrimary(providers, enabledIds, barSource || 'highest')

  const base = dark ? '0,0,0' : '255,255,255'
  const waitingForInitial = enabledIds.length > 0 && !providers
  const pct = primary ? primary.barPercent : 0
  const ratio = Math.max(0, Math.min(1, pct / 100))

  const resolvedIconKind =
    pillIcon === 'auto'
      ? primary
        ? PROVIDER_META[primary.id].defaultIcon
        : enabledIds.length > 0
          ? PROVIDER_META[enabledIds[0]].defaultIcon
          : 'clawd'
      : pillIcon || 'clawd'

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
    : html`
        <div
          style=${{
            width: ratio * 100 + '%',
            height: '100%',
            borderRadius: '999px',
            background: fillColor(pct, dark),
            transition: 'width 400ms ease, background 300ms ease',
          }}
        />
      `

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
      </div>
    </div>
  `

  return html`
    <${PopupMenu} trigger=${trigger}>
      <${UsagePanel} providers=${providers} enabledIds=${enabledIds} dark=${dark} />
    <//>
  `
}

function statusDotColor(status) {
  if (status === 'ok') return '#22c55e'
  if (status === 'auth_error' || status === 'error') return '#ef4444'
  return 'rgba(128,128,128,0.5)'
}

function connectionSummary(id, entry) {
  if (!entry) return 'Checking'
  if (entry.status === 'ok') return entry.plan ? `Connected · ${entry.plan}` : 'Connected'
  if (entry.status === 'no_credentials') return 'Not signed in'
  if (entry.status === 'auth_error') return 'Auth expired'
  return 'Unavailable'
}

export function SettingsPage() {
  const dark = useDarkText()
  const snapshot = usePluginData(DATA_CHANNEL, null)
  const [claudeEnabled] = usePluginSetting(PLUGIN_ID, 'claudeEnabled')
  const [geminiEnabled] = usePluginSetting(PLUGIN_ID, 'geminiEnabled')
  const [opencodeEnabled] = usePluginSetting(PLUGIN_ID, 'opencodeEnabled')
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [keyStatus, setKeyStatus] = useState({ configured: false, source: null })
  const [saving, setSaving] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    let alive = true
    sendCommand(PLUGIN_ID, 'opencode-key-status')
      .then((res) => {
        if (alive && res && res.ok && res.value) setKeyStatus(res.value)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  const base = dark ? '0,0,0' : '255,255,255'
  const surface = dark ? 'rgba(0,0,0,0.03)' : 'rgba(255,255,255,0.04)'
  const border = `1px solid rgba(${base},0.1)`
  const providers = snapshot && snapshot.providers ? snapshot.providers : {}
  const enabledMap = {
    claude: claudeEnabled !== false,
    gemini: geminiEnabled !== false,
    opencode: opencodeEnabled !== false,
  }

  async function handleRefresh() {
    setRefreshing(true)
    try {
      await sendCommand(PLUGIN_ID, 'refresh')
    } finally {
      setRefreshing(false)
    }
  }

  async function handleSaveKey(value) {
    setSaving(true)
    try {
      const res = await sendCommand(PLUGIN_ID, 'set-opencode-key', { apiKey: value })
      if (res && res.ok && res.value) {
        setKeyStatus({ configured: Boolean(res.value.configured), source: res.value.source || null })
        setApiKeyInput('')
      }
    } finally {
      setSaving(false)
    }
  }

  return html`
    <div style=${{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div
        style=${{
          border,
          borderRadius: '12px',
          background: surface,
          overflow: 'hidden',
        }}
      >
        <div
          style=${{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '10px 14px',
            borderBottom: border,
          }}
        >
          <span style=${{ fontSize: '12px', fontWeight: 600, color: `rgba(${base},0.85)` }}>Status</span>
          <button
            type="button"
            disabled=${refreshing}
            onClick=${handleRefresh}
            style=${{
              fontSize: '11px',
              padding: '4px 10px',
              borderRadius: '6px',
              border,
              background: 'transparent',
              color: `rgba(${base},0.85)`,
              cursor: refreshing ? 'default' : 'pointer',
              opacity: refreshing ? 0.5 : 1,
            }}
          >
            ${refreshing ? 'Refreshing' : 'Refresh'}
          </button>
        </div>
        ${PROVIDER_ORDER.filter((id) => enabledMap[id]).map(
          (id, idx) => html`
            <div
              key=${id}
              style=${{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '10px 14px',
                borderTop: idx > 0 ? border : 'none',
              }}
            >
              <div style=${{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <${ProviderIcon} kind=${PROVIDER_META[id].defaultIcon} size=${13} dark=${dark} />
                <span style=${{ fontSize: '13px', color: `rgba(${base},0.9)` }}>${PROVIDER_META[id].label}</span>
              </div>
              <div style=${{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span
                  style=${{
                    width: '6px',
                    height: '6px',
                    borderRadius: '999px',
                    background: statusDotColor(providers[id] && providers[id].status),
                  }}
                />
                <span style=${{ fontSize: '12px', color: `rgba(${base},0.6)` }}>${connectionSummary(id, providers[id])}</span>
              </div>
            </div>
          `,
        )}
      </div>

      ${enabledMap.opencode &&
      html`
        <div
          style=${{
            border,
            borderRadius: '12px',
            background: surface,
            padding: '12px 14px',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
          }}
        >
          <div style=${{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
            <span style=${{ fontSize: '13px', fontWeight: 500, color: `rgba(${base},0.9)` }}>OpenCode Go API key</span>
            ${keyStatus.configured &&
            html`
              <span style=${{ fontSize: '11px', color: `rgba(${base},0.55)` }}>
                ${keyStatus.source === 'settings' ? 'Saved' : `Using ${keyStatus.source}`}
              </span>
            `}
          </div>
          <div style=${{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <input
              type="password"
              value=${apiKeyInput}
              placeholder=${keyStatus.configured ? 'Replace saved key' : 'sk-...'}
              onChange=${(e) => setApiKeyInput(e.target.value)}
              style=${{
                flex: 1,
                fontSize: '12px',
                padding: '6px 10px',
                borderRadius: '6px',
                border,
                background: 'transparent',
                color: `rgba(${base},0.95)`,
                outline: 'none',
              }}
            />
            <button
              type="button"
              disabled=${saving || !apiKeyInput.trim()}
              onClick=${() => handleSaveKey(apiKeyInput)}
              style=${{
                fontSize: '12px',
                padding: '6px 12px',
                borderRadius: '6px',
                border,
                background: 'transparent',
                color: `rgba(${base},0.9)`,
                cursor: saving || !apiKeyInput.trim() ? 'default' : 'pointer',
                opacity: saving || !apiKeyInput.trim() ? 0.45 : 1,
              }}
            >
              Save
            </button>
            ${keyStatus.source === 'settings' &&
            html`
              <button
                type="button"
                disabled=${saving}
                onClick=${() => handleSaveKey('')}
                style=${{
                  fontSize: '12px',
                  padding: '6px 10px',
                  borderRadius: '6px',
                  border,
                  background: 'transparent',
                  color: 'rgba(239,68,68,0.9)',
                  cursor: saving ? 'default' : 'pointer',
                }}
              >
                Clear
              </button>
            `}
          </div>
        </div>
      `}
    </div>
  `
}
