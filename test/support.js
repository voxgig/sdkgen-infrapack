// What the suites share: a staged consumer compiled the way its own build
// compiles it, and the vendored API definitions in test/def with their models.
//
// A model is built the way a project's .sdk builds its own: apidef reads the
// definition from .sdk/def/ and writes the API model files under
// .sdk/model/, and the model generation reads is unified from those files,
// the base schemas and the targets the consumer has installed. Nothing here
// is hand-written, so a target is tested on what apidef actually produces.

const Fs = require('node:fs')
const Path = require('node:path')
const { execFileSync } = require('node:child_process')

const { Aontu } = require('aontu')
const { ApiDef } = require('@voxgig/apidef')

const { check } = require('../tools/vendor-defs.cjs')


const PKG = Path.resolve(__dirname, '..')
const DEF_DIR = Path.join(__dirname, 'def')


// Compiles the consumer's components with this package's own tsc and
// tsconfig, which is what a consumer's build does. The test kit's own
// transpiler predates the TypeScript this package builds with.
function compileConsumer(consumer) {
  const config = Path.join(consumer.root, 'tsconfig.json')
  const outdir = Path.join(consumer.sdk, 'dist', 'cmp')
  Fs.copyFileSync(Path.join(PKG, 'tsconfig.json'), config)
  execFileSync(process.execPath, [process.env.npm_execpath ?? NPM_CLI,
    'run', 'build', '--', '--project', config, '--outDir', outdir,
  ], { cwd: PKG, stdio: 'inherit' })
  Fs.cpSync(Path.join(consumer.sdk, 'src', 'cmp'), outdir, {
    recursive: true,
    filter: (path) => !path.endsWith('.ts') && Path.basename(path) !== 'fragment',
  })
}


// npm sets npm_execpath for a script it runs; a suite run directly with
// `node --test` finds npm's CLI beside the node that runs it.
const NPM_CLI = Path.join(Path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')


function defs() {
  const manifest = JSON.parse(Fs.readFileSync(Path.join(DEF_DIR, 'vendor.json'), 'utf8'))
  return manifest.defs.map((d) => ({ api: d.api, file: d.file, path: Path.join(DEF_DIR, d.file) }))
}


const quiet = {
  trace() { }, debug() { }, info() { }, warn() { }, error() { }, fatal() { },
  child() { return quiet },
}


// Runs apidef over one definition inside a staged consumer. Returns the
// build result, which also carries the parsed definition and the resolved
// spec apidef publishes for the generators.
async function buildApi(consumer, def) {
  const model = Path.join(consumer.sdk, 'model')
  const prefix = def.api + '-'

  Fs.mkdirSync(Path.join(consumer.sdk, 'def'), { recursive: true })
  Fs.copyFileSync(def.path, Path.join(consumer.sdk, 'def', def.file))
  Fs.mkdirSync(Path.join(model, 'guide'), { recursive: true })
  Fs.writeFileSync(Path.join(model, 'guide', prefix + 'guide.aontu'),
    '@"@voxgig/apidef/model/guide.aontu"\n@"./' + prefix + 'base-guide.aontu"\n')

  const build = await ApiDef.makeBuild({ folder: model, outprefix: prefix, pino: quiet })
  const result = await consumer.inSdk(() =>
    build({ name: def.api, def: def.file }, { spec: { base: model }, log: quiet }, {}))

  if (!result.ok) {
    throw new Error('apidef could not build ' + def.file + ': ' +
      (result.err?.message || 'failed after ' + (result.steps || []).join(', ')))
  }

  return result
}


// The compiled model for one built API: its own model files, unified with the
// base schemas and the consumer's installed targets and features. `name`
// defaults to the API's own; a consumer whose copied templates already carry
// another project's name, as `target add` writes them, passes that name.
function apiModel(consumer, api, extra = '', name = api) {
  const prefix = api + '-'
  const src = [
    '@"@voxgig/apidef/model/apidef.aontu"',
    '@"@voxgig/sdkgen/model/sdkgen.aontu"',
    '@"target/target-index.aontu"',
    '@"feature/feature-index.aontu"',
    '@"api/' + prefix + 'api-info.aontu"',
    '@"entity/' + prefix + 'entity-index.aontu"',
    '@"flow/' + prefix + 'flow-index.aontu"',
    "name: '" + name + "'",
    // A project's own config supplies this; an API model does not.
    "main: kit: config: headers: { 'content-type': 'application/json' }",
    extra,
  ].join('\n')

  const path = Path.join(consumer.sdk, 'model', prefix + 'test.aontu')
  Fs.writeFileSync(path, src)

  const errs = []
  const model = new Aontu().generate(src, { path, errs })
  if (0 < errs.length) {
    throw new Error(api + ': the model did not compile: ' +
      errs.map((e) => e.msg).join(' | '))
  }
  return model
}


module.exports = { PKG, DEF_DIR, defs, buildApi, apiModel, check, compileConsumer }
