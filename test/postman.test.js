// The postman target's own suite.
//
// Three layers, from the inside out:
//
//   - UNIT tests drive the built components directly: the YAML writer, and
//     the derivation on hand-built model shapes the vendored definitions do
//     not reach.
//   - GENERATION tests build every vendored definition's model with apidef in
//     a staged consumer and generate through the real pipeline, then hold the
//     collections to the definition: no route lost, none invented.
//   - POSTMAN tests hand the generated files to the Postman CLI: its linter,
//     and its runner against a stand-in built from the definition alone.

const { test, describe, before, after } = require('node:test')
const { ok, strictEqual, deepStrictEqual } = require('node:assert')

const Fs = require('node:fs')
const Os = require('node:os')
const Path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

const YAML = require('yaml')

const { stageConsumer, generateInto } = require('@voxgig/sdkgen/testkit')

const { PKG, defs, buildApi, apiModel, compileConsumer } = require('./support')
const { makeMock, resolveRefs } = require('./mock')


const CMP = Path.join(PKG, '.build', 'cmp', 'postman')
const { yaml } = require(Path.join(CMP, 'Yaml_postman.js'))
const { catalogue } = require(Path.join(CMP, 'Catalogue_postman.js'))
const { collectionFiles } = require(Path.join(CMP, 'Collection_postman.js'))


// --- unit -------------------------------------------------------------------

describe('postman: YAML', () => {

  test('every value a collection holds survives a round trip', () => {
    const doc = {
      $kind: 'http-request',
      id: '0123abcd-0000-5000-8000-000000000000',
      plain: 'List planets',
      empty: '',
      url: '{{base}}/api/planet/:planet_id',
      colon: 'a: b',
      hash: 'a #b',
      quote: 'say "hi"',
      keyword: 'true',
      number: '1.0.0',
      digit: 3,
      flag: false,
      nothing: null,
      unicode: 'Domain → Kingdom',
      trailing: 'space ',
      script: 'const a = 1\n\nif (a) {\n  pm.test("x", () => {})\n}',
      tabbed: 'a\n\tb',
      ending: 'line\n',
      leading: '  indented\nnext',
      list: [{ key: 'page', value: '1', disabled: true }, { key: 'x' }],
      words: ['a', 'b c'],
      nested: { 'Content-Type': 'application/json', '3ds_session_id': '', 'a b': 'c' },
      none: [],
      bare: {},
    }

    deepStrictEqual(YAML.parse(yaml(doc)), doc)
  })


  test('a script is written as a literal block, line for line', () => {
    const text = yaml({ code: 'one\n  two\nthree' })
    strictEqual(text, 'code: |-\n  one\n    two\n  three\n')
  })
})


// A model as apidef and sdkgen leave it, cut down to what one test needs.
function model(entity, opts = {}) {
  return {
    name: 'demo',
    const: { name: 'demo', Name: 'Demo' },
    main: {
      kit: {
        info: { title: 'Demo API', servers: [{ url: 'http://localhost:8000' }], auth: false, ...opts.info },
        entity,
        flow: opts.flow || {},
        ...(opts.config ? { config: opts.config } : {}),
      },
    },
  }
}

const S = '`$STRING`'
const field = (n, t = S, r = true) => ({ n, h: n, t, r })
const param = (n, or, extra = {}) => ({ k: 'param', n, ...(or ? { or } : {}), r: true, t: S, ...extra })
const point = (m, o, s, extra = {}) => ({
  m, o, s: s.map((x) => /^\{/.test(x) ? { var: x.slice(1, -1) } : { lit: x }),
  t: { req: '`reqdata`', res: '`body`' }, ...extra,
})

function requestsOf(cat, entity) {
  return cat.entities.find((e) => e.name === entity).requests
}


describe('postman: derivation', () => {

  test('a renamed path parameter keeps the definition\'s name and binds its entity', () => {
    const cat = catalogue(model({
      domain: {
        name: 'domain', id: { field: 'id', name: 'id' },
        fields: { id: field('id'), name: field('name') },
        op: {
          load: { name: 'load', points: [point('GET', '/domain/{did}', ['domain', '{id}'], {
            g: { params: [param('id')] }, r: { param: { did: 'id' } },
          })] },
        },
      },
      kingdom: {
        name: 'kingdom', id: { field: 'id', name: 'id' },
        fields: { id: field('id'), name: field('name') },
        relations: { ancestors: [['domain']] },
        op: {
          list: { name: 'list', points: [point('GET', '/domain/{id}/kingdom', ['domain', '{domain_id}', 'kingdom'], {
            g: { params: [param('domain_id', 'id')] },
          })] },
        },
      },
    }))

    const [load] = requestsOf(cat, 'domain')
    strictEqual(load.url, '{{base}}/domain/:did')
    deepStrictEqual(load.pathVars.map((v) => [v.key, v.value]), [['did', '{{domain_id}}']])

    const [list] = requestsOf(cat, 'kingdom')
    strictEqual(list.url, '{{base}}/domain/:id/kingdom')
    deepStrictEqual(list.pathVars.map((v) => [v.key, v.value]), [['id', '{{domain_id}}']])
    deepStrictEqual(cat.entities.map((e) => e.name), ['domain', 'kingdom'], 'ancestors first')
  })


  test('a composite key binds each part, and a list reads each from where the record holds it', () => {
    const cat = catalogue(model({
      repo: {
        name: 'repo',
        id: { field: 'id', name: 'id', parts: ['owner', 'repo'], sep: '/', from: { owner: 'owner.login', repo: 'name' } },
        fields: { id: field('id'), name: field('name'), owner: field('owner', '`$OBJECT`', false) },
        op: {
          list: { name: 'list', points: [point('GET', '/repos', ['repos'])] },
          load: { name: 'load', points: [point('GET', '/repos/{owner}/{repo}', ['repos', '{owner}', '{repo}'], {
            g: { params: [param('owner', 'owner'), param('repo', 'repo')] },
          })] },
        },
      },
    }))

    const [list, load] = requestsOf(cat, 'repo')
    deepStrictEqual(load.pathVars.map((v) => [v.key, v.value]),
      [['owner', '{{repo_owner}}'], ['repo', '{{repo_repo}}']])

    const files = collectionFiles(cat)
    const doc = YAML.parse(files['collections/Demo API/Repo/List repos.request.yaml'])
    ok(doc.scripts[0].code.includes('at(rec, "owner.login")'), doc.scripts[0].code)
    ok(doc.scripts[0].code.includes('pm.collectionVariables.set("repo_repo", String(at(rec, "name")))'),
      doc.scripts[0].code)
    strictEqual(list.method, 'GET')
  })


  test('a record keyed by another field is addressed and remembered by that field', () => {
    const cat = catalogue(model({
      account: {
        name: 'account', id: { field: 'id', name: 'id' },
        fields: { id: field('id', '`$NUMBER`', false), username: field('username'), bio: field('bio', S, false) },
        op: {
          list: { name: 'list', points: [point('GET', '/account', ['account'])] },
          load: { name: 'load', points: [point('GET', '/account/{username}', ['account', '{username}'], {
            g: { params: [param('username', 'username')] },
          })] },
        },
      },
    }))

    const [, load] = requestsOf(cat, 'account')
    deepStrictEqual(cat.entities[0].parts, [{ name: 'username', variable: 'account_id', from: 'username' }])
    deepStrictEqual(load.pathVars.map((v) => [v.key, v.value]), [['username', '{{account_id}}']])
  })


  test('an operation reached only by actions has a request per action and none of its own', () => {
    const cat = catalogue(model({
      badge: {
        name: 'badge', id: { field: 'id', name: 'id' },
        fields: { id: field('id'), name: field('name') },
        op: {
          load: { name: 'load', points: [point('GET', '/badge/{id}', ['badge', '{id}'], {
            g: { params: [param('id')] },
          })] },
          update: { name: 'update', points: [point('POST', '/badge/{id}/award', ['badge', '{id}', 'award'], {
            g: { params: [param('id')] }, q: { $action: 'award', exist: ['id'] }, bf: ['to'],
          })] },
        },
      },
    }))

    deepStrictEqual(requestsOf(cat, 'badge').map((r) => r.title), ['Load badge', 'Award badge'])
    deepStrictEqual(requestsOf(cat, 'badge')[1].body, { to: 'example' })
  })


  test('a GraphQL route and a body that is not JSON are reported, not guessed at', () => {
    const cat = catalogue(model({
      file: {
        name: 'file', id: { field: 'id', name: 'id' },
        fields: { id: field('id') },
        op: {
          list: { name: 'list', points: [{ k: 'graphql', m: 'POST', o: 'files', s: [], gq: { field: 'files' }, t: {} }] },
          create: { name: 'create', points: [point('POST', '/file', ['file'], {
            rb: { kind: 'raw', media: 'application/octet-stream', binary: true },
          })] },
        },
      },
    }))

    deepStrictEqual(requestsOf(cat, 'file').map((r) => r.title), ['Create file'])
    strictEqual(requestsOf(cat, 'file')[0].body, undefined)
    deepStrictEqual(cat.notes.map((n) => n.op + ': ' + n.note.replace(/`[^`]*`/g, '_')), [
      'list: a GraphQL route (_), which this collection does not hold',
      'create: declares a _ body, which this collection leaves for you to add',
    ])
  })


  test('a required query parameter with no example becomes an input the environment asks for', () => {
    const cat = catalogue(model({
      report: {
        name: 'report', id: { field: 'id', name: 'id' },
        fields: { id: field('id') },
        op: {
          list: { name: 'list', points: [point('GET', '/report', ['report'], {
            g: { query: [
              { k: 'query', n: 'country', r: true, t: S },
              { k: 'query', n: 'page_size', or: 'pageSize', r: false, t: '`$INTEGER`', ex: 20 },
            ] },
          })] },
        },
      },
    }))

    const [list] = requestsOf(cat, 'report')
    strictEqual(list.url, '{{base}}/report?country={{country}}')
    deepStrictEqual(list.query, [
      { key: 'country', value: '{{country}}' },
      { key: 'pageSize', value: '20', disabled: true },
    ])
    const env = YAML.parse(collectionFiles(cat)['environments/demo.environment.yaml'])
    ok(env.values.some((v) => 'country' === v.key && '' === v.value), JSON.stringify(env))
  })


  test('each credential the SDK can send is placed where the SDK places it', () => {
    const cases = [
      [{ security: { in: 'header', name: 'X-Api-Key', prefix: '' } },
        { type: 'apikey', credentials: { key: 'X-Api-Key', value: '{{apikey}}', in: 'header' } }],
      [{ security: { in: 'query', name: 'api_key' } },
        { type: 'apikey', credentials: { key: 'api_key', value: '{{apikey}}', in: 'query' } }],
      [{ security: { in: 'header', name: 'Authorization', prefix: 'Basic', type: 'http' } },
        { type: 'basic', credentials: { username: '{{apikey}}', password: '{{secret}}' } }],
      [{ security: { in: 'header', name: 'Authorization', prefix: 'Bearer', type: 'http' } },
        { type: 'bearer', credentials: { token: '{{apikey}}' } }],
    ]
    for (const [info, want] of cases) {
      const cat = catalogue(model({
        thing: {
          name: 'thing', id: { field: 'id', name: 'id' }, fields: { id: field('id') },
          op: { list: { name: 'list', points: [point('GET', '/thing', ['thing'])] } },
        },
      }, { info: { auth: undefined, ...info } }))
      const def = YAML.parse(collectionFiles(cat)['collections/Demo API/.resources/definition.yaml'])
      const { id, name, ...got } = def.auth[0]
      deepStrictEqual(got, want, JSON.stringify(info))
    }

    const cookie = catalogue(model({
      thing: {
        name: 'thing', id: { field: 'id', name: 'id' }, fields: { id: field('id') },
        op: { list: { name: 'list', points: [point('GET', '/thing', ['thing'])] } },
      },
    }, { info: { auth: undefined, security: { in: 'cookie', name: 'session' } } }))
    deepStrictEqual(requestsOf(cookie, 'thing')[0].headers, [{ key: 'Cookie', value: 'session={{apikey}}' }])
  })


  test('the resolved definition, where it is to hand, supplies the request body', () => {
    const def = {
      paths: {
        '/thing': {
          post: {
            requestBody: { content: { 'application/json': { schema: {
              type: 'object', required: ['kind'],
              properties: {
                id: { type: 'string', readOnly: true },
                kind: { type: 'string', enum: ['rock', 'gas'] },
                size: { type: 'integer', default: 3 },
              },
            } } } },
          },
        },
      },
    }
    const resolved = {
      operation: (m, p) => {
        const op = def.paths[p]?.[String(m).toLowerCase()]
        return null == op ? undefined : { protocol: 'http', requestBody: op.requestBody }
      },
    }
    const ent = {
      thing: {
        name: 'thing', id: { field: 'id', name: 'id' },
        fields: { id: field('id'), kind: field('kind'), size: field('size', '`$INTEGER`', false) },
        op: { create: { name: 'create', points: [point('POST', '/thing', ['thing'], { bf: ['id', 'kind', 'size'] })] } },
      },
    }

    deepStrictEqual(requestsOf(catalogue(model(ent), resolved), 'thing')[0].body, { kind: 'rock', size: 3 })
    deepStrictEqual(requestsOf(catalogue(model(ent)), 'thing')[0].body,
      { id: 'thing-{{$timestamp}}', kind: 'example', size: 1 })
  })
})


// --- generation from the vendored definitions --------------------------------

const POSTMAN_CLI = Path.join(PKG, 'node_modules', 'postman-cli', 'bin', 'postman.js')

// Run the Postman CLI from `cwd`. Resolves to its exit code and its output.
function postman(args, cwd) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [POSTMAN_CLI, ...args],
      { cwd, env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    child.on('close', (code) => done({ code, out: out.replace(/\u001b\[[0-9;]*m/g, '') }))
  })
}

const cli = Fs.existsSync(POSTMAN_CLI) &&
  0 === spawnSync(process.execPath, [POSTMAN_CLI, '--version'], { encoding: 'utf8' }).status
const noCli = cli ? false : 'the Postman CLI is not installed: `npm install` adds it as a devDependency'


describe('postman: from the vendored definitions', { concurrency: true }, () => {

  let consumer
  const apis = {}

  before(async () => {
    consumer = stageConsumer({ recordLog: true })
    await consumer.addPackage(PKG)
    compileConsumer(consumer)

    for (const def of defs()) {
      await buildApi(consumer, def)
      const model = apiModel(consumer, def.api, "main: kit: target: 'seneca-provider': active: false")
      consumer.log.lines.length = 0
      const { files, leaks } = await generateInto(consumer, { model })
      const again = await generateInto(consumer, { model: apiModel(consumer, def.api,
        "main: kit: target: 'seneca-provider': active: false") })

      const out = {}
      for (const [p, text] of Object.entries(files)) {
        if (p.startsWith('postman/')) out[p.slice('postman/'.length)] = text
      }
      const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'postman-' + def.api + '-'))
      for (const [p, text] of Object.entries(out)) {
        Fs.mkdirSync(Path.dirname(Path.join(dir, 'postman', p)), { recursive: true })
        Fs.writeFileSync(Path.join(dir, 'postman', p), text)
      }

      apis[def.api] = {
        def, model, files: out, leaks, dir,
        again: Object.fromEntries(Object.entries(again.files).filter(([p]) => p.startsWith('postman/'))
          .map(([p, t]) => [p.slice('postman/'.length), t])),
        spec: resolveRefs(YAML.parse(Fs.readFileSync(def.path, 'utf8'))),
      }
    }
  })

  after(() => {
    for (const api of Object.values(apis)) Fs.rmSync(api.dir, { recursive: true, force: true })
    if (null != consumer) consumer.cleanup()
  })


  for (const def of defs()) {
    describe(def.api, { concurrency: 1 }, () => {

      test('generates, with no placeholder left and the same bytes every time', () => {
        const { files, leaks, again } = apis[def.api]
        ok(0 < Object.keys(files).length, 'nothing generated under postman/')
        deepStrictEqual(leaks.filter((l) => l.startsWith('postman/')), [])
        deepStrictEqual(again, files)
      })


      test('every file is the YAML Postman reads, of the kind its name says', () => {
        for (const [p, text] of Object.entries(apis[def.api].files)) {
          ok(!/\bundefined\b|\bNaN\b|\[object Object\]/.test(text),
            p + ' holds a value that was never set: ' +
            (text.match(/.*(\bundefined\b|\bNaN\b|\[object Object\]).*/) || [''])[0])
          if (p.endsWith('.md')) continue
          const doc = YAML.parse(text)
          if (p.endsWith('.request.yaml')) strictEqual(doc.$kind, 'http-request', p)
          else if (p.endsWith('definition.yaml')) strictEqual(doc.$kind, 'collection', p)
          else if (p.endsWith('.environment.yaml')) ok(Array.isArray(doc.values), p)
          else ok(false, 'a file Postman does not read: ' + p)
        }
      })


      // Every request is a route the definition declares, under the name the
      // definition gives each parameter, and every route the model turned
      // into an entity operation is a request.
      test('the reference collection is the model\'s routes, no more and no fewer', () => {
        const { files, model, spec } = apis[def.api]
        const title = model.main.kit.info.title
        const got = Object.entries(files)
          .filter(([p]) => p.startsWith('collections/' + title + '/') && p.endsWith('.request.yaml'))
          .map(([, text]) => YAML.parse(text))
          .map((doc) => doc.method + ' ' + doc.url.replace(/^\{\{base\}\}/, '').replace(/\?.*$/, '')
            .replace(/:([A-Za-z0-9_-]+)/g, '{$1}'))
          .sort()

        const declared = []
        for (const [path, item] of Object.entries(spec.paths)) {
          for (const m of ['get', 'put', 'post', 'patch', 'delete']) {
            if (null != item[m]) declared.push(m.toUpperCase() + ' ' + path)
          }
        }
        for (const route of got) ok(declared.includes(route), 'not a route of the definition: ' + route)

        const modelled = []
        for (const ent of Object.values(model.main.kit.entity)) {
          if (false === ent.active) continue
          for (const op of Object.values(ent.op || {})) {
            if (false === op.active) continue
            for (const pt of op.points || []) {
              if (false !== pt.a && 'graphql' !== pt.k) modelled.push(String(pt.m).toUpperCase() + ' ' + pt.o)
            }
          }
        }
        deepStrictEqual(got, modelled.sort())
      })


      test('each active flow is a folder of its steps', () => {
        const { files, model } = apis[def.api]
        const title = model.main.kit.info.title
        const folders = new Set(Object.keys(files)
          .filter((p) => p.startsWith('collections/' + title + ' flows/') && p.endsWith('.request.yaml'))
          .map((p) => p.split('/')[2]))
        const flows = Object.values(model.main.kit.flow || {}).filter((f) => false !== f.active).map((f) => f.name)
        ok(0 < folders.size, 'no flow folder')
        for (const folder of folders) ok(flows.includes(folder), 'not a flow of the model: ' + folder)
      })


      describe('in Postman', () => {

        const inputs = (api, extra = {}) => {
          const { files, model } = apis[api]
          const title = model.main.kit.info.title
          const env = YAML.parse(files[Object.keys(files).find((p) => p.endsWith('.environment.yaml'))])
          const flows = YAML.parse(files['collections/' + title + ' flows/.resources/definition.yaml'])
          const out = {}
          for (const { key, value } of env.values) {
            if ('' === value) out[key] = 'apikey' === key ? 'key-1' : 'year' === key ? '2026' : key + '-1'
          }
          for (const [key, value] of Object.entries(flows.variables)) {
            if ('' === value) out[key] = key.replace(/_id$/, '') + '-seed'
          }
          return { ...out, ...extra }
        }

        async function run(api, collection, vars, args = []) {
          const { def, dir, model } = apis[api]
          const declared = Object.keys(model.main.kit.info.servers?.[0]?.variables || {})
          const server = Object.fromEntries(Object.entries(vars).filter(([k]) => declared.includes(k)))
          const mock = makeMock(def.path, { server })
          const port = await mock.start()
          try {
            const base = 'http://127.0.0.1:' + port + mock.prefix
            const argv = ['collection', 'run', collection, '--env-var', 'base=' + base, ...args]
            for (const [k, v] of Object.entries(vars)) argv.push('--env-var', k + '=' + v)
            const res = await postman(argv, dir)
            return { ...res, seen: mock.seen }
          }
          finally {
            await mock.stop()
          }
        }

        const refused = (seen) => seen.filter((s) => 300 <= s.status)
          .map((s) => s.method + ' ' + s.url + ' -> ' + s.status + ' ' + s.error)


        test('the Postman linter finds nothing in either collection or the environment',
          { skip: noCli }, async () => {
            const { files, dir } = apis[def.api]
            const collections = [...new Set(Object.keys(files).filter((p) => p.startsWith('collections/'))
              .map((p) => p.split('/')[1]))]
            const [env, ...linted] = await Promise.all([
              postman(['environment', 'lint', 'postman/environments'], dir),
              ...collections.map((c) => postman(['collection', 'lint', 'postman/collections/' + c], dir)),
            ])
            strictEqual(env.code, 0, env.out)
            linted.forEach((res, i) => {
              strictEqual(res.code, 0, collections[i] + ':\n' + res.out)
              ok(/No issues found/.test(res.out), collections[i] + ':\n' + res.out)
            })
          })


        test('every flow runs green against the definition, given its inputs', { skip: noCli }, async () => {
          const { model } = apis[def.api]
          const res = await run(def.api, 'postman/collections/' + model.main.kit.info.title + ' flows', inputs(def.api))
          deepStrictEqual(refused(res.seen), [])
          strictEqual(res.code, 0, res.out.slice(-3000))
          ok(0 < res.seen.length, 'no request reached the server')
        })


        test('without the records it needs, a strict run fails on the blocked steps and sends none of them',
          { skip: noCli }, async () => {
            const { model, files } = apis[def.api]
            const title = model.main.kit.info.title
            const records = Object.entries(YAML.parse(
              files['collections/' + title + ' flows/.resources/definition.yaml']).variables)
              .filter(([, v]) => '' === v).map(([k]) => k)
            const given = inputs(def.api)
            for (const k of records) delete given[k]

            const res = await run(def.api, 'postman/collections/' + title + ' flows', given)
            deepStrictEqual(refused(res.seen), [])
            if (0 === records.length) {
              strictEqual(res.code, 0, res.out.slice(-2000))
              return
            }
            strictEqual(res.code, 1, res.out.slice(-2000))
            const failures = res.out.split('\n').filter((l) => /^\s*\d+\.\s+(Error|AssertionError)/.test(l))
            ok(0 < failures.length, res.out.slice(-2000))
            for (const f of failures) ok(/blocked: /.test(f), 'not a blocked step: ' + f)
          })


        test('getonly sends nothing but GET requests', { skip: noCli }, async () => {
          const { model } = apis[def.api]
          const res = await run(def.api, 'postman/collections/' + model.main.kit.info.title + ' flows',
            inputs(def.api, { getonly: 'true', access_token: 'token-1' }))
          deepStrictEqual(refused(res.seen), [])
          deepStrictEqual([...new Set(res.seen.map((s) => s.method))], ['GET'])
          strictEqual(res.code, 0, res.out.slice(-2000))
        })


        test('every reference request is one the definition accepts', { skip: noCli }, async () => {
          const { model, files } = apis[def.api]
          const title = model.main.kit.info.title
          const folders = [...new Set(Object.keys(files)
            .filter((p) => p.startsWith('collections/' + title + '/') && p.endsWith('.request.yaml'))
            .map((p) => p.split('/')[2]))]

          const runs = await Promise.all(folders.map((folder) => {
            const own = folder.toLowerCase() + '_id'
            const vars = inputs(def.api)
            const remembers = Object.keys(files).some((p) =>
              p.startsWith('collections/' + title + '/' + folder + '/') && /\/(List|Create) /.test(p))
            if (remembers) delete vars[own]
            else vars[own] = folder.toLowerCase() + '-seed'
            return run(def.api, 'postman/collections/' + title, vars, ['-i', folder])
          }))
          runs.forEach((res, i) => {
            deepStrictEqual(refused(res.seen), [], folders[i])
            strictEqual(res.code, 0, folders[i] + ':\n' + res.out.slice(-2000))
            ok(0 < res.seen.length, folders[i] + ': no request reached the server')
          })
        })
      })
    })
  }
})
