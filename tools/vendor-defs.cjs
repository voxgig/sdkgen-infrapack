#!/usr/bin/env node

'use strict'

// Vendors the API definitions in test/def/vendor.json from
// voxgig/apidef-validate, recording the commit and each file's sha256.
//
//   node tools/vendor-defs.cjs                 refresh from the manifest's ref
//   node tools/vendor-defs.cjs --ref <ref>     refresh from a branch, tag or SHA
//   node tools/vendor-defs.cjs --source <url>  refresh from another repository
//   node tools/vendor-defs.cjs --check         verify test/def offline
//
// The fetch is shallow and blobless: the upstream folder's large debug files
// are listed but never downloaded.

const Fs = require('node:fs')
const Os = require('node:os')
const Path = require('node:path')
const Crypto = require('node:crypto')
const Child = require('node:child_process')

const REPO = Path.join(__dirname, '..')
const DEF_DIR = Path.join(REPO, 'test', 'def')
const MANIFEST = 'vendor.json'
const UPSTREAM_DIR = 'def'


function sha256(buf) {
  return Crypto.createHash('sha256').update(buf).digest('hex')
}


// Version strings in the corpus are dotted numbers, sometimes with a leading
// `v` (`v1`) or a calendar form (`2026.08`). Numeric parts compare as
// numbers, anything else as text, and a longer version wins a tie.
function compareVersions(a, b) {
  const parts = (v) => String(v).replace(/^v/i, '').split('.')
  const pa = parts(a)
  const pb = parts(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i]
    const y = pb[i]
    if (undefined === x) return -1
    if (undefined === y) return 1
    const nx = /^\d+$/.test(x) ? Number(x) : NaN
    const ny = /^\d+$/.test(y) ? Number(y) : NaN
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) {
      if (nx !== ny) return nx < ny ? -1 : 1
    }
    else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}


const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')


// The definition file for `api` with the highest API version, then the
// highest OpenAPI or Swagger version. A name such as `solar-1.0.0-openapi-
// 3.0.0.yaml` is `<api>-<version>-<format>-<format version>.<ext>`; the
// version has to start with a digit so that `foo` never claims `foo-bar-...`.
function pickLatest(names, api) {
  const re = new RegExp('^' + escape(api) +
    '-(v?\\d[\\w.]*?)-(openapi|swagger)-(\\d+(?:\\.\\d+)*)\\.(ya?ml|json)$')

  const found = names
    .map((name) => ({ name, m: re.exec(name) }))
    .filter((c) => null != c.m)
    .map((c) => ({ name: c.name, version: c.m[1], format: c.m[3] }))
    .sort((a, b) =>
      compareVersions(a.version, b.version) ||
      compareVersions(a.format, b.format) ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

  return 0 === found.length ? null : found[found.length - 1]
}


function readManifest(dir = DEF_DIR) {
  const file = Path.join(dir, MANIFEST)
  if (!Fs.existsSync(file)) {
    throw new Error('no manifest at ' + file)
  }
  const manifest = JSON.parse(Fs.readFileSync(file, 'utf8'))
  if (!Array.isArray(manifest.apis) || 0 === manifest.apis.length) {
    throw new Error(file + ': `apis` must list the APIs to vendor')
  }
  return manifest
}


// Every vendored file must exist and hash to what the manifest recorded.
function check(dir = DEF_DIR) {
  const manifest = readManifest(dir)
  const findings = []
  const defs = Array.isArray(manifest.defs) ? manifest.defs : []

  for (const api of manifest.apis) {
    if (!defs.some((d) => d.api === api)) {
      findings.push(api + ': listed in `apis` but never vendored; run the vendor script')
    }
  }

  for (const def of defs) {
    const file = Path.join(dir, def.file)
    if (!Fs.existsSync(file)) {
      findings.push(def.file + ': missing from ' + Path.relative(REPO, dir))
      continue
    }
    const got = sha256(Fs.readFileSync(file))
    if (got !== def.sha256) {
      findings.push(def.file + ': changed since it was vendored (sha256 ' + got +
        ', recorded ' + def.sha256 + '); edit the upstream definition, then vendor again')
    }
  }

  return findings
}


function git(args, opts = {}) {
  return Child.execFileSync('git', args, {
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  })
}


function fetchDefs({ source, ref, apis }) {
  const work = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'vendor-defs-'))
  try {
    git(['init', '-q', work])
    git(['-C', work, 'remote', 'add', 'origin', source])
    try {
      git(['-C', work, 'fetch', '-q', '--depth', '1', '--filter=blob:none', 'origin', ref])
    }
    catch (err) {
      throw new Error('could not fetch ' + ref + ' from ' + source + ':\n' +
        String(err.stderr || err.message).trim())
    }

    const commit = git(['-C', work, 'rev-parse', 'FETCH_HEAD'], { encoding: 'utf8' }).trim()
    const committed = git(['-C', work, 'log', '-1', '--format=%cI', 'FETCH_HEAD'],
      { encoding: 'utf8' }).trim()
    const names = git(['-C', work, 'ls-tree', '--name-only', 'FETCH_HEAD', UPSTREAM_DIR + '/'],
      { encoding: 'utf8' }).split('\n').filter((n) => '' !== n)
      .map((n) => n.slice(UPSTREAM_DIR.length + 1))

    const defs = apis.map((api) => {
      const pick = pickLatest(names, api)
      if (null == pick) {
        throw new Error('no OpenAPI or Swagger definition for `' + api + '` in ' +
          UPSTREAM_DIR + '/ at ' + commit)
      }
      const content = git(['-C', work, 'show', 'FETCH_HEAD:' + UPSTREAM_DIR + '/' + pick.name])
      return { api, file: pick.name, version: pick.version, content }
    })

    return { commit, committed, defs }
  }
  finally {
    Fs.rmSync(work, { recursive: true, force: true })
  }
}


function vendor({ dir = DEF_DIR, ref, source, log = console.log } = {}) {
  const manifest = readManifest(dir)
  const from = source || manifest.source
  const at = ref || manifest.ref || 'main'

  const got = fetchDefs({ source: from, ref: at, apis: manifest.apis })

  const before = new Map((manifest.defs || []).map((d) => [d.api, d]))
  const keep = new Set(got.defs.map((d) => d.file))

  for (const old of manifest.defs || []) {
    if (!keep.has(old.file)) {
      Fs.rmSync(Path.join(dir, old.file), { force: true })
      log('removed  ' + old.file)
    }
  }

  for (const def of got.defs) {
    const hash = sha256(def.content)
    const prior = before.get(def.api)
    Fs.writeFileSync(Path.join(dir, def.file), def.content)
    log((null == prior ? 'added    ' : prior.file !== def.file ? 'replaced ' :
      prior.sha256 !== hash ? 'updated  ' : 'same     ') + def.file +
      (null != prior && prior.file !== def.file ? ' (was ' + prior.file + ')' : ''))
  }

  const next = {
    _comment: manifest._comment,
    source: from,
    ref: at,
    commit: got.commit,
    committed: got.committed,
    apis: manifest.apis,
    defs: got.defs.map((d) => ({
      api: d.api, file: d.file, version: d.version, sha256: sha256(d.content),
    })),
  }
  Fs.writeFileSync(Path.join(dir, MANIFEST), JSON.stringify(next, null, 2) + '\n')
  log('test/def is ' + from + ' at ' + got.commit + ' (' + got.committed + ')')

  return next
}


function main(argv) {
  const opt = (name) => {
    const i = argv.indexOf(name)
    return i < 0 ? undefined : argv[i + 1]
  }

  if (argv.includes('-h') || argv.includes('--help')) {
    console.log('usage: node tools/vendor-defs.cjs [--ref <ref>] [--source <url>] [--check]')
    return 0
  }

  if (argv.includes('--check')) {
    const findings = check()
    for (const f of findings) console.error('vendor-defs: ' + f)
    if (0 === findings.length) console.log('vendor-defs: test/def matches its manifest')
    return 0 === findings.length ? 0 : 1
  }

  vendor({ ref: opt('--ref'), source: opt('--source') })
  return 0
}


if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2))
  }
  catch (err) {
    console.error('vendor-defs: ' + err.message)
    process.exitCode = 1
  }
}


module.exports = { compareVersions, pickLatest, readManifest, check, vendor, sha256, MANIFEST }
