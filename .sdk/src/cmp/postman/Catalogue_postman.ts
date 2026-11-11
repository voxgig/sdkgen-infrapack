import {
  entityCollection, entityIdField, ownPoint, pointSegments, canonScalarKey,
  isAuthActive, isHttpBasicAuth, resolveAuthIn, resolveAuthName, resolveAuthPrefix,
  serverVariables, primaryOpCall,
} from '@voxgig/sdkgen'

import {
  KIT,
} from '@voxgig/apidef'


const CANON = ['list', 'load', 'create', 'update', 'patch', 'remove']
const BODY_METHODS = ['POST', 'PUT', 'PATCH']
const VAR_RE = /\{\{([^{}$][^{}]*)\}\}/g


type Note = { entity?: string, op?: string, flow?: string, note: string }

type Part = { name: string, variable: string, from: string }

type Bound = {
  name: string
  role: 'own' | 'ref' | 'input'
  variable: string
  entity?: string
  part?: Part
  example?: any
}

type Pair = { key: string, value: string, disabled?: boolean, description?: string }


const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

const plural = (s: string) =>
  /s$/.test(s) ? s : /(x|z|ch|sh)$/.test(s) ? s + 'es' :
    /[^aeiou]y$/.test(s) ? s.slice(0, -1) + 'ies' : s + 's'

const scalarEx = (v: any) =>
  null != v && 'object' !== typeof v && '' !== String(v) ? String(v) : undefined


// The key that addresses one record: the model's identifier where the load
// match carries it, else the terminal path parameter of the record's own
// route, else a lone required query parameter.
function recordKey(ent: any): string {
  const idf = entityIdField(ent)
  if (null != idf && '' !== idf) return String(idf)

  for (const opname of ['load', 'remove', 'update', 'patch']) {
    const points = (ent?.op?.[opname]?.points || []).filter((pt: any) => false !== pt?.a)
    if (0 === points.length) continue
    const canonical = points.filter((pt: any) => null == pt?.q?.['$action'])
    const pt = ownPoint(0 < canonical.length ? canonical : points)
    const segs = pointSegments(pt)
    const last = segs[segs.length - 1]
    if (null != last && null != last.var) return String(last.var)
    const reqd = (pt?.g?.query || []).filter((q: any) => false !== q.r)
    if (1 === reqd.length) return String(reqd[0].n)
  }

  return String(ent?.id?.field || 'id')
}


function identity(ent: any): Part[] {
  const id = ent?.id || {}
  const from = null != id.from && 'object' === typeof id.from ? id.from : {}
  if (Array.isArray(id.parts) && 1 < id.parts.length) {
    return id.parts.map((p: any) => String(p)).map((name: string) =>
      ({ name, variable: ent.name + '_' + name, from: String(from[name] || name) }))
  }
  const name = recordKey(ent)
  return [{ name, variable: ent.name + '_id', from: String(from[name] || name) }]
}


function ancestorsOf(ent: any, names: string[]): string[] {
  const chains = ent?.relations?.ancestors || []
  const out: string[] = []
  for (const chain of Array.isArray(chains) ? chains : []) {
    for (const link of Array.isArray(chain) ? chain : [chain]) {
      const name = 'string' === typeof link ? link.replace(/^.*\./, '') : String(link?.name ?? '')
      if (names.includes(name) && name !== ent.name && !out.includes(name)) out.push(name)
    }
  }
  return out
}


// The definition's name for each path placeholder, keyed by the model's. A
// renamed placeholder keeps its place in the path, so position pairs them.
function wireNames(pt: any): Record<string, string> {
  const out: Record<string, string> = {}
  const orig = String(pt?.o || '').split('/').filter((s) => '' !== s)
  const segs = pointSegments(pt)
  if (orig.length === segs.length) {
    segs.forEach((seg: any, i: number) => {
      const m = /^\{([^{}]+)\}$/.exec(orig[i])
      if (null != seg.var && null != m) out[String(seg.var)] = m[1]
    })
  }
  for (const [wire, name] of Object.entries(pt?.r?.param || {})) {
    if (null == out[String(name)]) out[String(name)] = wire
  }
  for (const p of pt?.g?.params || []) {
    if (null == out[p.n]) out[p.n] = String(p.or || p.n)
  }
  return out
}


const FORMAT_SAMPLE: Record<string, any> = {
  'date-time': '2026-01-01T00:00:00Z',
  date: '2026-01-01',
  email: 'user@example.com',
  uri: 'https://example.com',
  url: 'https://example.com',
  uuid: '00000000-0000-4000-8000-000000000000',
}


function fieldSample(field: any): any {
  switch (canonScalarKey(field?.t)) {
    case 'INTEGER':
    case 'NUMBER': return 1
    case 'BOOLEAN': return true
    case 'ARRAY': return []
    case 'OBJECT': return {}
    case 'NULL': return null
    default: return FORMAT_SAMPLE[String(field?.fo || '')] ?? 'example'
  }
}


function schemaSample(schema: any, depth: number): any {
  if (null == schema || 'object' !== typeof schema || 6 < depth) return undefined
  if (undefined !== schema.example) return schema.example
  if (Array.isArray(schema.examples) && 0 < schema.examples.length) return schema.examples[0]
  if (Array.isArray(schema.enum) && 0 < schema.enum.length) return schema.enum[0]
  if (undefined !== schema.default) return schema.default
  if (Array.isArray(schema.allOf)) {
    const parts = schema.allOf.map((s: any) => schemaSample(s, depth + 1))
    const maps = parts.filter((v: any) => null != v && 'object' === typeof v && !Array.isArray(v))
    return 0 < maps.length ? Object.assign({}, ...maps) : parts.find((v: any) => undefined !== v)
  }
  const union = schema.oneOf ?? schema.anyOf
  if (Array.isArray(union) && 0 < union.length) return schemaSample(union[0], depth + 1)
  const type = Array.isArray(schema.type) ?
    schema.type.find((t: string) => 'null' !== t) : schema.type
  if ('array' === type || null != schema.items) {
    const item = schemaSample(schema.items, depth + 1)
    return undefined === item ? [] : [item]
  }
  if ('object' === type || null != schema.properties) {
    const out: any = {}
    for (const [name, prop] of Object.entries(schema.properties || {}) as [string, any][]) {
      if (true === prop?.readOnly) continue
      const value = schemaSample(prop, depth + 1)
      if (undefined !== value) out[name] = value
    }
    return out
  }
  if ('integer' === type || 'number' === type) return 1
  if ('boolean' === type) return true
  if ('string' === type) return FORMAT_SAMPLE[String(schema.format || '')] ?? 'example'
  return undefined
}


// The JSON body the definition declares: undefined where the definition is
// not to hand, null where the operation declares none.
function definitionBody(resolved: any, pt: any): any {
  if (null == resolved || 'function' !== typeof resolved.operation) return undefined
  let facts: any
  try {
    facts = resolved.operation(pt.m, pt.o)
  }
  catch (err: any) {
    return undefined
  }
  if (null == facts || 'http' !== facts.protocol) return undefined
  const content = facts.requestBody?.content
  if (null == content || 'object' !== typeof content) return null
  const media = Object.keys(content).find((m) => /json/i.test(m))
  if (null == media) return null
  const sample = schemaSample(content[media]?.schema, 0)
  return undefined === sample ? null : sample
}


function unwrapOf(pt: any): string[] | null {
  const res = pt?.t?.res
  if (null == res) return []
  if ('string' !== typeof res) return null
  const m = /^`?(body(?:\.[A-Za-z0-9_$-]+)*)`?$/.exec(res.trim())
  return null == m ? null : m[1].split('.').slice(1)
}


function usesOf(texts: string[]): string[] {
  const out: string[] = []
  for (const text of texts) {
    for (const m of String(text).matchAll(VAR_RE)) {
      if (!out.includes(m[1])) out.push(m[1])
    }
  }
  return out
}


// The project's own wording over the definition's, slot by slot.
function textOf(model: any): any {
  const kit = model?.main?.[KIT] || {}
  const out: any = { ...(kit.info || {}), entity_desc: { ...(kit.info?.entity_desc || {}) } }
  for (const [slot, value] of Object.entries(kit.text || {})) {
    if (null == value || '' === value) continue
    if ('entity_desc' === slot) Object.assign(out.entity_desc, value)
    else out[slot] = value
  }
  return out
}


function authOf(model: any): any {
  if (!isAuthActive(model)) return null
  const where = resolveAuthIn(model)
  const name = resolveAuthName(model)
  const prefix = resolveAuthPrefix(model)
  const x = model?.main?.[KIT]?.info?.security?.exchange
  const exchange = null != x && 'object' === typeof x && null != x.path ? {
    method: String(x.method || 'POST').toUpperCase(),
    path: String(x.path),
    request: String(x.request || 'refresh_token'),
    response: String(x.response || 'access_token'),
  } : null
  const kind = 'header' === where && isHttpBasicAuth(model) ? 'basic' :
    'header' === where && 'authorization' === name.toLowerCase() &&
      'bearer' === String(prefix).toLowerCase() ? 'bearer' :
      'cookie' === where ? 'cookie' : 'apikey'
  return {
    kind, in: where, name, prefix, exchange,
    token: null != exchange ? 'access_token' : 'apikey',
  }
}


function serverOf(model: any, notes: Note[]): any {
  const url = String(model?.main?.[KIT]?.info?.servers?.[0]?.url || '').replace(/\/+$/, '')
  const variables = serverVariables(model)
  if ('' === url) {
    notes.push({ note: 'the definition declares no server: set `base` before sending anything' })
  }
  else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    notes.push({ note: 'the definition\'s server URL `' + url + '` is relative: set `base` to an absolute URL' })
  }
  return {
    url,
    base: url.replace(/\{([A-Za-z0-9_]+)\}/g, '{{$1}}'),
    variables: variables.map((v: any) => ({
      name: v.name, value: v.dflt, required: v.required, description: v.description,
    })),
  }
}


function sdkCall(ent: any, opname: string, action: string | undefined, args: Bound[]): string {
  const Name = String(ent.Name || cap(ent.name))
  if (null == action && CANON.includes(opname)) {
    return primaryOpCall('ts', Name, ent.name, opname, entityIdField(ent), ent).expr
  }
  const pairs = args.map((a) => JSON.stringify(a.name) + ': ' + JSON.stringify('own' === a.role ? 'ID' : a.name))
    .concat(null == action ? [] : ['$action: ' + JSON.stringify(action)])
  return 'client.' + Name + '().' + opname + '({ ' + pairs.join(', ') + ' })'
}


type Mode = {
  // The variable an own key part is held in.
  own: (part: Part) => string
  // The value a create sends for a key the client chooses.
  fresh: (part: Part, inPath: boolean) => string
}


function requestOf(env: any, ent: any, opname: string, pt: any, title: string, mode: Mode): any {
  const method = String(pt.m).toUpperCase()
  const action = null == pt.q?.['$action'] ? undefined : String(pt.q['$action'])
  const parts: Part[] = env.identity[ent.name]
  const wire = wireNames(pt)
  const byWire: Record<string, string> = {}
  for (const [name, w] of Object.entries(wire)) byWire[w] = name

  const bind = (name: string, ex?: any): Bound => {
    const part = parts.find((p) => p.name === name) ||
      (1 === parts.length && name === ent.name + '_id' ? parts[0] : undefined)
    if (null != part) return { name, role: 'own', variable: mode.own(part), part }

    const stem = name.replace(/_id$/, '')
    if (stem !== name && stem !== ent.name && env.names.includes(stem) &&
      1 === env.identity[stem].length) {
      return { name, role: 'ref', variable: env.identity[stem][0].variable, entity: stem }
    }
    for (const anc of env.ancestors[ent.name]) {
      const p = env.identity[anc].find((q: Part) => q.name === name)
      if (null != p) return { name, role: 'ref', variable: p.variable, entity: anc }
    }
    return { name, role: 'input', variable: name, example: scalarEx(ex) }
  }

  // Every argument whose value a variable gives, in the order the request names them.
  const params: Bound[] = []
  const use = (b: Bound) => {
    if (!params.some((x) => x.name === b.name)) params.push(b)
    return '{{' + b.variable + '}}'
  }
  const pathVars: Pair[] = []
  const exOf = (name: string) => (pt.g?.params || []).find((p: any) => p.n === name)?.ex
  const create = 'create' === opname && null == action

  const path = String(pt.o || '').split('/').map((seg: string) => {
    const whole = /^\{([A-Za-z0-9_-]+)\}$/.exec(seg)
    const place = (w: string) => {
      const name = byWire[w] || w
      return params.find((x) => x.name === name) ?? bind(name, exOf(name))
    }
    if (null != whole) {
      const b = place(whole[1])
      const value = use(b)
      if (!pathVars.some((v) => v.key === whole[1])) {
        pathVars.push({
          key: whole[1],
          value,
          description: 'own' === b.role ? 'The ' + ent.name + ' this request addresses.' :
            'ref' === b.role ? 'The ' + b.entity + ' this ' + ent.name + ' belongs to.' :
              'Input: ' + b.name + '.',
        })
      }
      return ':' + whole[1]
    }
    return seg.replace(/\{([^{}]+)\}/g, (_all: string, w: string) => use(place(w)))
  }).join('/')

  const selects: string[] = pt.q?.exist || []
  const query: Pair[] = []
  for (const q of pt.g?.query || []) {
    if (false === q?.a || null == q?.n) continue
    const b = bind(String(q.n), q.ex)
    const needed = false !== q.r || selects.includes(String(q.n))
    const literal = 'input' === b.role && undefined !== b.example
    const value = literal ? b.example : needed ? use(b) : ''
    query.push(needed ? { key: String(q.or || q.n), value } :
      { key: String(q.or || q.n), value, disabled: true })
  }

  const auth = env.auth
  const own = (h: string) => null != auth && auth.in === 'header' &&
    h.toLowerCase() === String(auth.name).toLowerCase()
  const headers: Pair[] = []
  for (const h of pt.g?.header || []) {
    if (false === h?.a || false === h?.r || null == h?.n) continue
    const w = String(h.or || h.n)
    if (own(w) || ['content-type', 'accept'].includes(w.toLowerCase())) continue
    const b = bind(String(h.n), h.ex)
    headers.push({ key: w, value: 'input' === b.role && undefined !== b.example ? b.example : use(b) })
  }

  const cookies: string[] = []
  for (const c of pt.g?.cookie || []) {
    if (false === c?.a || false === c?.r || null == c?.n) continue
    const w = String(c.or || c.n)
    if (null != auth && 'cookie' === auth.in && w === auth.name) continue
    const b = bind(String(c.n), c.ex)
    cookies.push(w + '=' + ('input' === b.role && undefined !== b.example ? b.example : use(b)))
  }
  if (null != auth && 'cookie' === auth.in) cookies.push(auth.name + '={{' + auth.token + '}}')
  if (0 < cookies.length) headers.push({ key: 'Cookie', value: cookies.join('; ') })

  let body: any
  let fresh = false
  if (BODY_METHODS.includes(method)) {
    if (null != pt.rb && 'json' !== pt.rb.kind) {
      env.notes.push({
        entity: ent.name, op: action ?? opname,
        note: 'declares a `' + pt.rb.media + '` body, which this collection leaves for you to add',
      })
    }
    else {
      const fromDef = definitionBody(env.resolved, pt)
      if (undefined !== fromDef) {
        body = fromDef
      }
      else {
        // An action's payload is its own, so where the model records none of
        // its names the action sends an empty object rather than the entity.
        const fields = Object.values(ent.fields || {}).filter((f: any) => false !== f?.a)
        const names: string[] = Array.isArray(pt.bf) ? pt.bf.map(String) :
          false === pt.bf || null != action ? [] : fields.map((f: any) => String(f.n))
        body = {}
        for (const name of names) {
          const field: any = (ent.fields || {})[name]
          if (true === field?.ro) continue
          body[name] = fieldSample(field)
        }
      }

      if (null != body && 'object' === typeof body && !Array.isArray(body)) {
        for (const name of Object.keys(body)) {
          const b = bind(name)
          if ('own' === b.role && null != b.part) {
            if (create) {
              if (false === (ent.fields || {})[name]?.r) {
                delete body[name]
                continue
              }
              body[name] = mode.fresh(b.part, params.some((x) => 'own' === x.role))
              fresh = true
            }
            else {
              body[name] = '{{' + b.variable + '}}'
            }
          }
          else if ('ref' === b.role && name.endsWith('_id')) {
            body[name] = '{{' + b.variable + '}}'
          }
        }
      }
    }
  }

  if (create && params.some((x) => 'own' === x.role)) fresh = true

  const unwrap = unwrapOf(pt)
  if (null == unwrap) {
    env.notes.push({
      entity: ent.name, op: action ?? opname,
      note: 'the response transform `' + JSON.stringify(pt.t?.res) +
        '` is not a plain path, so nothing reads a record from its response',
    })
  }

  const enabled = query.filter((q) => !q.disabled)
  const url = '{{base}}' + path +
    (0 < enabled.length ? '?' + enabled.map((q) => q.key + '=' + q.value).join('&') : '')

  return {
    key: ent.name + '/' + opname + '/' + (action ?? '') + '/' + method + ' ' + pt.o,
    entity: ent.name,
    op: opname,
    action,
    title,
    method,
    path: String(pt.o),
    url,
    pathVars,
    query,
    headers,
    body,
    fresh,
    params,
    unwrap,
    uses: usesOf([url, ...pathVars.map((v) => v.value), ...headers.map((h) => h.value),
      ...(undefined === body ? [] : [JSON.stringify(body)])]),
    sdk: sdkCall(ent, opname, action, params),
  }
}


function requiredNames(pt: any): string[] {
  return [...(pt?.g?.params || []), ...(pt?.g?.query || [])]
    .filter((p: any) => null != p?.n && false !== p.r).map((p: any) => String(p.n))
}


// The HTTP points of an operation in the order a reader meets them: the
// record's own route first, its alternatives after it.
function pointsOf(env: any, ent: any, opname: string): { canonical: any[], actions: any[] } {
  const op = ent?.op?.[opname]
  if (null == op || false === op.active) return { canonical: [], actions: [] }
  const points = (op.points || []).filter((pt: any) => null != pt && false !== pt.a)
  for (const pt of points.filter((pt: any) => 'graphql' === pt.k)) {
    env.notes.push({
      entity: ent.name, op: opname,
      note: 'a GraphQL route (`' + (pt.gq?.field || pt.o) + '`), which this collection does not hold',
    })
  }
  const http = points.filter((pt: any) => 'graphql' !== pt.k)
  const canonical = http.filter((pt: any) => null == pt.q?.['$action'])
  const primary = 0 < canonical.length ? ownPoint(canonical) : null
  return {
    canonical: null == primary ? [] : [primary, ...canonical.filter((pt: any) => pt !== primary)],
    actions: http.filter((pt: any) => null != pt.q?.['$action'])
      .sort((a: any, b: any) => String(a.q['$action']) < String(b.q['$action']) ? -1 : 1),
  }
}


function opTitle(ent: any, opname: string): string {
  return 'list' === opname ? 'List ' + plural(ent.name) : cap(opname) + ' ' + ent.name
}


function unique(titles: Set<string>, title: string): string {
  let out = title
  for (let n = 2; titles.has(out.toLowerCase()); n++) out = title + ' (' + n + ')'
  titles.add(out.toLowerCase())
  return out
}


function referenceRequests(env: any, ent: any): any[] {
  const mode: Mode = {
    own: (part) => part.variable,
    fresh: (part, inPath) => inPath ? '{{' + part.variable + '}}' : ent.name + '-{{$timestamp}}',
  }
  const titles = new Set<string>()
  const out: any[] = []
  const opnames = Object.keys(ent.op || {})
  const ordered = CANON.filter((o) => opnames.includes(o))
    .concat(opnames.filter((o) => !CANON.includes(o)).sort())
  const actions: any[] = []

  const canonical = (opname: string) => {
    const { canonical: points, actions: acts } = pointsOf(env, ent, opname)
    const base = requiredNames(points[0])
    points.forEach((pt: any, i: number) => {
      const extra = requiredNames(pt).filter((n) => !base.includes(n))
      const title = 0 === i ? opTitle(ent, opname) : opTitle(ent, opname) +
        (0 < extra.length ? ' (by ' + extra.join(' and ') + ')' : ' (' + (i + 1) + ')')
      out.push(requestOf(env, ent, opname, pt, unique(titles, title), mode))
    })
    acts.forEach((pt: any) => actions.push({ opname, pt }))
  }

  // Actions come before the removal, so a folder run in order addresses a
  // record that still exists.
  ordered.filter((o) => 'remove' !== o).forEach(canonical)
  for (const { opname, pt } of actions.splice(0).sort((a, b) =>
    String(a.pt.q['$action']) < String(b.pt.q['$action']) ? -1 : 1)) {
    const title = cap(String(pt.q['$action'])) + ' ' + ent.name
    out.push(requestOf(env, ent, opname, pt, unique(titles, title), mode))
  }
  if (ordered.includes('remove')) {
    canonical('remove')
    for (const { opname, pt } of actions) {
      const title = cap(String(pt.q['$action'])) + ' ' + ent.name
      out.push(requestOf(env, ent, opname, pt, unique(titles, title), mode))
    }
  }

  return out
}


function flowOf(env: any, flow: any, ent: any): any {
  const parts: Part[] = env.identity[ent.name]
  const steps = (Array.isArray(flow.step) ? flow.step : []).filter((s: any) => false !== s?.a)
  const primary = (op: string) => pointsOf({ ...env, notes: [] }, ent, op).canonical[0]

  const made = steps.some((s: any) => 'create' === s.o && null != primary('create'))
  const listed = steps.some((s: any) => 'list' === s.o && null != primary('list'))
  const ref = String((steps.find((s: any) => null != s?.i?.ref) || { i: {} }).i.ref || ent.name + '_ref01')
  const held = (part: Part) => !made && !listed ? part.variable :
    1 === parts.length ? ref : ref + '_' + part.name

  const mode: Mode = {
    own: held,
    fresh: (part) => '{{' + held(part) + '}}',
  }

  const records = Object.values(env.identity).flat().map((p: any) => p.variable)
  const out: any[] = []
  steps.forEach((step: any, index: number) => {
    const pt = primary(step.o)
    if (null == pt) {
      const acts = pointsOf({ ...env, notes: [] }, ent, step.o).actions
        .map((a: any) => '`' + a.q['$action'] + '`')
      env.notes.push({
        entity: ent.name, flow: flow.name, op: step.o,
        note: 'step left out: ' + (0 < acts.length ?
          'its only routes are the ' + acts.join(', ') + ' actions, which a flow does not run' :
          'the entity has no `' + step.o + '` route'),
      })
      return
    }

    const req = requestOf({ ...env, notes: [] }, ent, step.o, pt, '', mode)
    const mark = ((step.s || []).find((s: any) => 'TextFieldMark' === s?.apply) || {}).def?.mark
    const textfield = step.i?.textfield
    if (null != mark && null != textfield && null != req.body && 'object' === typeof req.body &&
      ('update' === step.o || 'patch' === step.o)) {
      req.body[textfield] = mark
    }

    const minted = 'create' === step.o && req.fresh ? parts.map(held) : []
    const server = req.uses.includes('base') ? env.server.variables
      .filter((v: any) => v.required).map((v: any) => String(v.name)) : []
    out.push({
      ...req,
      key: flow.name + '/' + index + '/' + step.o,
      title: (out.length + 1) + '. ' + opTitle(ent, step.o),
      ref,
      parts: parts.map((p) => ({ ...p, held: held(p) })),
      made,
      minted,
      mark: null != mark && ('update' === step.o || 'patch' === step.o) ? mark : undefined,
      adopts: 'list' === step.o && (made || listed) &&
        !steps.slice(0, index).some((s: any) => 'remove' === s.o),
      checks: (step.v || []).filter((v: any) => null != v?.apply)
        .map((v: any) => ({ apply: String(v.apply), ...(v.def || {}) })),
      needs: [...server, ...req.uses.filter((name: string) => !minted.includes(name) && !server.includes(name))],
      // Records of an entity the run must name, because this flow neither
      // creates nor lists them.
      records: req.uses.filter((name: string) => records.includes(name) &&
        !parts.some((p) => held(p) === name && held(p) !== p.variable)),
    })
  })

  if (made && !steps.some((s: any) => 'remove' === s.o && null != primary('remove'))) {
    env.notes.push({
      entity: ent.name, flow: flow.name,
      note: 'the flow creates a record it has no route to remove',
    })
  }

  return { name: String(flow.name), entity: ent.name, ref, steps: out }
}


function catalogue(model: any, resolved?: any): any {
  const notes: Note[] = []
  const kit = model?.main?.[KIT] || {}
  const text = textOf(model)
  const coll = entityCollection(model)
  const names = Object.keys(coll).filter((n) => null != coll[n] && false !== coll[n].active).sort()

  const env: any = {
    names, notes, resolved,
    auth: authOf(model),
    identity: {} as Record<string, Part[]>,
    ancestors: {} as Record<string, string[]>,
  }
  for (const name of names) {
    env.identity[name] = identity(coll[name])
    env.ancestors[name] = ancestorsOf(coll[name], names)
  }

  const ordered: string[] = []
  const visit = (name: string, path: string[]) => {
    if (ordered.includes(name) || path.includes(name)) return
    env.ancestors[name].forEach((a: string) => visit(a, [...path, name]))
    ordered.push(name)
  }
  names.forEach((name) => visit(name, []))

  const server = serverOf(model, notes)
  env.server = server

  const entities = ordered.map((name) => {
    const ent = coll[name]
    return {
      name,
      title: cap(name),
      parts: env.identity[name],
      ancestors: env.ancestors[name],
      description: String(text?.entity_desc?.[name] || ''),
      fields: Object.values(ent.fields || {}).filter((f: any) => false !== f?.a).map((f: any) => ({
        name: String(f.n),
        type: String(canonScalarKey(f.t) || 'any').toLowerCase(),
        required: false !== f.r,
        readonly: true === f.ro,
        short: String(f.sh || ''),
      })),
      requests: referenceRequests(env, ent),
    }
  }).filter((e: any) => 0 < e.requests.length)

  const flows = Object.values(kit.flow || {})
    .filter((flow: any) => null != flow && false !== flow.active && names.includes(String(flow.entity)))
    .sort((a: any, b: any) => ordered.indexOf(String(a.entity)) - ordered.indexOf(String(b.entity)) ||
      (String(a.name) < String(b.name) ? -1 : 1))
    .map((flow: any) => flowOf(env, flow, coll[String(flow.entity)]))
    .filter((flow: any) => 0 < flow.steps.length)

  const seen = new Set<string>()
  const distinct = notes.filter((n) => {
    const k = JSON.stringify([n.entity, n.flow, n.op, n.note])
    return seen.has(k) ? false : (seen.add(k), true)
  })

  return {
    name: String(model.name),
    title: String(text?.title || model?.const?.Name || cap(String(model.name))),
    version: String(text?.version || ''),
    description: String(text?.description || text?.summary || ''),
    server,
    auth: env.auth,
    entities,
    flows,
    notes: distinct,
  }
}


export {
  catalogue,
  recordKey,
  wireNames,
}
