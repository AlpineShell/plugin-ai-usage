const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3')

const ROOT = path.join(__dirname, '..')
const PACKAGE_EXT = '.alpineplugin'
const CATALOG_KEY = 'plugins/index.json'
const CATALOG_SCHEMA_VERSION = 1
const SAFE_ID = /^[a-z0-9][a-z0-9._-]*$/
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const PACK_INCLUDE = ['plugin.json', 'index.js', 'backend.js', 'README.md', 'assets']

const bundleKey = (id, version) => `plugins/${id}/${version}/${id}-${version}${PACKAGE_EXT}`
const latestKey = (id) => `plugins/${id}/latest.json`

function fail(message) {
  console.error(message)
  process.exit(1)
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator === -1) continue
    const key = line.slice(0, separator).trim()
    let value = line.slice(separator + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (!(key in process.env)) process.env[key] = value
  }
}

function readStorageEnv() {
  const e = process.env
  const cfg = {
    endpoint: e.STORAGE_ENDPOINT,
    region: e.STORAGE_REGION || 'us-east-1',
    accessKeyId: e.STORAGE_ACCESS_KEY_ID,
    secretAccessKey: e.STORAGE_SECRET_ACCESS_KEY,
    bucket: e.STORAGE_BUCKET,
    forcePathStyle: e.STORAGE_FORCE_PATH_STYLE !== 'false',
  }
  const missing = ['endpoint', 'accessKeyId', 'secretAccessKey', 'bucket'].filter((k) => !cfg[k])
  if (missing.length > 0) fail(`Missing storage config: ${missing.join(', ')}`)
  return cfg
}

function createStorageClient(cfg) {
  return new S3Client({
    region: cfg.region,
    endpoint: cfg.endpoint,
    forcePathStyle: cfg.forcePathStyle,
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  })
}

function readAndValidateManifest() {
  const manifestPath = path.join(ROOT, 'plugin.json')
  if (!fs.existsSync(manifestPath)) fail('No plugin.json found at the repo root')
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^﻿/, ''))
  } catch (error) {
    return fail(`Invalid plugin.json: ${error.message}`)
  }
  const id = manifest.id
  if (!id || !SAFE_ID.test(id)) fail(`Invalid plugin id "${id}" (expected lowercase reverse-DNS)`)
  const version = manifest.version
  if (!version || !SEMVER.test(version)) fail(`Invalid or missing version "${version}" (expected strict semver)`)
  return { ...manifest, id, version }
}

function authorName(author) {
  if (!author) return undefined
  if (typeof author === 'string') return author
  return author.name || undefined
}

function walkFiles() {
  const realRoot = fs.realpathSync(ROOT)
  const files = []
  const walk = (dir) => {
    const entries = fs.readdirSync(dir).sort()
    for (const name of entries) {
      const abs = path.join(dir, name)
      const stat = fs.lstatSync(abs)
      if (stat.isSymbolicLink()) fail(`Refusing to pack symlink: ${abs}`)
      const rel = path.relative(realRoot, fs.realpathSync(abs))
      if (rel.startsWith('..') || path.isAbsolute(rel)) fail(`Entry escapes plugin dir: ${abs}`)
      if (stat.isDirectory()) walk(abs)
      else if (stat.isFile()) files.push(path.relative(ROOT, abs))
    }
  }
  for (const name of PACK_INCLUDE) {
    const abs = path.join(ROOT, name)
    if (!fs.existsSync(abs)) continue
    const stat = fs.lstatSync(abs)
    if (stat.isSymbolicLink()) fail(`Refusing to pack symlink: ${abs}`)
    if (stat.isDirectory()) walk(abs)
    else if (stat.isFile()) files.push(name)
  }
  return files.sort()
}

function packPlugin(id) {
  const files = walkFiles()
  if (!files.includes('plugin.json')) fail('plugin.json must be at the plugin root')
  const outPath = path.join(ROOT, `${id}${PACKAGE_EXT}`)
  if (fs.existsSync(outPath)) fs.rmSync(outPath)
  const listFile = path.join(os.tmpdir(), `alpineplugin-${process.pid}-${Date.now()}.txt`)
  fs.writeFileSync(listFile, files.map((f) => f.split(path.sep).join('/')).join('\n'))
  const result = spawnSync(
    'tar',
    ['--format', 'zip', '-c', '-f', outPath, '-C', ROOT, '-T', listFile],
    { stdio: 'inherit' }
  )
  fs.rmSync(listFile, { force: true })
  if (result.status !== 0) fail(`tar failed to pack plugin (exit ${result.status})`)
  return outPath
}

function sha256File(file) {
  const hash = crypto.createHash('sha256')
  hash.update(fs.readFileSync(file))
  const digest = hash.digest()
  return { hex: digest.toString('hex'), digest }
}

function signDigest(digestBuffer) {
  const raw = process.env.ALPINE_PLUGIN_SIGNING_KEY
  if (!raw) {
    console.warn('ALPINE_PLUGIN_SIGNING_KEY not set — skipping Ed25519 signing (unsigned publish)')
    return null
  }
  const pem = Buffer.from(raw, 'base64').toString('utf8')
  const key = crypto.createPrivateKey(pem)
  return crypto.sign(null, digestBuffer, key).toString('base64')
}

async function putObject(client, bucket, key, body, contentType, cacheControl) {
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: cacheControl,
    })
  )
  console.log(`Uploaded ${key}`)
}

async function getJson(client, bucket, key) {
  try {
    const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
    const text = await response.Body.transformToString()
    return JSON.parse(text)
  } catch (error) {
    if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) return null
    throw error
  }
}

const IMMUTABLE = 'public, max-age=31536000, immutable'
const NO_CACHE = 'no-cache'

async function updateCatalog(client, bucket, entry) {
  const existing = (await getJson(client, bucket, CATALOG_KEY)) || {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    plugins: [],
  }
  const plugins = (existing.plugins || []).filter((p) => p.id !== entry.id)
  plugins.push(entry)
  plugins.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id))
  const catalog = {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    plugins,
  }
  await putObject(client, bucket, CATALOG_KEY, JSON.stringify(catalog, null, 2), 'application/json', NO_CACHE)
}

async function publish() {
  loadEnvFile(path.join(ROOT, '.env'))
  const manifest = readAndValidateManifest()
  const { id, version } = manifest
  const config = readStorageEnv()
  const client = createStorageClient(config)

  const bundlePath = packPlugin(id)
  try {
    const { hex, digest } = sha256File(bundlePath)
    const size = fs.statSync(bundlePath).size
    const signature = signDigest(digest)
    const url = bundleKey(id, version)
    const publishedAt = new Date().toISOString()

    await putObject(client, config.bucket, url, fs.readFileSync(bundlePath), 'application/zip', IMMUTABLE)

    const mkt = manifest.marketplace || {}

    let iconUrl
    const logoRel =
      mkt.logo ||
      (typeof manifest.icon === 'string' && !manifest.icon.startsWith('lucide:') ? manifest.icon : null) ||
      'icon.png'
    const logoPath = path.join(ROOT, logoRel)
    if (fs.existsSync(logoPath) && fs.statSync(logoPath).isFile()) {
      const ext = (path.extname(logoPath) || '.png').toLowerCase()
      const contentType =
        ext === '.svg' ? 'image/svg+xml' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png'
      iconUrl = `plugins/${id}/icon${ext}`
      await putObject(client, config.bucket, iconUrl, fs.readFileSync(logoPath), contentType, IMMUTABLE)
    }

    let readmeUrl
    let readmeText = null
    if (typeof mkt.readme === 'string') {
      const readmePath = path.join(ROOT, mkt.readme)
      if (fs.existsSync(readmePath) && fs.statSync(readmePath).isFile()) {
        readmeText = fs.readFileSync(readmePath, 'utf8')
        readmeUrl = `plugins/${id}/README.md`
        await putObject(client, config.bucket, readmeUrl, Buffer.from(readmeText), 'text/markdown', NO_CACHE)
      }
    }

    const latest = {
      schemaVersion: CATALOG_SCHEMA_VERSION,
      id,
      name: mkt.displayName || manifest.name || id,
      version,
      description: manifest.description,
      shortDescription: mkt.shortDescription || manifest.description,
      author: manifest.author,
      homepage: manifest.homepage,
      repository: manifest.repository,
      license: manifest.license,
      icon: manifest.icon,
      iconUrl,
      logo: iconUrl,
      category: mkt.category,
      keywords: mkt.keywords || [],
      screenshots: mkt.screenshots || [],
      readme: readmeText,
      readmeUrl,
      sha256: hex,
      signature,
      size,
      url,
      apiVersion: manifest.apiVersion ?? 1,
      engines: manifest.engines,
      verified: manifest.verified === true,
      publishedAt,
    }
    await putObject(client, config.bucket, latestKey(id), JSON.stringify(latest, null, 2), 'application/json', NO_CACHE)

    const card = {
      id,
      name: mkt.displayName || manifest.name || id,
      version,
      description: manifest.description,
      shortDescription: mkt.shortDescription || manifest.description,
      author: authorName(manifest.author),
      homepage: manifest.homepage,
      repository: manifest.repository,
      license: manifest.license,
      apiVersion: manifest.apiVersion ?? 1,
      engines: manifest.engines,
      iconUrl,
      logo: iconUrl,
      category: mkt.category,
      keywords: mkt.keywords || [],
      readmeUrl,
      verified: manifest.verified === true,
      sha256: hex,
      size,
      url,
      signature,
      publishedAt,
    }
    await updateCatalog(client, config.bucket, card)

    console.log(`Published ${id}@${version} (${size} bytes${signature ? ', signed' : ', UNSIGNED'})`)
  } finally {
    fs.rmSync(bundlePath, { force: true })
  }
}

publish().catch((error) => fail(error.stack || error.message))
