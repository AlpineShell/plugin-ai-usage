const os = require('os')
const path = require('path')
const fs = require('fs')
const { execFile } = require('child_process')

const ANTIGRAVITY_CREDENTIAL_TARGET = 'gemini:antigravity'
const CODE_ASSIST_BASES = ['https://daily-cloudcode-pa.googleapis.com', 'https://cloudcode-pa.googleapis.com']
const LOAD_CODE_ASSIST_PATH = '/v1internal:loadCodeAssist'
const FETCH_MODELS_PATH = '/v1internal:fetchAvailableModels'
const ANTIGRAVITY_USER_AGENT = 'antigravity'
const TOKEN_MARGIN_MS = 60000
const CREDENTIAL_REREAD_INTERVAL_MS = 300000
const CREDENTIAL_READ_TIMEOUT_MS = 30000
const GOOGLE_PROVIDER = 'MODEL_PROVIDER_GOOGLE'
const GOOGLE_POOL = 'gemini'
const PARTNER_POOL = 'partner'
const PROVIDER_FAMILY_NAMES = {
  MODEL_PROVIDER_ANTHROPIC: 'Claude',
  MODEL_PROVIDER_OPENAI: 'GPT-OSS',
}

const READ_CREDENTIAL_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class AlpineAiUsageCredential {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct Credential {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob;
    public int Persist; public int AttributeCount; public IntPtr Attributes;
    public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredReadW(string target, int type, int flags, out IntPtr credential);
  [DllImport("advapi32.dll")]
  static extern void CredFree(IntPtr credential);
  public static string ReadBase64(string target) {
    IntPtr pointer;
    if (!CredReadW(target, 1, 0, out pointer)) return "";
    try {
      Credential credential = (Credential)Marshal.PtrToStructure(pointer, typeof(Credential));
      byte[] blob = new byte[credential.CredentialBlobSize];
      Marshal.Copy(credential.CredentialBlob, blob, 0, blob.Length);
      return Convert.ToBase64String(blob);
    } finally {
      CredFree(pointer);
    }
  }
}
"@
[Console]::Out.Write([AlpineAiUsageCredential]::ReadBase64('${ANTIGRAVITY_CREDENTIAL_TARGET}'))
`

function encodePowerShellCommand(script) {
  return Buffer.from(script, 'utf16le').toString('base64')
}

function readAntigravityCredential({ platform = process.platform, execFileImpl = execFile } = {}) {
  if (platform !== 'win32') return Promise.resolve(null)
  return new Promise((resolve) => {
    execFileImpl(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePowerShellCommand(READ_CREDENTIAL_SCRIPT)],
      { windowsHide: true, timeout: CREDENTIAL_READ_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) return resolve(null)
        resolve(parseCredentialBlob(String(stdout || '').trim()))
      },
    )
  })
}

function parseCredentialBlob(base64) {
  if (!base64) return null
  try {
    return JSON.parse(Buffer.from(base64, 'base64').toString('utf8').replace(/^﻿/, ''))
  } catch {
    return null
  }
}

function tokenFromCredential(credential) {
  const token = credential && credential.token
  if (!token || typeof token.access_token !== 'string' || !token.access_token) return null
  const expiresAtMs = Date.parse(token.expiry)
  return { accessToken: token.access_token, expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : 0 }
}

function readCachedProjectId(homedir) {
  try {
    const value = fs.readFileSync(path.join(homedir, '.gemini', 'antigravity-cli', 'cache', 'default_project_id.txt'), 'utf8')
    return value.trim() || null
  } catch {
    return null
  }
}

function remainingFractionOf(quotaInfo) {
  if (!quotaInfo || typeof quotaInfo !== 'object' || !quotaInfo.resetTime) return null
  if (typeof quotaInfo.remainingFraction === 'number' && Number.isFinite(quotaInfo.remainingFraction)) {
    return quotaInfo.remainingFraction
  }
  return 0
}

function poolKeyOf(model) {
  return model.modelProvider === GOOGLE_PROVIDER ? GOOGLE_POOL : PARTNER_POOL
}

function familyNameOf(model) {
  return PROVIDER_FAMILY_NAMES[model.modelProvider] || null
}

function poolLabel(poolKey, families) {
  if (poolKey === GOOGLE_POOL) return 'Gemini'
  const names = [...families].filter(Boolean).sort()
  return names.length > 0 ? names.join(' & ') : 'Other models'
}

function parseAntigravityModels(data, planName, { clampPercent, resetMs, now = Date.now() }) {
  const source = data && typeof data === 'object' ? data : {}
  const models = source.models && typeof source.models === 'object' ? source.models : {}
  const pools = new Map()
  for (const model of Object.values(models)) {
    if (!model || model.isInternal) continue
    const remaining = remainingFractionOf(model.quotaInfo)
    if (remaining === null) continue
    const key = poolKeyOf(model)
    const pool = pools.get(key) || { key, families: new Set(), remaining, resetTime: model.quotaInfo.resetTime }
    pool.families.add(familyNameOf(model))
    if (remaining < pool.remaining) {
      pool.remaining = remaining
      pool.resetTime = model.quotaInfo.resetTime
    }
    pools.set(key, pool)
  }
  const limits = [...pools.values()]
    .map((pool) => ({
      key: pool.key,
      kind: 'pool',
      label: poolLabel(pool.key, pool.families),
      percent: clampPercent((1 - pool.remaining) * 100),
      resetsAtMs: resetMs(pool.resetTime),
      active: pool.remaining < 1,
      severity: 'normal',
    }))
    .sort((a, b) => b.percent - a.percent || a.label.localeCompare(b.label))
  const peak = limits[0] || null
  return {
    id: 'antigravity',
    status: 'ok',
    plan: planName || null,
    barKind: 'quota',
    barPercent: peak ? peak.percent : 0,
    barResetsAtMs: peak ? peak.resetsAtMs : null,
    limits,
    updatedAtMs: now,
  }
}

function planNameFrom(loadData) {
  if (!loadData) return null
  const tier = loadData.paidTier || loadData.currentTier
  return tier ? tier.name || tier.id || null : null
}

function createAntigravityFetcher({
  fetchJson,
  clampPercent,
  resetMs,
  readCredential = readAntigravityCredential,
  homedir = os.homedir(),
  now = Date.now,
} = {}) {
  let token = null
  let lastCredentialReadAtMs = 0
  let projectId = null
  let planName = null
  let workspaceLoaded = false

  async function currentToken() {
    if (token && token.expiresAtMs > now() + TOKEN_MARGIN_MS) return token
    if (lastCredentialReadAtMs && now() - lastCredentialReadAtMs < CREDENTIAL_REREAD_INTERVAL_MS) return token
    lastCredentialReadAtMs = now()
    const credential = await readCredential()
    token = tokenFromCredential(credential)
    return token
  }

  function emptyResult(status) {
    return { id: 'antigravity', status, plan: planName, barPercent: 0, limits: [], updatedAtMs: now() }
  }

  async function postToCodeAssist(pathName, body, headers, fetchImpl) {
    let response = null
    for (const base of CODE_ASSIST_BASES) {
      response = await fetchJson(base + pathName, { method: 'POST', headers, body: JSON.stringify(body) }, fetchImpl)
      if (response.ok && response.data) return response
    }
    return response
  }

  async function loadWorkspace(headers, fetchImpl) {
    const loaded = await postToCodeAssist(
      LOAD_CODE_ASSIST_PATH,
      { metadata: { ideType: 'ANTIGRAVITY', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' } },
      headers,
      fetchImpl,
    )
    if (!loaded.ok || !loaded.data) return
    workspaceLoaded = true
    planName = planNameFrom(loaded.data)
    if (!projectId && loaded.data.cloudaicompanionProject) projectId = loaded.data.cloudaicompanionProject
  }

  return async function fetchAntigravityUsage({ fetchImpl = globalThis.fetch } = {}) {
    const activeToken = await currentToken()
    if (!activeToken) return emptyResult('no_credentials')
    if (activeToken.expiresAtMs <= now()) return emptyResult('expired')

    const headers = {
      Authorization: 'Bearer ' + activeToken.accessToken,
      'Content-Type': 'application/json',
      'User-Agent': ANTIGRAVITY_USER_AGENT,
    }
    projectId = readCachedProjectId(homedir) || projectId
    if (!workspaceLoaded) await loadWorkspace(headers, fetchImpl)

    const models = await postToCodeAssist(FETCH_MODELS_PATH, projectId ? { project: projectId } : {}, headers, fetchImpl)
    if (models.status === 401) {
      token = null
      return emptyResult('expired')
    }
    if (!models.ok || !models.data) return emptyResult(models.status === 403 ? 'auth_error' : 'error')
    return parseAntigravityModels(models.data, planName, { clampPercent, resetMs, now: now() })
  }
}

module.exports = {
  ANTIGRAVITY_CREDENTIAL_TARGET,
  createAntigravityFetcher,
  parseAntigravityModels,
  parseCredentialBlob,
  readAntigravityCredential,
  tokenFromCredential,
}
