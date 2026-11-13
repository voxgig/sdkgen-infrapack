// A stateful HTTP stand-in for an API, built from its OpenAPI definition
// alone. It knows nothing of the model a target generates from, so a request
// it refuses is one the definition does not describe: a wrong route or
// method, a parameter under a name the API does not use, a body missing a
// property the definition requires, a credential the API needs left out, or
// a variable that reached the wire unresolved (Postman sends an unset path
// variable as its `:name`).
//
// State follows REST convention. A route whose last segment is literal and
// that answers GET is a collection, a route that adds one parameter to a
// collection is an item, and anything else is an action answered from its
// success response schema. Every collection starts with one record,
// `<collection>-seed`, so a read-only flow has something to read and a run can
// name a parent that exists.

const Fs = require('node:fs')
const Http = require('node:http')

const YAML = require('yaml')


const METHODS = ['get', 'put', 'post', 'patch', 'delete']


function resolveRefs(doc) {
  const lookup = (ref) => ref.slice(2).split('/')
    .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'))
    .reduce((node, key) => null == node ? node : node[key], doc)

  const walk = (node, stack) => {
    if (null == node || 'object' !== typeof node) return node
    if ('string' === typeof node.$ref && node.$ref.startsWith('#/')) {
      if (stack.includes(node.$ref)) return {}
      return walk(lookup(node.$ref), [...stack, node.$ref])
    }
    if (Array.isArray(node)) return node.map((v) => walk(v, stack))
    const out = {}
    for (const [k, v] of Object.entries(node)) out[k] = walk(v, stack)
    return out
  }

  return walk(doc, [])
}


function sample(schema, depth = 0) {
  if (null == schema || 'object' !== typeof schema || 6 < depth) return undefined
  if (undefined !== schema.example) return schema.example
  if (Array.isArray(schema.enum) && 0 < schema.enum.length) return schema.enum[0]
  if (Array.isArray(schema.allOf)) {
    return Object.assign({}, ...schema.allOf.map((s) => sample(s, depth + 1))
      .filter((v) => null != v && 'object' === typeof v))
  }
  const union = schema.oneOf ?? schema.anyOf
  if (Array.isArray(union) && 0 < union.length) return sample(union[0], depth + 1)
  const type = Array.isArray(schema.type) ? schema.type.find((t) => 'null' !== t) : schema.type
  if ('array' === type) return []
  if ('object' === type || null != schema.properties) {
    const out = {}
    for (const [k, v] of Object.entries(schema.properties || {})) {
      const s = sample(v, depth + 1)
      if (undefined !== s) out[k] = s
    }
    return out
  }
  if ('integer' === type || 'number' === type) return 1
  if ('boolean' === type) return true
  if ('string' === type) return 'x'
  return undefined
}


function jsonSchema(content) {
  if (null == content || 'object' !== typeof content) return undefined
  const media = Object.keys(content).find((m) => /json/i.test(m))
  return null == media ? undefined : content[media]?.schema ?? {}
}


// A route's shape: its segments with every placeholder name erased, so
// routes that name the same parameter differently still line up.
const shapeOf = (segs) => segs.map((s) => /^\{[^}]+\}$/.test(s) ? '{}' : s).join('/')


function routesOf(doc) {
  const routes = []
  for (const [template, item] of Object.entries(doc.paths || {})) {
    const segs = template.split('/').filter((s) => '' !== s)
    for (const method of METHODS) {
      const op = item?.[method]
      if (null == op) continue
      const params = [...(item.parameters || []), ...(op.parameters || [])]
        .filter((p) => null != p && 'object' === typeof p && null != p.name)
      const codes = Object.keys(op.responses || {}).filter((c) => /^2/.test(c)).sort()
      const status = 0 < codes.length ? Number(codes[0].replace(/X/gi, '0')) || 200 : 200
      routes.push({
        method: method.toUpperCase(),
        template,
        segs,
        shape: shapeOf(segs),
        params,
        body: op.requestBody,
        status,
        response: jsonSchema(op.responses?.[codes[0]]?.content),
        security: op.security ?? doc.security ?? [],
      })
    }
  }
  return routes
}


function makeMock(file, opts = {}) {
  const doc = resolveRefs(YAML.parse(Fs.readFileSync(file, 'utf8')))
  const routes = routesOf(doc)
  const schemes = doc.components?.securitySchemes || {}

  const server = String(doc.servers?.[0]?.url || '')
    .replace(/\{([^}]+)\}/g, (_m, name) => String(opts.server?.[name] ?? ''))
  const prefix = server.replace(/^[a-z]+:\/\/[^/]+/i, '').replace(/\/+$/, '')

  const has = (method, shape) => routes.some((r) => r.method === method && r.shape === shape)
  const isCollection = (shape) => !shape.endsWith('{}') && has('GET', shape)

  const stores = new Map()
  const seen = []
  let serial = 0

  // The store behind a concrete collection path, holding its seed record from
  // the first time anything reaches it.
  function store(path, segs, route) {
    if (!stores.has(path)) {
      const lit = segs[segs.length - 1]
      const item = route?.response?.items ??
        Object.values(route?.response?.properties || {}).find((p) => 'array' === p?.type)?.items
      const rec = { ...(sample(item) || {}), id: lit + '-seed' }
      stores.set(path, new Map([[rec.id, rec]]))
    }
    return stores.get(path)
  }

  // The first record a path names above its own last segment that does not
  // exist, or null when every one does.
  function missingParent(template, segs) {
    for (let n = 2; n < segs.length; n++) {
      const collShape = shapeOf(template.slice(0, n - 1))
      if (!isCollection(collShape)) continue
      const coll = segs.slice(0, n - 1)
      const route = routes.find((r) => 'GET' === r.method && r.shape === collShape)
      if (!store('/' + coll.join('/'), coll, route).has(segs[n - 1])) {
        return '/' + coll.join('/') + '/' + segs[n - 1]
      }
    }
    return null
  }

  function credentialGiven(route, req, url) {
    const alternatives = Array.isArray(route.security) ? route.security : []
    if (0 === alternatives.length || alternatives.some((alt) => 0 === Object.keys(alt).length)) return true
    return alternatives.some((alt) => Object.keys(alt).every((name) => {
      const s = schemes[name] || {}
      const auth = String(req.headers.authorization || '')
      if ('http' === s.type && 'bearer' === String(s.scheme).toLowerCase()) return /^Bearer \S+$/.test(auth)
      if ('http' === s.type && 'basic' === String(s.scheme).toLowerCase()) return /^Basic \S+$/.test(auth)
      if ('apiKey' === s.type && 'header' === s.in) return '' !== String(req.headers[String(s.name).toLowerCase()] || '')
      if ('apiKey' === s.type && 'query' === s.in) return '' !== String(url.searchParams.get(s.name) || '')
      if ('apiKey' === s.type && 'cookie' === s.in) return String(req.headers.cookie || '').includes(s.name + '=')
      return true
    }))
  }

  function answer(req, text) {
    const url = new URL(req.url, 'http://mock')
    const raw = decodeURIComponent(url.pathname)

    if (/\{\{|\}\}/.test(decodeURIComponent(req.url)) || /\{\{|\}\}/.test(text) ||
      Object.values(req.headers).some((v) => /\{\{|\}\}/.test(String(v)))) {
      return [400, { error: 'an unresolved variable reached the wire' }]
    }
    if (!raw.startsWith(prefix + '/') && raw !== prefix) return [404, { error: 'not under ' + prefix }]

    const segs = raw.slice(prefix.length).split('/').filter((s) => '' !== s)
    if (segs.some((s) => s.startsWith(':'))) return [400, { error: 'an unset path variable reached the wire' }]
    const route = routes.find((r) => r.method === req.method && r.segs.length === segs.length &&
      r.segs.every((s, i) => /^\{[^}]+\}$/.test(s) || s === segs[i]))
    if (null == route) return [404, { error: 'no route for ' + req.method + ' ' + raw.slice(prefix.length) }]

    if (!credentialGiven(route, req, url)) return [401, { error: 'no credential' }]

    const named = (where) => route.params.filter((p) => where === p.in)
    for (const p of named('query')) {
      if (p.required && !url.searchParams.has(p.name)) return [400, { error: 'missing query ' + p.name }]
    }
    for (const key of url.searchParams.keys()) {
      if (!named('query').some((p) => p.name === key)) return [400, { error: 'unknown query ' + key }]
    }
    for (const p of named('header')) {
      if (p.required && null == req.headers[p.name.toLowerCase()]) return [400, { error: 'missing header ' + p.name }]
    }

    let body
    if ('' !== text) {
      try { body = JSON.parse(text) }
      catch (err) { return [400, { error: 'the body is not JSON' }] }
    }
    const schema = jsonSchema(route.body?.content)
    if (route.body?.required && undefined === body) return [400, { error: 'the body is missing' }]
    if (null != schema && null != body) {
      for (const name of schema.required || []) {
        if (undefined === body[name]) return [400, { error: 'the body has no ' + name }]
      }
    }

    const missing = missingParent(route.segs, segs)
    if (null != missing) return [404, { error: 'no record at ' + missing }]

    const shape = route.shape
    const values = {}
    route.segs.forEach((s, i) => {
      const m = /^\{([^}]+)\}$/.exec(s)
      if (null != m) values[m[1]] = segs[i]
    })

    if (isCollection(shape) && ('GET' === route.method || 'POST' === route.method)) {
      const records = store('/' + segs.join('/'), segs, routes.find((r) => 'GET' === r.method && r.shape === shape))
      if ('GET' === route.method) {
        const all = [...records.values()]
        if ('array' === route.response?.type) return [route.status, all]
        const out = sample(route.response) || {}
        const key = Object.entries(route.response?.properties || {}).find(([, p]) => 'array' === p?.type)?.[0]
        if (null != key) out[key] = all
        if ('total' in out) out.total = all.length
        return [route.status, out]
      }
      const rec = { ...(body || {}) }
      if (null == rec.id || '' === rec.id) rec.id = segs[segs.length - 1] + '-' + (++serial)
      records.set(String(rec.id), rec)
      return [route.status, rec]
    }

    const collShape = shapeOf(route.segs.slice(0, -1))
    if (shape.endsWith('{}') && isCollection(collShape)) {
      const coll = segs.slice(0, -1)
      const records = store('/' + coll.join('/'), coll,
        routes.find((r) => 'GET' === r.method && r.shape === collShape))
      const id = segs[segs.length - 1]
      const rec = records.get(id)
      if (null == rec) return [404, { error: 'no record ' + id }]
      if ('GET' === route.method) return [route.status, rec]
      if ('PUT' === route.method || 'PATCH' === route.method) {
        records.set(id, { ...rec, ...(body || {}), id })
        return [route.status, records.get(id)]
      }
      if ('DELETE' === route.method) {
        records.delete(id)
        return [route.status, undefined]
      }
    }

    // An item with no collection route, or an action: answered from the schema.
    const out = sample(route.response)
    if (null != out && 'object' === typeof out && !Array.isArray(out) && 'GET' === route.method &&
      shape.endsWith('{}')) {
      out.id = segs[segs.length - 1]
    }
    return [route.status, out]
  }

  const http = Http.createServer((req, res) => {
    let text = ''
    req.on('data', (chunk) => { text += chunk })
    req.on('end', () => {
      let status, data
      try {
        [status, data] = answer(req, text)
      }
      catch (err) {
        [status, data] = [500, { error: String(err && err.message || err) }]
      }
      seen.push({ method: req.method, path: decodeURIComponent(new URL(req.url, 'http://mock').pathname),
        url: req.url, status, error: data?.error })
      res.writeHead(status, undefined === data ? {} : { 'content-type': 'application/json' })
      res.end(undefined === data ? '' : JSON.stringify(data))
    })
  })

  return {
    seen,
    prefix,
    start: () => new Promise((done) => http.listen(0, '127.0.0.1', () => done(http.address().port))),
    stop: () => new Promise((done) => http.close(done)),
  }
}


module.exports = { makeMock, resolveRefs, sample }
