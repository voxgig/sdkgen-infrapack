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
//   - UNIT tests on an exported helper load the built component and
//     call the function directly. That is how they were written in sdkgen and
//     it is still the right shape: the cases below are hand-built model
//     fragments from real APIs, and driving them through a whole generation
//     would test the fragment's plumbing rather than the function.

const { test, describe, before, after } = require('node:test')
const { ok, strictEqual, deepStrictEqual } = require('node:assert')

const Fs = require('node:fs')
const Path = require('node:path')
const Os = require('node:os')
const { execFileSync } = require('node:child_process')

const { Aontu } = require('aontu')
const { Script } = require('node:vm')

const { stageConsumer, generateInto } = require('@voxgig/sdkgen/testkit')


const PKG = Path.resolve(__dirname, '..')
const CMP = Path.join(PKG, '.build', 'cmp', 'seneca-provider')


// Load a built component and hand back its exports.
//
// `@voxgig/sdkgen` is shimmed to the resolved package rather than left to
// Node: the component requires it by bare name, which is right for a consumer
// (it has the dependency) and resolvable here only because this package
// devDepends on it. Shimming keeps the two readings the same one.
function loadComponent(file, extraShims = {}) {
  const path = Path.join(CMP, file.replace(/\.ts$/, '.js'))
  const js = Fs.readFileSync(path, 'utf8')

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


// A second entity whose name leads with a digit — what apidef produces for a
// resource like `/3ds-sessions`.
const DIGIT_ENTITY = `
main: kit: entity: '3ds_session': {
  alias: field: {}
  name: "3ds_session"
  id: { field: "id", name: "id" }
  field: {
    id: { name: "id", kind: "field", type: "\`$STRING\`", required: true }
  }
  fields: [ { name: "id", req: true, type: "\`$STRING\`" } ]
  op: {
    list: { name: "list", points: [ {
      args: {}, method: "GET", orig: "/3ds-session", segments: [{ lit: "3ds-session" }]
      transform: { req: "\`reqdata\`", res: "\`body\`" } } ] }
    load: { name: "load", points: [ {
      args: { params: [
        { kind: "param", name: "id", orig: "id", reqd: true, type: "\`$STRING\`", example: "s01" }
      ] }
      method: "GET", orig: "/3ds-session/{id}", segments: [{ lit: "3ds-session" }, { var: "id" }]
      transform: { req: "\`reqdata\`", res: "\`body\`" } } ] }
  }
}

main: kit: flow: Basic3dsSessionFlow: {
  entity: "3ds_session", kind: "basic", name: "Basic3dsSessionFlow"
  step: [
    { op: "list" }
    { op: "load", input: {
        ref: "3ds_session_ref01", srcdatavar: "3ds_session_ref01_data", suffix: "_dt0" } }
  ]
}
`


// AN ENTITY WITH CUSTOM ACTIONS, mirroring github-sdk's real `pull`.
//
// `update` carries the canonical PATCH plus a `merge` ACTION point — apidef's
// shape for GitHub's `PUT /repos/{owner}/{repo}/pulls/{n}/merge`, the case
// this whole mechanism exists for. `create` carries a second action, so
// `save$` has to route by the op that owns the action rather than assuming
// `update`: `upload_image` on an entity carrying an id is still a create.
const ACTION_ENTITY = `
main: kit: entity: pull: {
  alias: field: {}
  name: "pull"
  id: { field: "id", name: "id" }
  field: {
    id:    { name: "id",    kind: "field", type: "\`$STRING\`", required: true }
    title: { name: "title", kind: "field", type: "\`$STRING\`", required: true }
  }
  fields: [
    { name: "id",    req: true, type: "\`$STRING\`" }
    { name: "title", req: true, type: "\`$STRING\`" }
  ]
  op: {
    list: { name: "list", points: [ {
      args: {}, method: "GET", orig: "/pull", segments: [{ lit: "pull" }]
      transform: { req: "\`reqdata\`", res: "\`body\`" } } ] }
    load: { name: "load", points: [ {
      args: { params: [
        { kind: "param", name: "id", orig: "id", reqd: true, type: "\`$STRING\`", example: "p01" }
      ] }
      method: "GET", orig: "/pull/{id}", segments: [{ lit: "pull" }, { var: "id" }]
      transform: { req: "\`reqdata\`", res: "\`body\`" } } ] }
    create: {
      name: "create"
      points: [
        {
          args: { body: [ { kind: "body", name: "title", reqd: true, type: "\`$STRING\`" } ] }
          method: "POST", orig: "/pull", segments: [{ lit: "pull" }]
          transform: { req: "\`reqdata\`", res: "\`body\`" }
        }
        {
          args: {
            params: [ { kind: "param", name: "id", orig: "id", reqd: true, type: "\`$STRING\`", example: "p01" } ]
            body: [ { kind: "body", name: "image", type: "\`$STRING\`" } ]
          }
          method: "POST", orig: "/pull/{id}/image"
          segments: [{ lit: "pull" }, { var: "id" }, { lit: "image" }]
          select: { '$action': "upload_image", exist: [ "id" ] }
          transform: { req: "\`reqdata\`", res: "\`body\`" }
        }
      ]
    }
    update: {
      name: "update"
      points: [
        {
          args: {
            params: [ { kind: "param", name: "id", orig: "id", reqd: true, type: "\`$STRING\`", example: "p01" } ]
            body: [ { kind: "body", name: "title", type: "\`$STRING\`" } ]
          }
          method: "PATCH", orig: "/pull/{id}", segments: [{ lit: "pull" }, { var: "id" }]
          transform: { req: "\`reqdata\`", res: "\`body\`" }
        }
        {
          args: {
            params: [ { kind: "param", name: "id", orig: "id", reqd: true, type: "\`$STRING\`", example: "p01" } ]
            body: [ { kind: "body", name: "commit_title", type: "\`$STRING\`" } ]
          }
          method: "PUT", orig: "/pull/{id}/merge"
          segments: [{ lit: "pull" }, { var: "id" }, { lit: "merge" }]
          select: { '$action': "merge", exist: [ "id" ] }
          transform: { req: "\`reqdata\`", res: "\`body\`" }
        }
      ]
    }
    remove: { name: "remove", points: [ {
      args: { params: [
        { kind: "param", name: "id", orig: "id", reqd: true, type: "\`$STRING\`", example: "p01" }
      ] }
      method: "DELETE", orig: "/pull/{id}", segments: [{ lit: "pull" }, { var: "id" }]
      transform: { req: "\`reqdata\`", res: "\`body\`" } } ] }
  }
}

main: kit: flow: BasicPullFlow: {
  entity: "pull", kind: "basic", name: "BasicPullFlow"
  step: [
    { op: "create", input: { ref: "pull_ref01" } }
    { op: "list" }
    { op: "update", input: {
        ref: "pull_ref01", srcdatavar: "pull_ref01_data",
        suffix: "_up0", textfield: "title" } }
    { op: "load", input: {
        ref: "pull_ref01", srcdatavar: "pull_ref01_data", suffix: "_dt0" } }
    { op: "remove", input: { ref: "pull_ref01", suffix: "_rm0" } }
  ]
}
`


// AN ENTITY WHOSE ONLY WRITE OP IS AN ACTION. Its `update` has a single
// point and that point is an action route — the entity has no plain update
// at all. It must still generate a `save$`: dropping the entity, or the cmd,
// leaves the action unreachable, which is the state this change is fixing.
const ACTION_ONLY_ENTITY = `
main: kit: entity: badge: {
  alias: field: {}
  name: "badge"
  id: { field: "id", name: "id" }
  field: {
    id: { name: "id", kind: "field", type: "\`$STRING\`", required: true }
  }
  fields: [ { name: "id", req: true, type: "\`$STRING\`" } ]
  op: {
    list: { name: "list", points: [ {
      args: {}, method: "GET", orig: "/badge", segments: [{ lit: "badge" }]
      transform: { req: "\`reqdata\`", res: "\`body\`" } } ] }
    update: { name: "update", points: [ {
      args: {
        params: [ { kind: "param", name: "id", orig: "id", reqd: true, type: "\`$STRING\`", example: "b01" } ]
        body: [ { kind: "body", name: "reason", type: "\`$STRING\`" } ]
      }
      method: "POST", orig: "/badge/{id}/award"
      segments: [{ lit: "badge" }, { var: "id" }, { lit: "award" }]
      select: { '$action': "award", exist: [ "id" ] }
      transform: { req: "\`reqdata\`", res: "\`body\`" } } ] }
  }
}

main: kit: flow: BasicBadgeFlow: {
  entity: "badge", kind: "basic", name: "BasicBadgeFlow"
  step: [ { op: "list" } ]
}
`


// AN ENTITY WHOSE ACTION ROUTE IS SHALLOWER THAN ITS CANONICAL ONE.
//
// Zoom's shape: the canonical update is `/user/{user_id}/meeting/{id}` and
// needs the parent, while the `status` action hangs off `/meeting/{id}` and
// does not. The guards are computed from the CANONICAL points (opParams drops
// action points), so a guard emitted ahead of the action branch demands a key
// the action's own route has no segment for.
//
// `remove` carries an action too, whose response is the action's own — an
// archive record, not the deleted meeting.
const PARENT_ACTION_ENTITY = `
main: kit: entity: meeting: {
  alias: field: {}
  name: "meeting"
  id: { field: "id", name: "id" }
  field: {
    id:    { name: "id",    kind: "field", type: "\`$STRING\`", required: true }
    topic: { name: "topic", kind: "field", type: "\`$STRING\`", required: true }
  }
  fields: [
    { name: "id",    req: true, type: "\`$STRING\`" }
    { name: "topic", req: true, type: "\`$STRING\`" }
  ]
  op: {
    list: { name: "list", points: [ {
      args: { params: [
        { kind: "param", name: "user_id", orig: "user_id", reqd: true, type: "\`$STRING\`", example: "u01" }
      ] }
      method: "GET", orig: "/user/{user_id}/meeting"
      segments: [{ lit: "user" }, { var: "user_id" }, { lit: "meeting" }]
      transform: { req: "\`reqdata\`", res: "\`body\`" } } ] }
    load: { name: "load", points: [ {
      args: { params: [
        { kind: "param", name: "user_id", orig: "user_id", reqd: true, type: "\`$STRING\`", example: "u01" }
        { kind: "param", name: "id", orig: "id", reqd: true, type: "\`$STRING\`", example: "m01" }
      ] }
      method: "GET", orig: "/user/{user_id}/meeting/{id}"
      segments: [{ lit: "user" }, { var: "user_id" }, { lit: "meeting" }, { var: "id" }]
      transform: { req: "\`reqdata\`", res: "\`body\`" } } ] }
    update: {
      name: "update"
      points: [
        {
          args: {
            params: [
              { kind: "param", name: "user_id", orig: "user_id", reqd: true, type: "\`$STRING\`", example: "u01" }
              { kind: "param", name: "id", orig: "id", reqd: true, type: "\`$STRING\`", example: "m01" }
            ]
            body: [ { kind: "body", name: "topic", type: "\`$STRING\`" } ]
          }
          method: "PATCH", orig: "/user/{user_id}/meeting/{id}"
          segments: [{ lit: "user" }, { var: "user_id" }, { lit: "meeting" }, { var: "id" }]
          transform: { req: "\`reqdata\`", res: "\`body\`" }
        }
        {
          args: {
            params: [ { kind: "param", name: "id", orig: "id", reqd: true, type: "\`$STRING\`", example: "m01" } ]
            body: [ { kind: "body", name: "state", type: "\`$STRING\`" } ]
          }
          method: "PUT", orig: "/meeting/{id}/status"
          segments: [{ lit: "meeting" }, { var: "id" }, { lit: "status" }]
          select: { '$action': "status", exist: [ "id" ] }
          transform: { req: "\`reqdata\`", res: "\`body\`" }
        }
      ]
    }
    remove: {
      name: "remove"
      points: [
        {
          args: { params: [
            { kind: "param", name: "user_id", orig: "user_id", reqd: true, type: "\`$STRING\`", example: "u01" }
            { kind: "param", name: "id", orig: "id", reqd: true, type: "\`$STRING\`", example: "m01" }
          ] }
          method: "DELETE", orig: "/user/{user_id}/meeting/{id}"
          segments: [{ lit: "user" }, { var: "user_id" }, { lit: "meeting" }, { var: "id" }]
          transform: { req: "\`reqdata\`", res: "\`body\`" }
        }
        {
          args: { params: [
            { kind: "param", name: "id", orig: "id", reqd: true, type: "\`$STRING\`", example: "m01" }
          ] }
          method: "POST", orig: "/meeting/{id}/archive"
          segments: [{ lit: "meeting" }, { var: "id" }, { lit: "archive" }]
          select: { '$action': "archive", exist: [ "id" ] }
          transform: { req: "\`reqdata\`", res: "\`body\`" }
        }
      ]
    }
  }
}

main: kit: flow: BasicMeetingFlow: {
  entity: "meeting", kind: "basic", name: "BasicMeetingFlow"
  step: [ { op: "list" } ]
}
`


// AN ENTITY WITH A SAVE ACTION, A MUTABLE FIELD AND NO `load` CMD, whose only
// update point is the action. Nothing here can perform a plain id-bearing
// save, and nothing can load a record to mutate — so a generated test that
// does both fails in a package whose supported action works perfectly.
const NO_LOAD_ENTITY = `
main: kit: entity: alert: {
  alias: field: {}
  name: "alert"
  id: { field: "id", name: "id" }
  field: {
    id:   { name: "id",   kind: "field", type: "\`$STRING\`", required: true }
    note: { name: "note", kind: "field", type: "\`$STRING\`", required: true }
  }
  fields: [
    { name: "id",   req: true, type: "\`$STRING\`" }
    { name: "note", req: true, type: "\`$STRING\`" }
  ]
  op: {
    list: { name: "list", points: [ {
      args: {}, method: "GET", orig: "/alert", segments: [{ lit: "alert" }]
      transform: { req: "\`reqdata\`", res: "\`body\`" } } ] }
    update: { name: "update", points: [ {
      args: {
        params: [ { kind: "param", name: "id", orig: "id", reqd: true, type: "\`$STRING\`", example: "a01" } ]
        body: [ { kind: "body", name: "note", type: "\`$STRING\`" } ]
      }
      method: "POST", orig: "/alert/{id}/ack"
      segments: [{ lit: "alert" }, { var: "id" }, { lit: "ack" }]
      select: { '$action': "ack", exist: [ "id" ] }
      transform: { req: "\`reqdata\`", res: "\`body\`" } } ] }
  }
}

main: kit: flow: BasicAlertFlow: {
  entity: "alert", kind: "basic", name: "BasicAlertFlow"
  step: [ { op: "list" } ]
}
`


// Generated providers exist only during the test; compile them via npm too.
function compileProvider(src) {
  const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'infrapack-provider-'))
  try {
    const input = Path.join(dir, 'provider.cts')
    Fs.writeFileSync(input, src)
    execFileSync(process.execPath, [process.env.npm_execpath,
      'run', 'build:provider-test', '--', '--outDir', dir, input,
    ], { cwd: PKG, stdio: 'inherit' })
    return Fs.readFileSync(Path.join(dir, 'provider.cjs'), 'utf8')
  }
  finally {
    Fs.rmSync(dir, { recursive: true, force: true })
  }
}


// Load a GENERATED provider and hand back the entity cmd map it builds.
//
// The provider is a plain module: it requires its own package.json and the
// SDK, calls `this.export('provider/entityBuilder')`, and hands that builder
// the map of `entity.<name>.cmd.<cmd>.action` functions. Shimming those three
// things is enough to call one of those functions directly, with a recording
// SDK in `this.shared.sdk` — no Seneca, no SDK, no server, and the code under
// test is the emitted source rather than a paraphrase of it.
function loadProvider(files, name) {
  const path = Object.keys(files).find((p) => p.endsWith(`src/${name}.ts`))
  ok(null != path, 'no provider source generated:\n  ' +
    Object.keys(files).join('\n  '))

  const js = compileProvider(String(files[path]))

  const stub = { version: '0.0.0' }
  const req = (p) => p.endsWith('package.json') ? stub : new Proxy({}, {
    get: () => class Stub { },
  })

  const mod = { exports: {} }
  new Function('exports', 'require', 'module', js)(mod.exports, req, mod)

  const plugin = mod.exports.default || mod.exports

  let entity = null
  const seneca = {
    export: () => (_self, spec) => { entity = spec.entity },
    message: () => { },
    prepare: () => { },
    shared: {},
  }

  plugin.call(seneca, { sdk: {} })
  ok(null != entity, 'the provider registered no entity map')

  return entity
}


// A recording stand-in for the SDK: every call is captured as
// [accessor, op, argument], and nothing else happens.
function recordingSdk(calls) {
  return new Proxy({}, {
    get: (_t, acc) => () => new Proxy({}, {
      get: (_t2, op) => async (arg) => {
        calls.push([String(acc), String(op), arg])
        // `list` resolves to a list of SDK entities, everything else to one.
        return 'list' === String(op) ?
          [{ data: () => ({ id: 'r0' }) }] : { data: () => ({ id: 'r0' }) }
      },
    }),
  })
}


// Drive one generated cmd action.
function drive(entity, entname, cmd, msg, calls) {
  const self = { shared: { sdk: recordingSdk(calls) } }
  return entity[entname].cmd[cmd].action.call(self, (d) => d, msg)
}


// The `msg` seneca-entity hands a save: the entity, and `data$(false)` as the
// record's own fields. `action$` is deliberately NOT in there — seneca-entity
// excludes every trailing-`$` field from data$(false), which is why the
// provider reads it off the message and the entity instead.
function saveMsg(data, extra) {
  return { q: {}, ent: { data$: () => ({ ...data }) }, ...(extra || {}) }
}


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
    const config = Path.join(consumer.root, 'tsconfig.json')
    const outdir = Path.join(consumer.sdk, 'dist', 'cmp')
    Fs.copyFileSync(Path.join(PKG, 'tsconfig.json'), config)
    execFileSync(process.execPath, [process.env.npm_execpath,
      'run', 'build', '--', '--project', config, '--outDir', outdir,
    ], { cwd: PKG, stdio: 'inherit' })
    Fs.cpSync(Path.join(consumer.sdk, 'src', 'cmp'), outdir, {
      recursive: true,
      filter: (path) => !path.endsWith('.ts') && Path.basename(path) !== 'fragment',
    })
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


  // EVERY ACTION IN A GENERATED WORKFLOW IS PINNED TO A SHA.
  //
  // An organisation can REQUIRE it (`sha_pinning_required`), and a workflow
  // naming a tag then fails to START: no jobs, no logs, just
  // `startup_failure` on every push. The senecajs org has that policy on, so
  // the generated build workflow never ran once in the repository it was
  // generated for — weeks of red marks that said nothing about the code.
  test('generated workflows pin every action to a SHA', async (t) => {
    if (!outsideSupported) {
      return t.skip('the installed @voxgig/sdkgen test kit has no `outside` '
        + 'support, so out-of-tree generation cannot be expressed here')
    }

    const { outside } = await generateInto(consumer, {
      model: consumerModel(consumer.sdk,
        "main: kit: target: 'seneca-provider': output: path: '" + OUT + "'"),
      outside: [OUT],
    })

    const workflows = Object.keys(outside[OUT])
      .filter((p) => p.startsWith('.github/workflows/'))

    ok(0 < workflows.length, 'no workflows were generated')

    for (const wf of workflows) {
      for (const line of outside[OUT][wf].split('\n')) {
        const m = /^\s*(?:-\s+)?uses:\s*(\S+)/.exec(line)
        if (null == m) {
          continue
        }
        ok(/@[0-9a-f]{40}$/.test(m[1]),
          wf + ' names an action by tag, which cannot start under a '
          + 'sha-pinning policy: ' + m[1])
      }
    }
  })


  // THE PUBLISH CREDENTIAL NEVER SHARES A JOB WITH PROJECT CODE.
  //
  // Trusted publishing mints a credential for any job granted
  // `id-token: write`, and a dependency lifecycle script can ask the runner
  // for it. A job that both installs dependencies and holds that permission
  // can therefore be made to publish as this package before its own gates
  // finish — so the install lives in a job with no id-token, and the
  // credential in a job that installs nothing.
  test('the publish job installs nothing and runs no project code', async (t) => {
    if (!outsideSupported) {
      return t.skip('the installed @voxgig/sdkgen test kit has no `outside` '
        + 'support, so out-of-tree generation cannot be expressed here')
    }

    const { outside } = await generateInto(consumer, {
      model: consumerModel(consumer.sdk,
        "main: kit: target: 'seneca-provider': output: path: '" + OUT + "'"),
      outside: [OUT],
    })

    const wf = outside[OUT]['.github/workflows/publish.yml']
    ok(null != wf, 'no publish workflow was generated')

    // Split the file at each top-level job key, so each job's steps are
    // attributed to the job that actually holds them.
    const jobs = {}
    let current = null
    for (const line of wf.split('\n')) {
      const m = /^  ([a-z][a-z0-9_-]*):\s*$/.exec(line)
      if (null != m) {
        current = m[1]
        jobs[current] = []
        continue
      }
      if (null != current) {
        jobs[current].push(line)
      }
    }

    const credentialed = Object.keys(jobs)
      .filter((j) => jobs[j].some((l) => /id-token:\s*write/.test(l)))

    ok(0 < credentialed.length,
      'no job requests id-token: write — trusted publishing cannot work')

    for (const job of credentialed) {
      const body = jobs[job].join('\n')

      // `npm install -g npm@latest` is npm itself, not a project dependency:
      // no package.json is consulted for it.
      const installs = /run:\s*npm (install|ci)(?!\s+-g)/.test(body)
      ok(!installs,
        'job "' + job + '" holds the publish credential AND installs '
        + 'project dependencies')

      ok(!/npm (run build|test)\b/.test(body),
        'job "' + job + '" holds the publish credential AND runs project code')
    }
  })


  // HOW THE PROVIDER DEPENDS ON THE SDK IT WRAPS.
  //
  // The default is the published package, pinned. That is wrong whenever the
  // SDK is not on a registry: the dependency 404s and the provider cannot be
  // installed, built, tested or released at all. @seneca/github-provider sat
  // in exactly that state, so the git-tag form is not a convenience.
  describe('the sdk dependency', () => {

    const manifestDep = async (t, overlay) => {
      if (!outsideSupported) {
        return t.skip('the installed @voxgig/sdkgen test kit has no `outside` '
          + 'support, so out-of-tree generation cannot be expressed here')
      }

      const { outside } = await generateInto(consumer, {
        model: consumerModel(consumer.sdk,
          "main: kit: target: 'seneca-provider': output: path: '" + OUT + "'\n"
          + overlay),
        outside: [OUT],
      })

      const pkg = JSON.parse(outside[OUT]['package.json'])
      const sdkpkg = Object.keys(pkg.dependencies)
        .find((n) => !n.startsWith('@seneca/'))

      return { pkg, sdkpkg, spec: pkg.dependencies[sdkpkg] }
    }


    test('defaults to the published package, pinned', async (t) => {
      const got = await manifestDep(t, '')
      if (null == got) return

      ok(/^\^\d+\.\d+\.\d+/.test(got.spec),
        'default dependency is not a pinned version: ' + got.spec)
    })


    test('a git kind points at the tag, in the SDK\'s own repo', async (t) => {
      const got = await manifestDep(t,
        "main: kit: target: 'seneca-provider': sdk: dep: {\n"
        + "  kind: 'git'\n"
        + "  ref: 'v9.9.9'\n"
        + "}")
      if (null == got) return

      ok(got.spec.startsWith('github:'),
        'not a github dependency: ' + got.spec)

      ok(got.spec.endsWith('#v9.9.9'),
        'the ref did not reach the dependency: ' + got.spec)

      // NO `::path:` SUBDIRECTORY, EVER. npm's spec parser accepts it and
      // reports a gitSubdir, so it reads as supported — and the INSTALLER
      // ignores it, cloning the repo and opening package.json at the root.
      // That was measured on linux, macOS and Windows: ENOENT on all three.
      // An SDK in a subdirectory uses `kind: 'release'` instead.
      ok(!got.spec.includes('::path:'),
        'the dependency carries a subdirectory npm will ignore: ' + got.spec)
    })


    // THE FORM THAT WORKS FOR THIS TOOLCHAIN'S OWN LAYOUT. sdkgen generates
    // the SDK into `ts/`, which no git dependency can reach; a release asset
    // is `npm pack` output attached to the tag, and npm installs an https
    // tarball without looking at the repository layout at all.
    test('a release kind points at the tag\'s asset', async (t) => {
      const got = await manifestDep(t,
        "main: kit: target: 'seneca-provider': sdk: dep: {\n"
        + "  kind: 'release'\n"
        + "  ref: 'v9.9.9'\n"
        + "}")
      if (null == got) return

      ok(got.spec.startsWith('https://github.com/'),
        'not an https tarball: ' + got.spec)
      ok(got.spec.includes('/releases/download/v9.9.9/'),
        'the ref did not reach the asset path: ' + got.spec)
      ok(got.spec.endsWith('.tgz'),
        'not a tarball: ' + got.spec)
    })


    // NPM RESOLVES A GIT DEPENDENCY AGAINST THE REPOSITORY ROOT, and sdkgen
    // generates the SDK into `ts/`. A project whose SDK package is therefore
    // unreachable by `github:owner/repo#ref` states the whole value instead,
    // and it must survive verbatim — composing it would defeat the point.
    test('an explicit spec is emitted verbatim', async (t) => {
      const url = 'https://github.com/acme/sdk/releases/download/v1/sdk-1.tgz'
      const got = await manifestDep(t,
        "main: kit: target: 'seneca-provider': sdk: dep: spec: '" + url + "'")
      if (null == got) return

      strictEqual(got.spec, url)
    })


    // A git dependency with no ref follows the default branch, so an install
    // today and an install tomorrow can differ. Refusing is the whole reason
    // the ref is not optional.
    test('a git kind with no ref is refused, by name', async (t) => {
      if (!outsideSupported) {
        return t.skip('the installed @voxgig/sdkgen test kit has no `outside` '
          + 'support, so out-of-tree generation cannot be expressed here')
      }

      let err = null
      try {
        await generateInto(consumer, {
          model: consumerModel(consumer.sdk,
            "main: kit: target: 'seneca-provider': output: path: '" + OUT + "'\n"
            + "main: kit: target: 'seneca-provider': sdk: dep: kind: 'git'"),
          outside: [OUT],
        })
      }
      catch (e) {
        err = e
      }

      ok(null != err, 'a git dependency with no ref generated anyway')
      ok(/ref/.test(String(err.message)),
        'the refusal does not name the missing ref: ' + err.message)
    })

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


  // AN ENTITY NAME THAT IS NOT A JAVASCRIPT IDENTIFIER.
  //
  // apidef canonizes an entity name to `[A-Za-z_0-9]`, so hyphens and dots
  // never reach the model — but a LEADING DIGIT does, and real resources
  // produce one: `3ds-sessions` canonizes to `3ds_session`, `2fa-tokens` to
  // `2fa_token`. Emitted bare, that is a syntax error everywhere the name is
  // used as an identifier rather than as a string.
  //
  // THIS TEST ASSERTS DIFFERENT THINGS AGAINST DIFFERENT SDKGENS, on purpose,
  // and probes for which one it has rather than comparing versions — the same
  // idiom as `outsideSupported` above.
  //
  // sdkgen used to leave the name alone, and could not declare the accessor
  // for it either: the `ts` target emitted `class 3dsSessionEntity`,
  // `import { 3dsSessionEntity }` and `3dsSession(entopts?)`, all syntax
  // errors. So this target escaped the constructs it owns — the entity map
  // key, the `entity.<name>.cmd.<op>` assignments, the SEED keys — and
  // deliberately left its `sdk.<Name>()` CALL unescaped, because escaping it
  // in isolation would have turned a loud parse failure into a runtime "not a
  // function" against a method the SDK never declared.
  //
  // sdkgen now guards the name in the model before generation (voxgig/sdkgen
  // #124), so `3ds_session` arrives here as `n3ds_session` and the accessor
  // as `N3dsSession`. Every construct is then a legal identifier without this
  // target escaping anything, the escapes become no-ops, and the whole file
  // parses — which is the stronger claim, and the one the old comment here
  // said to make once the fix landed.
  test('an entity whose name starts with a digit generates a file that parses',
    async () => {
      // No `output: path` in this model, so the provider generates IN-TREE.
      // Reading it out of `outside` because the KIT supports that option
      // conflated two different things and silently found nothing.
      const { files } = await generateInto(consumer, {
        model: consumerModel(consumer.sdk, DIGIT_ENTITY),
      })

      const provider = Object.entries(files)
        .find(([p]) => /src\/demo-provider\.ts$/.test(p))
      ok(provider, 'no provider source generated:\n  ' +
        Object.keys(files).join('\n  '))

      const src = String(provider[1])
      const suite = Object.entries(files)
        .find(([p]) => /test\/.*\.test\.js$/.test(p))

      // The probe: a guarding sdkgen renamed the entity before any component
      // saw it, so the guarded name is what reaches the output.
      const guarded = src.includes('n3ds_session')

      if (guarded) {
        // The whole file has to PARSE. That is the point of the upstream fix,
        // and a parse check cannot be satisfied by escaping one construct and
        // missing another.
        new Script(compileProvider(src))

        // The accessor must be the name the SDK actually declares.
        // `MainEntity_ts` declares the method as `${entity.Name}()`, and
        // `acc` is `ent.Name`, so these agree by construction — assert it
        // anyway, because a mismatch fails at runtime rather than at build.
        ok(/sdk\.N3dsSession\(\)/.test(src),
          'the SDK accessor is not the guarded PascalCase Name')
        ok(!/sdk\.3dsSession\(\)/.test(src),
          'an unguarded accessor survived')

        if (suite) {
          new Script(String(suite[1]))
        }
        return
      }

      // Pre-guard sdkgen: this target can only guarantee its own constructs.
      // The file does NOT parse as a whole, and asserting that it does would
      // be this package making a claim about another target.
      ok(src.includes(`'3ds_session': {`) || src.includes(`"3ds_session": {`),
        'the entity map key is not quoted')
      for (const op of ['list', 'load', 'save', 'remove']) {
        const bare = 'entity.3ds_session.cmd.' + op
        ok(!src.includes(bare),
          'a bare `' + bare + '` survived — that is a syntax error')
      }
      ok(/entity\[["']3ds_session["']\]\.cmd\.list\.action/.test(src),
        'the list action is not assigned through a bracketed access')

      if (suite) {
        ok(!/^\s+3ds_session\d?: /m.test(String(suite[1])),
          'a bare digit-leading key survived in the generated test SEED map')
      }
    })


  // THE `action$` DIRECTIVE.
  //
  // apidef folds a non-CRUD verb into an ordinary op as an extra point marked
  // `select.$action`. The `ts` SDK reaches one with `$action` in the call's
  // argument; before this, the provider had no way to name one at all, so a
  // generated GitHub plugin could not merge a pull request.
  //
  // Every test here DRIVES THE GENERATED SOURCE (see loadProvider): the
  // assertions are about what the emitted handler does when called, not about
  // what the component's source text looks like.
  describe('actions', () => {

    let entity

    before(async () => {
      const { files } = await generateInto(consumer, {
        model: consumerModel(consumer.sdk, ACTION_ENTITY + ACTION_ONLY_ENTITY),
      })
      entity = loadProvider(files, 'demo-provider')
    })


    // The case from github-sdk: `merge` is a point of `update`, and save$
    // must hand the SDK `$action` so it selects that point.
    test('save$ with action$ passes $action to the SDK', async () => {
      const calls = []
      await drive(entity, 'pull', 'save',
        saveMsg({ id: 'p1', commit_title: 'Merge #42' },
          { action$: 'merge' }), calls)

      deepStrictEqual(calls, [['Pull', 'update',
        { id: 'p1', commit_title: 'Merge #42', $action: 'merge' }]])
    })


    // THE SILENT-DROP TEST, and the most important one here.
    //
    // A save with no `action$` must still take the canonical route. Passing
    // action$ and getting an ordinary save is the worst outcome — it succeeds
    // and does something else — but so is the reverse: an action branch that
    // ran unconditionally would make every plain update an action call.
    // Neither is visible without asserting the exact argument.
    test('save$ WITHOUT action$ binds the canonical point, untouched', async () => {
      const calls = []
      await drive(entity, 'pull', 'save',
        saveMsg({ id: 'p1', title: 'New title' }), calls)

      deepStrictEqual(calls, [['Pull', 'update', { id: 'p1', title: 'New title' }]])

      // No `$action` key at all, not merely an undefined one: the SDK
      // dispatches on its presence.
      ok(!('$action' in calls[0][2]), '$action reached a call that named none')
    })


    // ROUTING BY OP, not by cmd. `upload_image` belongs to `create`, and the
    // entity carries an id — Seneca's own rule would make that an update, and
    // sending the action there asks the SDK for an action `update` does not
    // have.
    test('an action on create routes to create, not update', async () => {
      const calls = []
      await drive(entity, 'pull', 'save',
        saveMsg({ id: 'p1', image: 'x' }, { action$: 'upload_image' }), calls)

      strictEqual(calls[0][1], 'create')
    })


    // An unknown name is REFUSED, and refused before anything is called: the
    // alternative is an ordinary save that reports success.
    test('an unknown action$ throws and makes no SDK call', async () => {
      const calls = []
      let err = null

      try {
        await drive(entity, 'pull', 'save',
          saveMsg({ id: 'p1' }, { action$: 'rebase' }), calls)
      }
      catch (e) { err = e }

      ok(null != err, 'an unknown action$ was accepted')
      ok(/action\$ "rebase" is not an action/.test(err.message), err.message)
      ok(/pull save/.test(err.message),
        'the error names neither the entity nor the cmd: ' + err.message)
      ok(/merge/.test(err.message),
        'the error does not name the valid actions: ' + err.message)
      deepStrictEqual(calls, [], 'the SDK was called anyway')
    })


    // The same refusal on an entity that has NO actions, which is the case
    // most likely to be typed at by mistake.
    test('action$ on a cmd with no actions names the empty set', async () => {
      const calls = []
      let err = null

      try {
        await drive(entity, 'planet', 'save',
          saveMsg({ id: 'p1' }, { action$: 'merge' }), calls)
      }
      catch (e) { err = e }

      ok(null != err, 'action$ was ignored on an entity with no actions')
      ok(/planet save/.test(err.message), err.message)
      ok(/\(none\)/.test(err.message), err.message)
      deepStrictEqual(calls, [])
    })


    // THE READ SIDE. Actions are not confined to write ops, and on a read cmd
    // `action$` arrives as a key of the QUERY — which cleanq strips, so it has
    // to be read before that happens.
    test('list$ carries action$ from the query, and strips it as a match field',
      async () => {
        const calls = []
        await drive(entity, 'pull', 'list',
          { q: { action$: 'nosuch' }, ent: {} }, calls)
          .then(() => { throw new Error('an unknown action$ was accepted') },
            (e) => ok(/action\$ "nosuch" is not an action/.test(e.message),
              e.message))

        // And with no action$, the query reaches the SDK with no directive in
        // it — the behaviour cleanq already had, unchanged.
        calls.length = 0
        await drive(entity, 'pull', 'list',
          { q: { title: 'x', sort$: 'title' }, ent: {} }, calls)

        deepStrictEqual(calls, [['Pull', 'list', { title: 'x' }]])
      })


    // AN ENTITY WHOSE OP HAS ONLY ACTION POINTS must still generate. Its
    // `update` is a single `award` route and nothing else, so an entity
    // assembly that treated an action-only op as no op at all would drop the
    // cmd — and with it the only way to reach the endpoint.
    test('an entity whose op has only action points still generates', async () => {
      ok(null != entity.badge, 'the action-only entity vanished')
      ok(null != entity.badge.cmd.save, 'its save$ vanished')

      const calls = []
      await drive(entity, 'badge', 'save',
        saveMsg({ id: 'b1', reason: 'why' }, { action$: 'award' }), calls)

      deepStrictEqual(calls, [['Badge', 'update',
        { id: 'b1', reason: 'why', $action: 'award' }]])
    })


    // THE THREE SPELLINGS seneca-entity actually delivers, and the one it
    // does not. `make$({ action$ })` reaches nothing — make$ copies only keys
    // without a `$`, plus the four directives it knows by name — so the
    // provider reads the message and the entity as well as the query.
    test('action$ is read from the query, the message and the entity', async () => {
      for (const msg of [
        saveMsg({ id: 'p1' }, { action$: 'merge' }),                    // directive$
        saveMsg({ id: 'p1' }, { ent: { data$: () => ({ id: 'p1' }), action$: 'merge' } }),
        saveMsg({ id: 'p1' }, { q: { action$: 'merge' } }),
      ]) {
        const calls = []
        await drive(entity, 'pull', 'save', msg, calls)
        strictEqual(calls[0][2].$action, 'merge')
      }
    })
  })


  // REVIEW FINDINGS on the first cut of this mechanism. Each is a way the
  // action route can still be lost or mis-served after `action$` arrives.
  describe('actions: review findings', () => {

    let entity
    let files

    before(async () => {
      const out = await generateInto(consumer, {
        model: consumerModel(consumer.sdk,
          PARENT_ACTION_ENTITY + NO_LOAD_ENTITY),
      })
      files = out.files
      entity = loadProvider(files, 'demo-provider')
    })


    // GUARD ORDERING. The parent guards are computed from the CANONICAL
    // points — opParams drops action points — so running them ahead of the
    // action branch demands a key the action's own route has no segment for.
    // `status` hangs off `/meeting/{id}`, which needs no user_id, but the
    // canonical `/user/{user_id}/meeting/{id}` does.
    test('an action shallower than its canonical route is not blocked by the canonical guard',
      async () => {
        const calls = []
        await drive(entity, 'meeting', 'save',
          saveMsg({ id: 'm1', state: 'ended' }, { action$: 'status' }), calls)

        deepStrictEqual(calls, [['Meeting', 'update',
          { id: 'm1', state: 'ended', $action: 'status' }]])
      })


    // The same ordering on a read cmd.
    test('a read action is not blocked by the canonical guard either', async () => {
      const calls = []
      await drive(entity, 'meeting', 'remove',
        { q: { id: 'm1', action$: 'archive' }, ent: {} }, calls)

      strictEqual(calls.length, 1, 'the action call never happened')
      strictEqual(calls[0][1], 'remove')
    })


    // ...and the guard still fires on a call that named no action, which is
    // the behaviour it exists for.
    test('a call naming no action still gets its parent guard', async () => {
      const calls = []
      let err = null

      try {
        await drive(entity, 'meeting', 'save', saveMsg({ id: 'm1' }), calls)
      }
      catch (e) { err = e }

      ok(null != err, 'the parent guard stopped firing')
      ok(/user_id is required/.test(err.message), err.message)
      deepStrictEqual(calls, [])
    })


    // A REMOVE ACTION'S RESPONSE. `/meeting/{id}/archive` answers with the
    // archive record; the canonical DELETE answers with nothing, and applying
    // the canonical behaviour to the action throws its response away.
    test('a remove action returns its own response', async () => {
      const calls = []
      const res = await drive(entity, 'meeting', 'remove',
        { q: { id: 'm1', action$: 'archive' }, ent: {} }, calls)

      ok(null != res, 'the action response was discarded')
      deepStrictEqual(res, { id: 'r0' })
    })


    // ...while a plain remove still answers null, unchanged.
    test('a plain remove still answers null', async () => {
      const calls = []
      const res = await drive(entity, 'meeting', 'remove',
        { q: { id: 'm1', user_id: 'u1' }, ent: {} }, calls)

      strictEqual(res, null)
      strictEqual(calls[0][1], 'remove')
    })


    // INHERITED NAMES. The action map is an ordinary object, so `map[name]`
    // resolves `toString`, `constructor` and `__proto__` from Object's
    // prototype — non-null, so the refusal never fires and the inherited
    // function is handed to the SDK as an op name. This is the silent-drop
    // failure mode wearing a different hat: the caller named something the
    // entity does not have and did not get told.
    test('an inherited property name is refused, not treated as an action',
      async () => {
        for (const name of ['toString', 'constructor', '__proto__',
          'hasOwnProperty', 'valueOf']) {
          const calls = []
          let err = null

          try {
            await drive(entity, 'meeting', 'save',
              saveMsg({ id: 'm1' }, { action$: name }), calls)
          }
          catch (e) { err = e }

          ok(null != err, name + ' was accepted as an action')
          ok(/is not an action of this operation/.test(err.message),
            name + ': ' + err.message)
          deepStrictEqual(calls, [], name + ' reached the SDK')
        }
      })


    // The same on a cmd that has no actions at all, where the map is empty
    // and every name in it is therefore inherited.
    test('an inherited name is refused on a cmd with no actions', async () => {
      const calls = []
      let err = null

      try {
        await drive(entity, 'meeting', 'list',
          { q: { user_id: 'u1', action$: 'constructor' }, ent: {} }, calls)
      }
      catch (e) { err = e }

      ok(null != err, 'constructor was accepted on an actionless cmd')
      ok(/\(none\)/.test(err.message), err.message)
      deepStrictEqual(calls, [])
    })


    // THE PLAIN-SAVE TEST IS GENERATED, NOT UNIVERSAL. `alert` has a save
    // action, a mutable field, and no `load` cmd — nothing can fetch a record
    // to mutate, and its only update point is the action, so there is no
    // plain id-bearing save to make. Emitting the test anyway ships a red
    // suite to a package whose action works.
    test('no plain-save test is generated for an entity that cannot perform one',
      () => {
        const path = Object.keys(files)
          .find((p) => /test\/demo-provider\.test\.js$/.test(p))
        ok(null != path, 'no generated suite:\n  ' +
          Object.keys(files).join('\n  '))

        const suite = String(files[path])

        ok(!suite.includes("it('alert-save-without-action'"),
          'a plain-save test was generated for an entity with no load cmd ' +
          'and no canonical update')

        // It has no load cmd at all, so nothing generated may call load$ on it.
        ok(!/entity\('provider\/demo\/alert'\)[\s\S]{0,200}?\.load\$/.test(suite),
          'the generated suite calls load$ on an entity with no load cmd')

        // Its action coverage is still generated — the gate must not take the
        // action tests with it.
        ok(suite.includes("it('alert-action-unknown-save'"),
          'the action tests went with it')
        ok(suite.includes("it('alert-action-ack'"),
          'the positive action test went with it')

        // And the entity that CAN perform one still gets it.
        ok(suite.includes("it('meeting-save-without-action'"),
          'the plain-save test was dropped for an entity that can perform one')
      })
  })


  // `cmdActions` — which SDK op serves each action of one cmd.
  describe('cmdActions', () => {

    const { cmdActions } = loadComponent('Main_seneca-provider.ts', {
      './Extras_seneca-provider': {
        Tests: () => { }, Scripts: () => { }, Workflow: () => { },
        Readme: () => { }, Docs: () => { },
      },
      './Gitignore_seneca-provider': { Gitignore: () => { } },
    })

    const ENT = {
      name: 'pull',
      fields: {},
      op: {
        create: {
          name: 'create',
          points: [
            { orig: '/pull' },
            { orig: '/pull/{id}/image', select: { $action: 'upload_image' } },
          ],
        },
        update: {
          name: 'update',
          points: [
            { orig: '/pull/{id}' },
            { orig: '/pull/{id}/merge', select: { $action: 'merge' } },
          ],
        },
      },
    }

    // `save` spans two ops, so its map is the union — and each name has to
    // carry the op it came from, or save$ sends `upload_image` to update.
    test('save maps each action to the op that owns it', () => {
      deepStrictEqual(cmdActions(ENT, 'save'),
        { upload_image: 'create', merge: 'update' })
    })

    test('a cmd whose ops have no action points maps nothing', () => {
      deepStrictEqual(cmdActions(ENT, 'list'), {})
      deepStrictEqual(cmdActions(ENT, 'remove'), {})
    })

    // THE CONSTRUCTION HALF of the inherited-property finding. `out[name]`
    // on a plain object finds `Object.prototype.toString` for an action
    // literally named `toString`, reads it as "already claimed", and drops
    // the action — so a modelled endpoint becomes unreachable and nothing
    // says so. apidef takes an action name from a route segment, and
    // `/pull/{id}/toString` is a legal route.
    test('an action carrying an inherited property name is kept', () => {
      const ent = {
        name: 'pull',
        fields: {},
        op: {
          update: {
            name: 'update',
            points: [
              { orig: '/pull/{id}' },
              { orig: '/pull/{id}/toString', select: { $action: 'toString' } },
              { orig: '/pull/{id}/valueOf', select: { $action: 'valueOf' } },
            ],
          },
        },
      }

      const map = cmdActions(ent, 'save')

      strictEqual(map.toString, 'update')
      strictEqual(map.valueOf, 'update')
    })


    // An op the model marks inactive generates no SDK method, so an action
    // folded into it is not reachable and must not be advertised as if it
    // were — the same rule parentKeys follows for guards.
    test('an inactive op contributes no action', () => {
      const ent = {
        ...ENT,
        op: { ...ENT.op, update: { ...ENT.op.update, active: false } },
      }

      deepStrictEqual(cmdActions(ent, 'save'), { upload_image: 'create' })
    })
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
