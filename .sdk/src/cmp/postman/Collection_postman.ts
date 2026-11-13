import Crypto from 'node:crypto'

import { yaml } from './Yaml_postman'


const JS = 'text/javascript'


// Ids derived from what they name, so a regeneration rewrites nothing.
function uuid(seed: string): string {
  const h = Crypto.createHash('sha1').update('voxgig/sdkgen/postman\u0000' + seed).digest()
  h[6] = (h[6] & 0x0f) | 0x50
  h[8] = (h[8] & 0x3f) | 0x80
  const x = h.subarray(0, 16).toString('hex')
  return [x.slice(0, 8), x.slice(8, 12), x.slice(12, 16), x.slice(16, 20), x.slice(20)].join('-')
}


// A name Postman accepts for a file or a folder.
function safe(name: string): string {
  return String(name).replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim().replace(/^\.+/, '') || 'unnamed'
}


const script = (type: string, lines: string[]) => ({ type, code: lines.join('\n'), language: JS })

const js = (v: any) => JSON.stringify(v)

// The record a response holds, through the route's own unwrap.
const record = (unwrap: string[]) =>
  'body' + unwrap.map((k) => '?.[' + js(k) + ']').join('')

const readBody = 'const body = (() => { try { return pm.response.json() } catch (e) { return null } })()'

const readPath = 'const at = (rec, path) => path.split(".").reduce((n, k) => null == n ? n : n[k], rec)'


function authDoc(auth: any, scope: string): any[] | undefined {
  if (null == auth || 'cookie' === auth.kind) return undefined
  const entry = (type: string, credentials: any) =>
    [{ id: uuid(scope + '/auth'), type, name: type + ' auth', credentials }]
  const token = '{{' + auth.token + '}}'
  if ('bearer' === auth.kind) return entry('bearer', { token })
  if ('basic' === auth.kind) return entry('basic', { username: token, password: '{{secret}}' })
  return entry('apikey', {
    key: auth.name,
    value: 'header' === auth.in && '' !== String(auth.prefix || '') ? auth.prefix + ' ' + token : token,
    in: 'query' === auth.in ? 'query' : 'header',
  })
}


// The stored credential is exchanged for a token once a run, and only when
// no token was given.
function exchangeScript(auth: any, guarded: boolean): string[] {
  if (null == auth?.exchange) return []
  const x = auth.exchange
  return [
    'const given = (name) => { const v = pm.variables.get(name); return null != v && "" !== v }',
    'if (!given("access_token") && given("apikey")' +
      (guarded ? ' && "true" !== String(pm.variables.get("getonly")).toLowerCase()' : '') + ') {',
    '  pm.sendRequest({',
    '    url: pm.variables.replaceIn("{{base}}/' + String(x.path).replace(/^\//, '') + '"),',
    '    method: ' + js(x.method) + ',',
    '    header: { "Content-Type": "application/json" },',
    '    body: { mode: "raw", raw: JSON.stringify({ ' + js(x.request) + ': pm.variables.get("apikey") }) },',
    '  }, (err, res) => {',
    '    if (!err && res.code < 300) pm.variables.set("access_token", res.json()?.[' + js(x.response) + '])',
    '  })',
    '}',
  ]
}


function requestDoc(req: any, extra: any): any {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (undefined !== req.body) headers['Content-Type'] = 'application/json'
  for (const h of req.headers) headers[h.key] = h.value

  return {
    $kind: 'http-request',
    id: extra.id,
    description: extra.description,
    url: req.url,
    method: req.method,
    headers,
    queryParams: 0 < req.query.length ? req.query.map((q: any) =>
      ({ key: q.key, value: q.value, ...(q.disabled ? { disabled: true } : {}) })) : undefined,
    pathVariables: 0 < req.pathVars.length ? req.pathVars : undefined,
    body: undefined === req.body ? undefined : { type: 'json', content: bodyText(req) },
    scripts: 0 < (extra.scripts || []).length ? extra.scripts : undefined,
    order: extra.order,
  }
}


// A variable that stands for a number is written unquoted, so the value
// Postman substitutes reaches the API as a number, not as a string.
function bodyText(req: any): string {
  let text = JSON.stringify(req.body, null, 2)
  for (const name of req.unquoted || []) {
    const value = req.body[name]
    text = text.replace(js(name) + ': ' + js(value), js(name) + ': ' + value)
  }
  return text
}


function describe(req: any): string {
  return (null != req.action ?
    'The `' + req.action + '` action of **' + req.entity + '**, a route of its `' + req.op + '` operation.' :
    'The `' + req.op + '` operation of **' + req.entity + '**.') +
    '\n\nSDK: `' + req.sdk + '`'
}


function variables(cat: any, own: string[], extra: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { base: cat.server.base, ...extra }
  for (const name of own) out[name] = ''
  return out
}


// Inputs a request names that no entity record supplies, with the example
// the definition gives, where it gives one.
function inputs(requests: any[]): { name: string, example?: string }[] {
  const out: { name: string, example?: string }[] = []
  for (const req of requests) {
    for (const b of req.params) {
      if ('input' === b.role && !out.some((i) => i.name === b.variable)) {
        out.push({ name: b.variable, example: b.example })
      }
    }
  }
  return out
}


function referenceFiles(cat: any, root: string, files: Record<string, string>): void {
  const requests = cat.entities.flatMap((e: any) => e.requests)
  const own = cat.entities.flatMap((e: any) => e.parts.map((p: any) => p.variable))
  const examples: Record<string, string> = {}
  for (const i of inputs(requests)) {
    if (undefined !== i.example) examples[i.name] = i.example
  }

  const exchange = exchangeScript(cat.auth, false)
  files[root + '/.resources/definition.yaml'] = yaml({
    $kind: 'collection',
    id: uuid(cat.name + '/reference'),
    description: (cat.description ? cat.description.trim() + '\n\n' : '') +
      'One folder per entity, one request per operation. Generated by @voxgig/sdkgen ' +
      'from the model the SDKs are generated from: regenerate rather than edit.',
    variables: variables(cat, own, examples),
    auth: authDoc(cat.auth, cat.name + '/reference'),
    scripts: 0 < exchange.length ? [script('http:beforeRequest', exchange)] : undefined,
  })

  cat.entities.forEach((ent: any, ei: number) => {
    const dir = root + '/' + safe(ent.title)
    const rows = ent.fields.map((f: any) => '| `' + f.name + '` | ' + f.type + ' | ' +
      (f.required ? 'yes' : '') + ' | ' + (f.readonly ? 'read-only' : '') + ' |')
    files[dir + '/.resources/definition.yaml'] = yaml({
      $kind: 'collection',
      id: uuid(cat.name + '/reference/' + ent.name),
      description: [
        (ent.description ? ent.description + '\n\n' : '') +
        'The **' + ent.name + '** entity' +
        (0 < ent.ancestors.length ? ', which belongs to a ' + ent.ancestors.join(' and a ') : '') + '.' +
        ' Its requests address one record by ' +
        ent.parts.map((p: any) => '`{{' + p.variable + '}}`').join(' and ') +
        ', which a list or a create remembers.',
        '',
        '| field | type | required | |',
        '|---|---|---|---|',
        ...rows,
      ].join('\n'),
      order: (ei + 1) * 1000,
    })

    ent.requests.forEach((req: any, ri: number) => {
      const scripts: any[] = []
      if (null == req.action && 'remove' === req.op) {
        scripts.push(script('afterResponse', [
          'if (pm.response.code < 300) {',
          ...ent.parts.map((p: any) => '  pm.collectionVariables.unset(' + js(p.variable) + ')'),
          '}',
        ]))
      }
      const remembers = null == req.action && null != req.unwrap &&
        ('create' === req.op || 'list' === req.op)
      if (remembers) {
        const list = 'list' === req.op
        scripts.push(script('afterResponse', [
          readBody,
          readPath,
          'const rec = ' + (list ? '(' + record(req.unwrap) + ' || [])[0]' : record(req.unwrap)),
          'if (pm.response.code < 300 && null != rec) {',
          ...ent.parts.map((p: any) => {
            const held = 'pm.collectionVariables.get(' + js(p.variable) + ')'
            return '  if (null != at(rec, ' + js(p.from) + ')' + (list ? ' && !' + held : '') +
              ') pm.collectionVariables.set(' + js(p.variable) + ', String(at(rec, ' + js(p.from) + ')))'
          }),
          '}',
        ]))
      }

      files[dir + '/' + safe(req.title) + '.request.yaml'] = yaml(requestDoc(req, {
        id: uuid(cat.name + '/reference/' + req.key),
        description: describe(req),
        scripts,
        order: (ri + 1) * 1000,
      }))
    })
  })
}


// Blocks a step whose inputs nothing has given, skipping it rather than
// sending a URL with an unset variable in it. `strict` decides whether a
// blocked step fails the run, and `getonly` sends nothing but GET requests.
function guardScript(cat: any, needs: string[]): string[] {
  const credential = null == cat.auth ? [] : null != cat.auth.exchange ?
    ['if (!given("access_token") && (getonly || !given("apikey"))) missing.unshift("apikey or access_token")'] :
    ['if (!given("apikey")) missing.unshift("apikey")']
  return [
    'const given = (name) => { const v = pm.variables.get(name); return null != v && "" !== v }',
    'const flag = (name, dflt) => given(name) ? "true" === String(pm.variables.get(name)).toLowerCase() : dflt',
    'const getonly = flag("getonly", false)',
    'const missing = ' + js(needs) + '.filter((name) => !given(name))',
    ...credential,
    'const empty = 0 < missing.length && missing.every((name) => given(name + "__empty"))',
    'if (getonly && "GET" !== pm.request.method) {',
    '  console.log("excluded (getonly): " + pm.info.requestName)',
    '  pm.execution.skipRequest()',
    '}',
    'else if (empty) {',
    '  console.log("skipped: " + pm.info.requestName + " has no record to read: the list was empty")',
    '  pm.execution.skipRequest()',
    '}',
    'else if (0 < missing.length) {',
    '  const why = pm.info.requestName + " needs " + missing.join(", ") + ", which no earlier step or variable gave"',
    '  if (getonly || !flag("strict", true)) console.log((getonly ? "excluded (getonly): " : "blocked: ") + why)',
    '  else pm.test("blocked: " + why, () => { throw new Error("blocked") })',
    '  pm.execution.skipRequest()',
    '}',
  ]
}


function mintScript(step: any): string[] {
  return step.minted.map((name: string) => 'pm.variables.set(' + js(name) + ', ' +
    (step.mintNumeric.includes(name) ? 'String(Math.floor(Date.now() / 1000))' :
      js(step.entity + '-') + ' + Date.now().toString(36)') + ')')
}


// The checks a step carries come from the model's own flow validators. Each
// asks only about a record the run holds, so a step that was left out takes
// its dependants' checks with it rather than failing them.
function checkScript(step: any): string[] {
  const out = [
    'pm.test(' + js(step.title + ': succeeds') + ', () => {',
    '  pm.expect(pm.response.code, "status").to.be.within(200, 299)',
    '})',
  ]
  if (null == step.unwrap) return out

  const parts = step.parts
  const held = (p: any) => 'pm.variables.get(' + js(p.held) + ')'
  const key = (expr: string) => parts.map((p: any) => 'String(at(' + expr + ', ' + js(p.from) + '))').join(' + "/" + ')
  const heldKey = parts.map((p: any) => 'String(' + held(p) + ')').join(' + "/" + ')
  const gone = js(step.ref + '_removed')
  const marked = js(step.ref + '_marked')

  out.push(readBody, readPath)

  if ('create' === step.op) {
    out.push('const made = ' + record(step.unwrap))
    if (0 === step.minted.length) {
      out.push(
        'pm.test(' + js(step.title + ': the record carries its key') + ', () => {',
        '  pm.expect(made, "record").to.be.an("object")',
        ...parts.map((p: any) => '  pm.expect(at(made, ' + js(p.from) + '), ' + js(p.from) + ').to.exist'),
        '})')
    }
    out.push(...parts.map((p: any) =>
      'if (null != made && null != at(made, ' + js(p.from) + ')) pm.variables.set(' + js(p.held) +
      ', String(at(made, ' + js(p.from) + ')))'))
  }

  if ('list' === step.op) {
    out.push('const recs = ' + record(step.unwrap) + ' || []',
      'const keys = Array.isArray(recs) ? recs.map((rec) => ' + key('rec') + ') : []')
    if (step.adopts) {
      const adopt = String(!step.made) + ' || "true" === String(pm.variables.get("getonly")).toLowerCase()'
      out.push(
        'if (null == ' + held(parts[0]) + ' && (' + adopt + ')) {',
        '  if (Array.isArray(recs) && null != recs[0]) {',
        ...parts.map((p: any) => '    pm.variables.set(' + js(p.held) + ', String(at(recs[0], ' + js(p.from) + ')))'),
        '  }',
        '  else if (pm.response.code < 300) {',
        ...parts.map((p: any) => '    pm.variables.set(' + js(p.held + '__empty') + ', "true")'),
        '  }',
        '}')
    }
  }

  for (const check of step.checks) {
    if ('ItemExists' === check.apply && 'list' === step.op) {
      out.push(
        'if (null != ' + held(parts[0]) + ') pm.test(' + js(step.title + ': the record is listed') + ', () => {',
        '  pm.expect(keys).to.include(' + heldKey + ')',
        '})')
    }
    else if ('ItemNotExists' === check.apply && 'list' === step.op) {
      out.push(
        'if (null != pm.variables.get(' + gone + ')) pm.test(' + js(step.title + ': the removed record is gone') + ', () => {',
        '  pm.expect(keys).to.not.include(pm.variables.get(' + gone + '))',
        '})')
    }
    else if ('TextFieldMark' === check.apply && null != check.mark) {
      out.push(
        'if (' + js(check.mark) + ' === pm.variables.get(' + marked + ')) pm.test(' + js(step.title + ': the update reads back') + ', () => {',
        '  pm.expect(JSON.stringify(' + record(step.unwrap) + ')).to.include(' + js(check.mark) + ')',
        '})')
    }
  }

  if ('load' === step.op || 'update' === step.op || 'patch' === step.op) {
    out.push(
      'pm.test(' + js(step.title + ': the record is the one asked for') + ', () => {',
      '  pm.expect(' + key(record(step.unwrap)) + ').to.eql(' + heldKey + ')',
      '})')
  }

  if (null != step.mark) {
    out.push('if (pm.response.code < 300) pm.variables.set(' + marked + ', ' + js(step.mark) + ')')
  }

  if ('remove' === step.op) {
    out.push(
      'if (pm.response.code < 300) {',
      '  pm.variables.set(' + gone + ', ' + heldKey + ')',
      ...parts.map((p: any) => '  pm.variables.unset(' + js(p.held) + ')'),
      '}')
  }

  return out
}


// The records the flows read but neither create nor list, which a run is given.
function flowRecords(cat: any): string[] {
  const out: string[] = []
  for (const step of cat.flows.flatMap((f: any) => f.steps)) {
    for (const name of step.records) if (!out.includes(name)) out.push(name)
  }
  return out
}


function flowFiles(cat: any, root: string, files: Record<string, string>): void {
  const examples: Record<string, string> = { strict: 'true', getonly: 'false' }
  for (const step of cat.flows.flatMap((f: any) => f.steps)) {
    for (const b of step.params) {
      if ('input' === b.role && undefined !== b.example) examples[b.variable] = b.example
    }
  }
  const records = flowRecords(cat)

  const exchange = exchangeScript(cat.auth, true)
  files[root + '/.resources/definition.yaml'] = yaml({
    $kind: 'collection',
    id: uuid(cat.name + '/flows'),
    description: 'The entity flows of the ' + cat.title + ' model, runnable in order: each ' +
      'folder is one flow and runs on its own. A step whose inputs nothing gave is blocked, and ' +
      'fails the run unless `strict` is `false`. With `getonly` set to `true` only GET requests ' +
      'are sent. Generated by @voxgig/sdkgen: regenerate rather than edit.',
    variables: variables(cat, records, examples),
    auth: authDoc(cat.auth, cat.name + '/flows'),
    scripts: 0 < exchange.length ? [script('http:beforeRequest', exchange)] : undefined,
  })

  cat.flows.forEach((flow: any, fi: number) => {
    const dir = root + '/' + safe(flow.name)
    files[dir + '/.resources/definition.yaml'] = yaml({
      $kind: 'collection',
      id: uuid(cat.name + '/flows/' + flow.name),
      description: 'The `' + flow.name + '` flow of **' + flow.entity + '**.',
      order: (fi + 1) * 1000,
    })

    flow.steps.forEach((step: any, si: number) => {
      files[dir + '/' + safe(step.title) + '.request.yaml'] = yaml(requestDoc(step, {
        id: uuid(cat.name + '/flows/' + step.key),
        description: describe(step),
        scripts: [
          script('beforeRequest', [...guardScript(cat, step.needs), ...mintScript(step)]),
          script('afterResponse', checkScript(step)),
        ],
        order: (si + 1) * 1000,
      }))
    })
  })
}


function environmentFile(cat: any): { name: string, values: any[] } {
  const requests = [...cat.entities.flatMap((e: any) => e.requests),
    ...cat.flows.flatMap((f: any) => f.steps)]
  const values: { key: string, value: string }[] = [{ key: 'base', value: cat.server.base }]
  for (const v of cat.server.variables) values.push({ key: v.name, value: String(v.value ?? '') })
  if (null != cat.auth) {
    values.push({ key: 'apikey', value: '' })
    if ('basic' === cat.auth.kind) values.push({ key: 'secret', value: '' })
    if (null != cat.auth.exchange) values.push({ key: 'access_token', value: '' })
  }
  for (const i of inputs(requests)) {
    if (undefined === i.example && !values.some((v) => v.key === i.name)) {
      values.push({ key: i.name, value: '' })
    }
  }
  return { name: cat.name, values: values.map((v) => ({ ...v, enabled: true })) }
}


function readme(cat: any, refdir: string, flowdir: string, envfile: string): string {
  const env = environmentFile(cat)
  const given = env.values.filter((v: any) => '' === v.value).map((v: any) => v.key)
  for (const name of flowRecords(cat)) if (!given.includes(name)) given.push(name)
  const run = 'postman collection run "postman/' + flowdir + '" \\\n  --environment postman/' + envfile +
    given.map((name: string) => ' \\\n  --env-var ' + name + '=...').join('')
  const lines = [
    '# ' + cat.title + ': Postman collections',
    '',
    'Generated by [@voxgig/sdkgen](https://github.com/voxgig/sdkgen) from the model the',
    'SDKs are generated from, in the Postman v12 local-workspace layout. Regenerate',
    'rather than edit: a regeneration overwrites these files.',
    '',
    '| path | holds |',
    '|---|---|',
    '| `' + refdir + '/` | one folder per entity, one request per operation and action |',
    ...(0 < cat.flows.length ?
      ['| `' + flowdir + '/` | the model\'s entity flows, runnable in order |'] : []),
    '| `' + envfile + '` | the server, the credential and the inputs a run is given |',
    '',
    'Open the folder that holds `postman/` in Postman to use them, or run the flows',
    'from it with the [Postman CLI](https://learning.postman.com/docs/postman-cli/postman-cli-overview/):',
    '',
    '```bash',
    run,
    '```',
    '',
    'A request addresses a record through its entity\'s variable, which a list or a',
    'create in the reference collection remembers: `{{' +
    (cat.entities[0]?.parts[0]?.variable ?? 'id') + '}}` for the first entity here.',
    'Set `strict` to `false` to skip a flow step whose inputs nothing gave rather',
    'than fail it, and `getonly` to `true` to send GET requests alone. Keep',
    'credentials out of the environment file: give them at run time, or as local',
    'values in Postman.',
  ]
  if (0 < cat.notes.length) {
    lines.push('', '## Not in these collections', '')
    for (const n of cat.notes) {
      lines.push('- ' + [n.entity, n.flow, n.op].filter((x: any) => null != x).map((x: any) => '`' + x + '`').join(' ') +
        (null != n.entity || null != n.flow ? ': ' : '') + n.note)
    }
  }
  return lines.join('\n') + '\n'
}


// Every file the target writes, keyed by its path under the target folder.
function collectionFiles(cat: any): Record<string, string> {
  const files: Record<string, string> = {}
  const refdir = 'collections/' + safe(cat.title)
  const flowdir = 'collections/' + safe(cat.title + ' flows')
  const envfile = 'environments/' + safe(cat.name) + '.environment.yaml'

  referenceFiles(cat, refdir, files)
  if (0 < cat.flows.length) flowFiles(cat, flowdir, files)
  files[envfile] = yaml(environmentFile(cat))
  files['README.md'] = readme(cat, refdir, flowdir, envfile)

  return files
}


export {
  collectionFiles,
  uuid,
  safe,
}
