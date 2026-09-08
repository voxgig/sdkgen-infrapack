// The Seneca provider target's own suite.
//
// These tests used to live in sdkgen's `recordkey.test.ts`,
// `seedrecord.test.ts`, `generate.test.ts` and `external.test.ts`. They moved
// here with the target, which is the point of migrating: the target's
// coverage travels with the target, and sdkgen's closed guard suites shrink
// by exactly the target that left them.
//
// Two kinds of test live here, and they load the components differently on
// purpose:
//
//   - GENERATION tests run on `@voxgig/sdkgen/testkit`, so the pipeline under
//     test is the real one — `package add` installs this package into a
//     staged consumer, the consumer's components are compiled the way its own
//     build compiles them, and generation runs from `.sdk`.
//   - UNIT tests on an exported helper transpile the shipped component and
//     call the function directly. That is how they were written in sdkgen and
//     it is still the right shape: the cases below are hand-built model
//     fragments from real APIs, and driving them through a whole generation
//     would test the fragment's plumbing rather than the function.

const { test, describe, before, after } = require('node:test')
const { ok, strictEqual, deepStrictEqual } = require('node:assert')

const Fs = require('node:fs')
const Path = require('node:path')

const { Aontu } = require('aontu')
const { transform } = require('sucrase')

const { stageConsumer, generateInto } = require('@voxgig/sdkgen/testkit')


const PKG = Path.resolve(__dirname, '..')
const CMP = Path.join(PKG, '.sdk', 'src', 'cmp', 'seneca-provider')


// Transpile a shipped component and hand back its exports.
//
// `@voxgig/sdkgen` is shimmed to the resolved package rather than left to
// Node: the component requires it by bare name, which is right for a consumer
// (it has the dependency) and resolvable here only because this package
// devDepends on it. Shimming keeps the two readings the same one.
function loadComponent(file, extraShims = {}) {
  const path = Path.join(CMP, file)
  const js = transform(Fs.readFileSync(path, 'utf8'), {
    transforms: ['typescript', 'imports'],
    filePath: path,
  }).code

  const shims = { '@voxgig/sdkgen': require('@voxgig/sdkgen'), ...extraShims }
  const req = (p) => (p in shims ? shims[p] : require(p))

  const mod = { exports: {} }
  const fn = new Function(
    'exports', 'require', 'module', '__dirname', '__filename', js)
  fn(mod.exports, req, mod, Path.dirname(path), path)
  return mod.exports
}


// The API this target is generated from. Small, but carrying the shapes that
// have historically broken provider generation: an entity with a full CRUD
// set and an id binding, a required and an optional field, and a load op with
// a real path param.
const API = `
main: kit: info: { title: 'Demo', version: '1.0.0', auth: false }
main: kit: config: headers: { 'content-type': 'application/json' }

main: kit: entity: planet: {
  alias: field: {}
  name: "planet"
  id: { field: "id", name: "id" }
  field: {
    id:     { name: "id",     kind: "field", type: "\`$STRING\`", required: true }
    title:  { name: "title",  kind: "field", type: "\`$STRING\`", required: true }
    radius: { name: "radius", kind: "field", type: "\`$NUMBER\`" }
  }
  fields: [
    { name: "id",     req: true,  type: "\`$STRING\`" }
    { name: "radius", req: false, type: "\`$NUMBER\`" }
    { name: "title",  req: true,  type: "\`$STRING\`" }
  ]
  op: {
    list: { name: "list", points: [ {
      args: {}, method: "GET", orig: "/planet", segments: [{ lit: "planet" }]
      transform: { req: "\`reqdata\`", res: "\`body\`" } } ] }
    load: { name: "load", points: [ {
      args: { params: [
        { kind: "param", name: "id", orig: "id", reqd: true, type: "\`$STRING\`", example: "p01" }
      ] }
      method: "GET", orig: "/planet/{id}", segments: [{ lit: "planet" }, { var: "id" }]
      transform: { req: "\`reqdata\`", res: "\`body\`" } } ] }
    create: { name: "create", points: [ {
      args: { body: [ { kind: "body", name: "title", reqd: true, type: "\`$STRING\`" } ] }
      method: "POST", orig: "/planet", segments: [{ lit: "planet" }]
      transform: { req: "\`reqdata\`", res: "\`body\`" } } ] }
    update: { name: "update", points: [ {
      args: {
        params: [ { kind: "param", name: "id", orig: "id", reqd: true, type: "\`$STRING\`", example: "p01" } ]
        body: [ { kind: "body", name: "title", type: "\`$STRING\`" } ]
      }
      method: "PATCH", orig: "/planet/{id}", segments: [{ lit: "planet" }, { var: "id" }]
      transform: { req: "\`reqdata\`", res: "\`body\`" } } ] }
    remove: { name: "remove", points: [ {
      args: { params: [
        { kind: "param", name: "id", orig: "id", reqd: true, type: "\`$STRING\`", example: "p01" }
      ] }
      method: "DELETE", orig: "/planet/{id}", segments: [{ lit: "planet" }, { var: "id" }]
      transform: { req: "\`reqdata\`", res: "\`body\`" } } ] }
  }
}

main: kit: flow: BasicPlanetFlow: {
  entity: "planet", kind: "basic", name: "BasicPlanetFlow"
  step: [
    { op: "create", input: { ref: "planet_ref01" } }
    { op: "list" }
    { op: "update", input: {
        ref: "planet_ref01", srcdatavar: "planet_ref01_data",
        suffix: "_up0", textfield: "title" } }
    { op: "load", input: {
        ref: "planet_ref01", srcdatavar: "planet_ref01_data", suffix: "_dt0" } }
    { op: "remove", input: { ref: "planet_ref01", suffix: "_rm0" } }
  ]
}
`


function consumerModel(sdk, extra) {
  const src = [
    '@"@voxgig/apidef/model/apidef.aon"',
    '@"@voxgig/sdkgen/model/sdkgen.aon"',
    '@"target/target-index.aon"',
    '@"feature/feature-index.aon"',
    "name: 'demo'",
    API,
    extra || '',
  ].join('\n')

  const path = Path.join(sdk, 'model', 'generate-test.aon')
  Fs.writeFileSync(path, src)

  const errs = []
  const model = new Aontu().generate(src, { path, errs })
  strictEqual(errs.length, 0,
    'model did not compile: ' + errs.map((e) => e.msg).join(' | '))

  return model
}


describe('seneca-provider target, from its package', () => {

  let consumer

  // IT NEEDS `ts`. This is a consumer target: Main throws without the target
  // it wraps, so the staged consumer installs the bundled `ts` alongside this
  // package. That is the dependency direction the migration made explicit —
  // package -> bundled, which is the safe one — and there is no manifest
  // field that states it, so this `before` block is where it is visible.
  before(async () => {
    consumer = stageConsumer({ recordLog: true })
    await consumer.add('target', consumer.bundledRef('target', 'ts'))
    await consumer.addPackage(PKG)
    consumer.compile()
  })

  after(() => {
    if (null != consumer) consumer.cleanup()
  })


  // DOES THE INSTALLED TEST KIT SUPPORT OUT-OF-TREE GENERATION?
  //
  // `generateInto`'s `outside` option — declaring the destinations an
  // `output: path` target writes to — is newer than the published sdkgen this
  // package depends on. Without it the kit treats any path outside the
  // consumer root as a bug and throws, which is the right default and exactly
  // what an out-of-tree target trips.
  //
  // Probed rather than version-compared: a result carrying an `outside` map is
  // a kit that has the feature, whatever it calls itself. The two tests below
  // SKIP when it is absent and start running the moment sdkgen ships it — a
  // visible skip, never a silent pass, which is this project's own rule for a
  // capability the environment lacks.
  let outsideSupported = false

  before(async () => {
    const probe = await generateInto(consumer, { model: consumerModel(consumer.sdk) })
    outsideSupported = undefined !== probe.outside
  })


  test('package add installs the target', () => {
    const files = consumer.files()

    ok(files.includes('model/target/seneca-provider.aon'), 'no target model')
    ok(files.some((f) => f.startsWith('src/cmp/seneca-provider/')),
      'no components')
    ok(files.some((f) => f.startsWith('tm/seneca-provider/')), 'no templates')
  })


  // The placeholder scan sdkgen's `generate.test.ts` runs over the bundled
  // consumer targets. It is that suite's only content guard, and this target
  // leaving means it has to be run here instead — a Copy or Fragment added
  // without `...ctx$.stdrep` would otherwise ship a package naming itself
  // "ProjectName" at runtime with every suite green.
  test('it generates a provider, with no placeholder left in it', async () => {
    const { files, leaks } = await generateInto(consumer,
      { model: consumerModel(consumer.sdk) })

    const mine = Object.keys(files).filter((p) => p.startsWith('seneca-provider/'))
    ok(0 < mine.length,
      'nothing generated:\n  ' + Object.keys(files).join('\n  '))

    deepStrictEqual(leaks.filter((l) => l.startsWith('seneca-provider/')), [],
      'a placeholder survived into the generated provider')
  })


  // THE PROVIDER'S .gitignore IS GENERATED, NOT TEMPLATED — and it has to be.
  //
  // It used to come from `tm/seneca-provider/.gitignore`, which meant it
  // reached only people working from a checkout: npm never publishes a file
  // by that name, whatever `files` says, so everyone who installed from the
  // registry generated a provider repo with no ignore file at all.
  //
  // `.jostraca/` is the line that matters most: jostraca drops its meta log
  // and a full duplicate of the last generated output into the provider repo
  // on every run, so without it the first regeneration leaves hundreds of
  // untracked files behind.
  test('the gitignore is generated, not copied', async () => {
    const { files } = await generateInto(consumer,
      { model: consumerModel(consumer.sdk) })

    const ignore = files['seneca-provider/.gitignore']
    ok(null != ignore, 'no .gitignore generated:\n  ' +
      Object.keys(files).filter((p) => p.startsWith('seneca-provider/'))
        .join('\n  '))

    const lines = String(ignore).split('\n').map((l) => l.trim())
      .filter((l) => '' !== l && !l.startsWith('#'))

    for (const needed of ['node_modules/', '.jostraca/', '*.tsbuildinfo']) {
      ok(lines.includes(needed),
        'the provider .gitignore stopped ignoring ' + needed)
    }
  })


  // OUT OF TREE, which is this target's defining mode.
  //
  // The provider is not a folder of the SDK repo: it is a separate npm
  // package with its own repo, reached through `output: path`. sdkgen's
  // `external.test.ts` owns the MECHANISM — placement, partition, refusal —
  // for every target; what belongs here is that THIS target is generated
  // correctly through it, because that is the only mode a real project uses
  // it in.
  const OUT = '../acme-provider'

  test('it generates into its own repo, not into the SDK repo', async (t) => {
    if (!outsideSupported) {
      return t.skip('the installed @voxgig/sdkgen test kit has no `outside` '
        + 'support, so out-of-tree generation cannot be expressed here')
    }

    const { files, outside, leaks } = await generateInto(consumer, {
      model: consumerModel(consumer.sdk,
        "main: kit: target: 'seneca-provider': output: path: '" + OUT + "'"),
      outside: [OUT],
    })

    const provider = outside[OUT]

    // The destination IS the package: its manifest sits at the root, not
    // under a `seneca-provider/` subfolder.
    ok(null != provider['package.json'],
      'no package.json at the output root — generated:\n  ' +
      Object.keys(provider).join('\n  '))

    // ...and nothing of it stayed behind in the SDK repo.
    const strays = Object.keys(files).filter((p) => p.startsWith('seneca-provider/'))
    deepStrictEqual(strays, [],
      'the provider ALSO generated into the SDK repo')

    // The `ts` SDK still generates in-tree — the external partition must not
    // take the rest of the project with it.
    ok(Object.keys(files).some((p) => p.startsWith('ts/')),
      'the SDK stopped generating when the provider went out of tree')

    // SCOPED TO THE PROVIDER. The staged consumer also generates `ts`, whose
    // `src/feature/test/AGENTS.md` carries a known-benign `ProjectName`
    // mention that sdkgen pins in its own suite; asserting the whole list
    // empty here would be this package making a claim about another target.
    deepStrictEqual(leaks.filter((l) => l.startsWith(OUT + '/')), [],
      'a placeholder survived into the generated provider')
  })


  // THE CONTENT HALF OF `output: sdkrel`.
  //
  // sdkgen's `external.test.ts` owns the mechanism — that the value is
  // derived, that a derivation naming machine-local directories warns, and
  // that a declared value replaces both. What it can no longer own is that
  // the value REACHES generated content, because the only component that
  // reads `ctx$.sdkrelpath` is this target's Main. So that assertion lives
  // here, next to the component that consumes it.
  //
  // Why it is worth asserting at all: the walk back from the provider repo to
  // the SDK repo is written into files that are COMMITTED in the provider
  // repo, so a machine-derived path becomes a tracked diff on the next
  // developer's machine.
  //
  // It needs `output: path` as well: `sdkrel` describes the walk back from a
  // DESTINATION, so in-tree there is nothing for it to describe and Main
  // falls back to '..'.
  test('a declared `output: sdkrel` reaches the generated files', async (t) => {
    if (!outsideSupported) {
      return t.skip('the installed @voxgig/sdkgen test kit has no `outside` '
        + 'support, so out-of-tree generation cannot be expressed here')
    }

    const { outside } = await generateInto(consumer, {
      model: consumerModel(consumer.sdk,
        "main: kit: target: 'seneca-provider': output: path: '" + OUT + "'\n" +
        "main: kit: target: 'seneca-provider': output: sdkrel: '../../acme-sdk'"),
      outside: [OUT],
    })

    const named = Object.entries(outside[OUT])
      .filter(([, content]) => String(content).includes('../../acme-sdk'))
      .map(([p]) => p)

    ok(0 < named.length,
      'the declared path back to the SDK project reached no generated file')
  })


  // `recordKey` — which param names the record itself.
  describe('recordKey', () => {

    const { recordKey } = loadComponent('Main_seneca-provider.ts', {
      // Local siblings unrelated to recordKey — stubbed out entirely.
      './Extras_seneca-provider': {
        Tests: () => { }, Scripts: () => { }, Workflow: () => { },
        Readme: () => { }, Docs: () => { },
      },
      './Gitignore_seneca-provider': { Gitignore: () => { } },
    })

    // Airtable's real shape. opParams() alphabetizes for output stability
    // (base_id, record_id, table_id) — table_id sorts last, so the old
    // "last required param" heuristic picked it as the record's own key
    // instead of record_id, and every downstream mapping was backwards.
    test('a 3-param route picks the terminal path param, not the alphabetically last one', () => {
      const ent = {
        name: 'record',
        fields: {},
        op: {
          load: {
            points: [{
              segments: [{ var: 'base_id' }, { var: 'table_id' }, { var: 'record_id' }],
              args: {
                params: {
                  base_id: { name: 'base_id', reqd: true },
                  table_id: { name: 'table_id', reqd: true },
                  record_id: { name: 'record_id', reqd: true },
                },
              },
            }],
          },
        },
      }

      strictEqual(recordKey(ent), 'record_id')
    })

    // The common case: a single path param, already named plainly — matched
    // by entityIdField before the points-based fallback ever runs.
    test('a single-param route with a field named id uses entityIdField', () => {
      const ent = {
        name: 'board',
        fields: { id: { name: 'id' } },
        op: {
          load: {
            points: [{
              segments: [{ lit: 'boards' }, { var: 'id' }],
              args: { params: { id: { name: 'id', reqd: true } } },
            }],
          },
        },
      }

      strictEqual(recordKey(ent), 'id')
    })
  })


  // `seedRecord` — what the generated mock seeds for a parent key.
  describe('seedRecord', () => {

    const { seedRecord } = loadComponent('Extras_seneca-provider.ts')

    // GitHub's real shape: `owner` is both a required PARENT PATH PARAM (the
    // {owner} URL segment) and an unrelated response FIELD (the repo's owner
    // object) — no entity in the model is literally named `owner`, so
    // parentEntity resolves to ''. The old `${f.parentEntity}0` formula
    // seeded '0'; the query built elsewhere (parentPairs/parentSeed) filtered
    // for 'owner0' — seed and query disagreed.
    test('a parent key colliding with an unrelated same-named field seeds via parentSeed, not a bare index', () => {
      const e = {
        name: 'repo',
        idf: 'id',
        parents: ['owner'],
        fields: [
          { name: 'id', kind: 'string', parentEntity: '' },
          { name: 'owner', kind: 'object', parentEntity: '' },
        ],
      }

      strictEqual(seedRecord(e, 0).owner, 'owner0')
    })

    // Zoom's real shape: `user_id` guards `list`/`create` but has NO matching
    // response field at all — Main forces it into `e.fields` as a synthetic
    // required field (kind: 'string', parentEntity: '') so the mock can
    // filter by it. Same formula, same bug: seeded '0' instead of 'user0', so
    // a list$({user_id: 'user0'}) query matched nothing.
    test('a parent key with no real matching field (Main\'s forced-in field) seeds via parentSeed too', () => {
      const e = {
        name: 'meeting',
        idf: 'id',
        parents: ['user_id'],
        fields: [
          { name: 'id', kind: 'string', parentEntity: '' },
          { name: 'user_id', kind: 'string', parentEntity: '' },
        ],
      }

      strictEqual(seedRecord(e, 0).user_id, 'user0')
    })

    // The working case, unchanged: a parent key that DOES resolve to a real
    // entity in the model seeds that entity's id, exactly as before.
    test('a parent key resolving to a real entity still seeds that entity\'s id', () => {
      const e = {
        name: 'table',
        idf: 'id',
        parents: ['base_id'],
        fields: [
          { name: 'id', kind: 'string', parentEntity: '' },
          { name: 'base_id', kind: 'string', parentEntity: 'base' },
        ],
      }

      strictEqual(seedRecord(e, 0).base_id, 'base0')
    })
  })
})
