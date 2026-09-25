import {
  cmp, each,
  File, Content, Folder,
  jsKey, jsProp,
  pointSegments,
} from '@voxgig/sdkgen'




const SDK_SRC_DIR = '.sdksrc'


const SdkPin = cmp(function SdkPin(props: any) {
  const { provider } = props

  // Nothing to pin without a repository to fetch from. Emitting a pin with an
  // empty `repo` would be a file that looks like a promise and cannot be
  // kept.
  if (!provider.sdkPinned) {
    return
  }

  File({ name: 'sdk-pin.json' }, () => {
    Content(JSON.stringify({
      note: provider.standalone ?
        'GENERATED. The SDK this provider depends on and is generated from. ' +
        '`make sdk-src` fetches it; `make regen` replaces the API definition ' +
        'and guide in .sdk/ with its own and regenerates this repo. Set the version in ' +
        '.sdk/model/project.aontu, not in this file.' :
        'GENERATED. The SDK this provider is generated from. ' +
        '`make sdk-src` fetches it; `make regen` regenerates this repo ' +
        'from it. Edit the SDK project model, not this file.',
      repo: provider.sdkRepoUrl,
      tag: provider.sdkTag,
      dir: provider.sdkSrc,
      package: provider.sdkPkg,
      version: provider.sdkVersion,
    }, null, 2) + '\n')
  })
})


// Does this entity's load op have a real identifying param (path or
// required query), e.g. GET /result?trace_id=? A paramless GET has none.
function loadHasKey(e: any): boolean {
  return true === (e.idaddressed || {}).load
}


function removeAddresses(e: any): boolean {
  return true === (e.idaddressed || {}).remove
}


function addressNames(e: any, cmd: string): string[] {
  const keys = (e.opParents || {})[cmd] || []
  return 0 < keys.length ? keys : ['nothing more specific']
}


function cmdRefuses(e: any, cmd: string): boolean {
  return true === (e.idmisaddressed || {})[cmd]
}


function parentName(e: any, key: string): string {
  const byKey = (e.parentOf || {})[key]
  if (null != byKey && '' !== byKey) {
    return String(byKey)
  }

  const f = (e.fields || []).find((f: any) => f.name === key)
  return (f && f.parentEntity) || ''
}


// The seeded id of the record a parent path param points at.
function parentSeed(e: any, key: string): string {
  const pe = parentName(e, key)

  // A key naming no entity in the model still has to seed SOMETHING the
  // guard accepts; strip the `_id` suffix and use that.
  return '' !== pe ? `${pe}0` : `${key.replace(/_id$/, '')}0`
}


// A parameter name as a local variable: an API definition can hyphenate.
function paramVar(p: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(p) ? p :
    'p_' + p.replace(/[^A-Za-z0-9_$]/g, '_')
}


function regexLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&')
}


// `key: value` for one parent, from the live variable or the seed.
function parentPair(e: any, p: string, live: boolean): string {
  if (!live) {
    return `${jsKey(p)}: '${parentSeed(e, p)}', `
  }
  const v = paramVar(p)
  return v === p ? `${p}, ` : `${jsKey(p)}: ${v}, `
}


function parentPairs(e: any, live: boolean): string {
  return e.parents.map((p: string) => parentPair(e, p, live)).join('')
}


// A field the record owns: not Seneca's id, not a parent path param. The API's
// key is the record's own only when a create has to supply it — an
// API-assigned id is not the caller's to send, and a required key is.
function ownField(e: any, f: any): boolean {
  if (f.name === e.rk) {
    return true === e.rkoncreate
  }
  return 'id' !== f.name && !e.parents.includes(f.name)
}


// A field an UPDATE may change. Never the key: rewriting that addresses, or
// renames, a different record than the one loaded.
function changeField(e: any, f: any): boolean {
  return f.name !== e.rk && ownField(e, f)
}


// Where a configured `apikey` goes on the wire, from the model's security
// declaration. Empty for an API that declares no authentication.
function credentialWire(provider: any): string {
  if (!provider.authActive) {
    return ''
  }
  if (provider.authBasic) {
    return `\`${provider.authName}: Basic <base64 of apikey:secret>\``
  }
  const prefix = '' === provider.authPrefix ? '' : provider.authPrefix + ' '
  if ('header' === provider.authIn) {
    return `\`${provider.authName}: ${prefix}<apikey>\``
  }
  if ('query' === provider.authIn) {
    return `the \`${provider.authName}\` query parameter`
  }
  return `the \`${provider.authName}\` ${provider.authIn}`
}


// A COMPOSITE-KEY ENTITY CARRIES ITS PARENTS INSIDE ITS ID, so a query must
// NOT also pass them as separate keys — `load$({ owner, id })` is the shape
// the handler now rejects, because the id it splits already holds the owner.
// These three keep every emitted test, script and doc addressing such an
// entity the one way that works.
function idPartsOf(e: any): string[] {
  return Array.isArray(e.idparts) && 1 < e.idparts.length ?
    e.idparts.map((p: any) => String(p)) : []
}


// The Seneca id for one seeded record: the record key for an ordinary
// entity, and the seeded parts joined for a composite one — `owner0/repo0`
// where the parts are `owner` (a parent, so its seeded parent id) and `repo`
// (the record's own key).
function entIdLiteral(e: any, suffix: string): string {
  const parts = idPartsOf(e)
  if (0 === parts.length) {
    return `${e.name}${suffix}`
  }

  const sep = null != e.idsep && '' !== String(e.idsep) ? String(e.idsep) : '/'
  const vals = parts.map((p: string) =>
    e.parents.includes(p) ? parentSeed(e, p) : `${e.name}${suffix}`)

  if ('' !== suffix && !vals.some((v: string) => v.endsWith(suffix))) {
    vals[vals.length - 1] = vals[vals.length - 1] + suffix
  }

  return vals.join(sep)
}


// Object-literal pairs putting each composite part at its `from` path, as a
// create must send them. `owner.login` becomes `owner: { login: '...' }`;
// several parts sharing a prefix are merged into one object.
function idFromPairs(e: any, suffix: string): string {
  const parts = idPartsOf(e)
  const from = e.idfrom || {}
  const tree: any = {}

  for (const part of parts) {
    const value = e.parents.includes(part) ?
      parentSeed(e, part) : `${e.name}${suffix}`
    const keys = String(from[part] || part).split('.')
    let node = tree
    for (let i = 0; i < keys.length - 1; i++) {
      node[keys[i]] = node[keys[i]] || {}
      node = node[keys[i]]
    }
    node[keys[keys.length - 1]] = value
  }

  const render = (node: any): string => '{ ' + Object.keys(node)
    .map((k: string) => `${jsKey(k)}: ${'object' === typeof node[k] ?
      render(node[k]) : `'${node[k]}'`}`)
    .join(', ') + ' }'

  return Object.keys(tree)
    .map((k: string) => `${jsKey(k)}: ${'object' === typeof tree[k] ?
      render(tree[k]) : `'${tree[k]}'`}`)
    .join(', ')
}


// Parent pairs for a query, or nothing when the id already carries them.
function queryPairs(e: any, live: boolean): string {
  const parts = idPartsOf(e)
  if (0 === parts.length) {
    return parentPairs(e, live)
  }

  const rest = e.parents.filter((p: string) => !parts.includes(p))

  return rest.map((p: string) => parentPair(e, p, live)).join('')
}


function compositeRoundTrip(e: any): boolean {
  const parts = idPartsOf(e)
  if (0 === parts.length) {
    return true
  }

  const from = e.idfrom || {}
  return parts.every((p: string) => {
    const path = from[p]
    return null != path && '' !== String(path) && !String(path).includes('.')
  })
}


// The entity a parent path param addresses, or null when the model has none of
// that name.
function parentEntityFor(provider: any, e: any, key: string): any {
  const name = parentName(e, key)

  return '' === name ? null :
    provider.entities.find((pe: any) => pe.name === name) || null
}


// Can a LIVE round-trip get hold of this entity's parent ids at all? Every
// parent key must name an entity in the model, and that entity must be
// listable — otherwise there is no honest way to obtain an id the server will
// accept, and the test is not emitted rather than emitted and skipped.
function liveParentsResolvable(provider: any, e: any): boolean {
  return e.parents.every((p: string) => {
    const pe = parentEntityFor(provider, e, p)
    return null != pe && pe.cmds.includes('list')
  })
}


function entVar(name: string, suffix = ''): string {
  return /^[0-9]/.test(name) ? `e_${name}${suffix}` : `${name}${suffix}`
}


// The lines that fetch a live parent id per parent key, plus the guard that
// skips when the server has no parent record to attach to. Empty for a
// top-level entity.
function liveParentSetup(provider: any, e: any, ind: string): string {
  if (0 === e.parents.length) {
    return ''
  }

  return e.parents.map((p: string) => {
    const pe = parentEntityFor(provider, e, p)
    const pv = entVar(pe.name, 'Records')

    return `${ind}  // ${e.name} records hang off ${pe.name} records, so the ${p} has to
${ind}  // come FROM THE SERVER. This database is not ours to seed.
${ind}  const ${pv} = await seneca
${ind}    .entity('provider/${provider.lower}/${pe.name}')
${ind}    .list\$()

${ind}  if (0 === ${pv}.length) return t.skip('no ${pe.name} to attach a ${e.name} to')

${ind}  const ${paramVar(p)} = ${pv}[0].id

`
  }).join('')
}


// A field a round-trip test can CHANGE and then assert on: the first string
// field that is neither the id nor a parent path param. Without one there is
// nothing an update could alter that an assertion could see, so the update leg
// is dropped rather than asserted vacuously.
function mutableField(e: any): string {
  const f = (e.fields || []).find((f: any) =>
    changeField(e, f) && 'string' === f.kind)

  return f ? f.name : ''
}


function crudTest(provider: any, e: any, mode: 'offline' | 'live'): string {
  const live = 'live' === mode
  const pairs = parentPairs(e, live)
  // A composite id already holds the parent keys; passing them again as
  // separate query fields is the shape the handler now rejects.
  const qpairs = queryPairs(e, live)
  // Seneca's key, not the API's: this test drives seneca.entity(...), whose
  // query and entity always spell the id `id`. The provider translates to
  // whatever the API calls it.
  const idf = 'id'
  // The update leg needs a route that updates one record; without one a
  // save on a loaded entity would create again.
  const mut = e.canonicalOps.includes('update') && !cmdRefuses(e, 'update') ?
    mutableField(e) : ''

  const ind = live ? '    ' : '  '
  const mk = live ? 'makeSeneca(liveOpts())' : 'makeSeneca()'
  const setup = live ? liveParentSetup(provider, e, ind) : ''

  const made = 0 < e.fields.filter((f: any) => ownField(e, f)).length ?
    seedLiteral(e, 'crud') : ''

  const idmake = 0 === idPartsOf(e).length ? '' :
    ', ' + idFromPairs(e, '-crud')

  const hasLoad = e.cmds.includes('load')

  const body = hasLoad ? `${ind}  try {
${ind}    const loaded = await ent.load\$({ ${qpairs}${idf}: id })
${ind}    assert.equal(loaded.${idf}, id)
${
    '' === mut ? '' :
      `
${ind}    // An entity CARRYING an id is an update, not a second create.
${ind}    loaded.${mut} = 'crud-${mut}-2'
${ind}    const updated = await loaded.save\$()

${ind}    assert.equal(updated.${idf}, id)
${ind}    assert.equal(updated.${mut}, 'crud-${mut}-2')

${ind}    const reloaded = await ent.load\$({ ${qpairs}${idf}: id })
${ind}    assert.equal(reloaded.${mut}, 'crud-${mut}-2')
`}${ind}  }
${ind}  finally {
${ind}    // Always clean up. The mock and the server both hold data for the
${ind}    // process lifetime, so a leaked record changes what later tests see.
${ind}    await ent.remove\$({ ${qpairs}${idf}: id })
${ind}  }

${ind}  // remove is real: the record is gone, and reading it is an ordinary
${ind}  // not-found rather than an error.
${ind}  assert.equal(await ent.load\$({ ${pairs}${idf}: id }), null)
` : `${ind}  // This ${e.name} has no load cmd: the API offers no route that reads
${ind}  // one back, so the record cannot be re-read here and the remove cannot
${ind}  // be confirmed by a follow-up read. The write path is still exercised.
${ind}  try {
${
    '' === mut ? '' :
      `${ind}    // An entity CARRYING an id is an update, not a second create.
${ind}    made.${mut} = 'crud-${mut}-2'
${ind}    const updated = await made.save\$()

${ind}    assert.equal(updated.${idf}, id)
${ind}    assert.equal(updated.${mut}, 'crud-${mut}-2')
`}${ind}  }
${ind}  finally {
${ind}    await ent.remove\$({ ${qpairs}${idf}: id })
${ind}  }
`

  return `${ind}it('${e.name}-crud', async (${live ? 't' : ''}) => {
${live ? `${ind}  if (!live) return t.skip(noServer())\n` : ''}${ind}  const seneca = await ${mk}
${ind}  const ent = seneca.entity('provider/${provider.lower}/${e.name}')

${setup}${ind}  // Seneca's convention: an entity WITHOUT an id is a create.${true === e.rkoncreate ?
    ` This API
${ind}  // keys ${e.name} records by \`${e.rk}\` and the create request requires it, so
${ind}  // it is sent and comes back as the record's id.` : ` The API
${ind}  // assigns the id itself, so the saved record comes back with one it chose.`}
${ind}  const made = await ent.make$({ ${pairs}${made}${idmake} }).save$()

${ind}  assert.ok(null != made.${idf})
${ind}  assert.equal(
${ind}    made.canon\$({ string: true }),
${ind}    'provider/${provider.lower}/${e.name}',
${ind}  )

${ind}  const id = made.${idf}

${body}${ind}})

`
}


function fieldLiteral(f: any, tag: string): string {
  switch (f.kind) {
    case 'number': return '12345'
    case 'boolean': return 'true'
    case 'array': return '[]'
    case 'object': return '{}'
    default: return `'${tag}-${f.name}'`
  }
}


// `name: 'value'` pairs for an entity's own (non-id, non-parent) required
// fields, tagged with `tag` so a test record is recognisable in a store it
// shares with the seed.
function seedLiteral(e: any, tag: string): string {
  return (e.fields || [])
    .filter((f: any) => ownField(e, f))
    .map((f: any) => `${jsKey(f.name)}: ${fieldLiteral(f, tag)}`)
    .join(', ')
}


// A plausible seed record for an entity: its required fields, given values
// that read as data rather than as `string`.
function seedRecord(e: any, idx: number): Record<string, any> {
  const out: Record<string, any> = {}

  // The field the API's routes address this record by. `e.idf` is null
  // whenever the load match has no `id` at all, which is exactly the case
  // this seed was getting wrong, so prefer the route-derived key.
  const rkey = e.rk || e.idf || 'id'

  for (const f of e.fields) {
    if (f.name === rkey) {
      out[f.name] = `${e.name}${idx}`
    }
    else if ('id' === f.name) {
      out[f.name] = `${e.name}-apiid-${idx}`
    }
    else if (e.parents.includes(f.name)) {
      out[f.name] = parentSeed(e, f.name)
    }
    else if ('number' === f.kind) {
      out[f.name] = 100 * (idx + 1)
    }
    else if ('boolean' === f.kind) {
      out[f.name] = false
    }
    else if ('array' === f.kind) {
      out[f.name] = []
    }
    else if ('object' === f.kind) {
      out[f.name] = {}
    }
    else {
      out[f.name] = `${f.name}${idx}`
    }
  }

  if ('' !== String(rkey) && null == out[rkey] &&
    0 === (Array.isArray(e.idparts) ? e.idparts.length : 0)) {
    out[rkey] = e.parents.includes(rkey) ?
      parentSeed(e, rkey) : `${e.name}${idx}`
  }

  seedIdParts(e, out, idx)

  return out
}




// Write each composite part's seeded value into the record at the path the
// model says carries it, creating the intermediate objects a dotted path
// implies. A part that is a PARENT key takes the parent's seeded id, so a
// nested composite record still lines up with its parent.
function seedIdParts(e: any, out: Record<string, any>, idx: number): void {
  const parts: string[] = Array.isArray(e.idparts) && 1 < e.idparts.length ?
    e.idparts.map((p: any) => String(p)) : []
  if (0 === parts.length) {
    return
  }

  const from = e.idfrom || {}

  for (const part of parts) {
    const path = String(from[part] || part)
    const value = e.parents.includes(part) ?
      parentSeed(e, part) : `${e.name}${idx}`

    const keys = path.split('.')
    let node: any = out
    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i]
      if (null == node[k] || 'object' !== typeof node[k] || Array.isArray(node[k])) {
        node[k] = {}
      }
      node = node[k]
    }
    node[keys[keys.length - 1]] = value
  }
}


const Tests = cmp(function Tests(props: any) {
  const { provider } = props

  // The entity the suite exercises hardest: prefer one with no parent keys
  // (nothing to arrange) and the most cmds.
  const subject = [...provider.entities]
    .sort((a: any, b: any) =>
      (a.parents.length - b.parents.length) || (b.cmds.length - a.cmds.length))[0]

  const nested = provider.entities.filter((e: any) => 0 < e.parents.length)

  Folder({ name: 'test' }, () => {

    // The seed the offline mock transport is loaded with. Generated from the
    // model so it matches the shape the SDK will actually return.
    File({ name: 'seed.js' }, () => {
      Content(`/* Generated by @voxgig/sdkgen. Do not edit. */
'use strict'

// Seed data for the SDK's offline mock transport, so the entity tests
// exercise real code paths without a server.
const SEED = {
  entity: {
`)
      each(provider.entities, (e: any) => {
        Content(`    ${jsKey(e.name)}: {
`)
        each([0, 1], (i: any) => {
          const idx = Number(i.val$ ?? i)
          const rec = seedRecord(e, idx)
          Content(`      ${jsKey(e.name + idx)}: ${JSON.stringify(rec)},
`)
        })
        Content(`    },
`)
      })
      Content(`  },
}

module.exports = { SEED }
`)
    })


    File({ name: 'basic.messages.ts' }, () => {
      Content(`/* Generated by @voxgig/sdkgen. Do not edit. */

const Pkg = require('../package.json')

const messages = {
  print: false,
  pattern: 'sys:provider,provider:${provider.lower}',
  allow: { missing: true },

  calls: [
    {
      pattern: 'get:info',
      out: {
        ok: true,
        name: '${provider.lower}',
        version: Pkg.version,
      },
    },
  ],
}

export default messages

if ('undefined' !== typeof module) {
  module.exports = messages
}
`)
    })


    File({ name: `${provider.fileBase}.test.js` }, () => {
      Content(`/* Generated by @voxgig/sdkgen. Do not edit. */
'use strict'

const { describe, it, before } = require('node:test')
const assert = require('node:assert')

const Seneca = require('seneca')

const ${provider.pluginName} = require('../dist/${provider.fileBase}')
const ${provider.pluginName}Doc = require('../dist/${provider.pluginName}-doc')

const SenecaMsgTest = require('seneca-msg-test')
const { Maintain } = require('@seneca/maintain')

const { SEED } = require('./seed')

const BasicMessages = require('../dist-test/basic.messages')
${'' === provider.liveBase ? '' : `
// The live tests run against the companion test server in the SDK repo
// (\`app/\`), which serves this by default. Start it with:
//   cd ${provider.sdkSrc}/app && npm start
const LIVE_BASE = process.env.${provider.ENV}_TEST_BASE || '${provider.liveBase}'
`}

describe('${provider.fileBase}', () => {

  it('happy', async () => {
    assert.notEqual(${provider.pluginName}, undefined)
    assert.notEqual(${provider.pluginName}Doc, undefined)

    const seneca = await makeSeneca()

    assert.partialDeepStrictEqual(
      await seneca.post('sys:provider,provider:${provider.lower},get:info'),
      {
        ok: true,
        name: '${provider.lower}',
      },
    )
  })


  it('messages', async () => {
    const seneca = await makeSeneca()
    await SenecaMsgTest(seneca, BasicMessages)()
  })


  it('sdk-export', async () => {
    const seneca = await makeSeneca()
    const sdk = seneca.export('${provider.pluginName}/sdk')()

`)
      each(provider.entities, (e: any) => {
        Content(`    assert.equal(typeof sdk.${e.acc}, 'function')
`)
      })
      Content(`  })

`)

      const flat = provider.entities.filter((e: any) => 0 === e.parents.length)

      each(flat, (e: any) => {
        if (e.cmds.includes('list')) {
          Content(`
  it('${e.name}-list', async () => {
    const seneca = await makeSeneca()
    const list = await seneca.entity('provider/${provider.lower}/${e.name}').list$()

    assert.equal(list.length, 2)

    // Entities must come back as Seneca entities under this plugin's canon.
    // The SDK tags its own results with its entity marker, which must not
    // survive into the Seneca entity.
    assert.equal(
      list[0].canon$({ string: true }),
      'provider/${provider.lower}/${e.name}',
    )
  })

`)
        }

        if (e.cmds.includes('load')) {
          Content(`
  it('${e.name}-load', async () => {
    const seneca = await makeSeneca()
    const found = await seneca
      .entity('provider/${provider.lower}/${e.name}')
      .load$('${entIdLiteral(e, '0')}')

    assert.equal(found.id, '${entIdLiteral(e, '0')}')
    assert.equal(
      found.canon$({ string: true }),
      'provider/${provider.lower}/${e.name}',
    )
  })

`)
          // Paramless read (e.g. GET /usage): every id "misses" the same
          // way a hit does -- the mock has nothing to filter by -- so a
          // load-missing test would just assert the happy path again.
          if (loadHasKey(e)) {
            Content(`
  // A 404 from a single-item read is an ordinary "not found" answer, not a
  // failure: the provider turns it into null rather than letting the SDK
  // throw.
  it('${e.name}-load-missing', async () => {
    const seneca = await makeSeneca()
    const missing = await seneca
      .entity('provider/${provider.lower}/${e.name}')
      .load$('${entIdLiteral(e, '-nosuch')}')

    assert.equal(missing, null)
  })

`)
          }
        }
      })

      // A nested entity cannot build its path without the parent id. That is
      // the mistake this target exists to make impossible, so pin it.
      each(nested, (e: any) => {
        if (0 < idPartsOf(e).length) {
          const sep = null != e.idsep && '' !== String(e.idsep) ? String(e.idsep) : '/'
          const shape = idPartsOf(e).join(sep)
          // The separator is a SLASH, and this goes inside a regex literal:
          // unescaped it closes the literal early and the emitted test is a
          // syntax error ("Invalid regular expression flags"). Escape every
          // regex metacharacter, not just the slash, so a future separator
          // cannot reintroduce this.
          const shapeRe = regexLiteral(shape)
          const cmd = ['load', 'remove', 'update'].find((op: string) =>
            e.cmds.includes('remove' === op ? 'remove' : 'load' === op ? 'load' : 'save'))

          if (null != cmd) {
            const rest = queryPairs(e, false)
            const call = 'remove' === cmd ?
              `remove$({ ${rest}id: 'incomplete' })` :
              `load$({ ${rest}id: 'incomplete' })`

            Content(`
  // This ${e.name} is addressed by \`${shape}\`, so an id that is not all
  // of those parts cannot build a request. It is refused here rather than
  // sent as a URL that would address the wrong record.
  it('${e.name}-needs-full-id', async () => {
    const seneca = await makeSeneca()

    await assert.rejects(
      () => seneca.entity('provider/${provider.lower}/${e.name}').${call},
      /id must be '${shapeRe}'/,
    )
  })

`)
          }
        }

        const key = e.parents[0]
        const pairs = e.parents
          .map((k: string) => `${jsKey(k)}: '${parentSeed(e, k)}'`).join(', ')

        const guardOp = ['list', 'load', 'update', 'remove']
          .find((op: string) => (e.opParents[op] || []).includes(key) &&
            !cmdRefuses(e, op))

        // Not for a composite key: there is no separate parent guard to
        // trip, because the parents live inside the id. needs-full-id above
        // is what pins the same property for those entities.
        if (null != guardOp && 0 === idPartsOf(e).length) {
          const call =
            'list' === guardOp ? `${guardOp}$({})` :
              'update' === guardOp ?
                `make$({ id: '${entIdLiteral(e, '0')}' }).save$()` :
                `${guardOp}$({ id: '${entIdLiteral(e, '0')}' })`

          Content(`
  it('${e.name}-needs-${key}', async () => {
    const seneca = await makeSeneca()

    await assert.rejects(
      () => seneca.entity('provider/${provider.lower}/${e.name}').${call},
      /${regexLiteral(key)} is required/,
    )
  })

`)
        }
        if (e.cmds.includes('list')) {
          Content(`
  it('${e.name}-list', async () => {
    const seneca = await makeSeneca()
    const list = await seneca
      .entity('provider/${provider.lower}/${e.name}')
      .list$({ ${pairs} })

    assert.equal(list.length, 2)
    assert.equal(
      list[0].canon$({ string: true }),
      'provider/${provider.lower}/${e.name}',
    )
    ${0 < idPartsOf(e).length ?
      `assert.equal(list[0].id, '${entIdLiteral(e, '0')}')` :
      `assert.equal(${jsProp('list[0]', key)}, '${parentSeed(e, key)}')`}
  })

`)
        }

        // Reading ONE nested record is the path that has to thread both the
        // parent id and the entity id through to the SDK, so cover it
        // separately from list.
        if (e.cmds.includes('load')) {
          Content(`
  it('${e.name}-load', async () => {
    const seneca = await makeSeneca()
    const found = await seneca
      .entity('provider/${provider.lower}/${e.name}')
      .load$({ ${queryPairs(e, false)}id: '${entIdLiteral(e, '0')}' })

    assert.equal(found.id, '${entIdLiteral(e, '0')}')
    assert.equal(
      found.canon$({ string: true }),
      'provider/${provider.lower}/${e.name}',
    )
  })
${!loadHasKey(e) ? '' : `

  it('${e.name}-load-missing', async () => {
    const seneca = await makeSeneca()
    const missing = await seneca
      .entity('provider/${provider.lower}/${e.name}')
      .load$({ ${queryPairs(e, false)}id: '${entIdLiteral(e, '-nosuch')}' })

    assert.equal(missing, null)
  })`}

`)
        }
      })

      // The WRITE path, offline. Reads were covered and writes were not, so
      // every generated `cmd.save` and `cmd.remove` action shipped without its
      // own suite ever running it — including the parent-key guard on a nested
      // save, which is the one this target exists to get right. The mock
      // transport implements create/update/remove, so this needs no server.
      each(provider.entities, (e: any) => {
        if (e.cmds.includes('save') && e.cmds.includes('remove')) {
          if (!e.canonicalOps.includes('create')) {
            Content(`
  // NO ${e.name} create/update/remove round-trip: THIS API HAS NO CREATE
  // ROUTE FOR A ${e.name}, so there is no record of this test's own to
  // update and remove. The update and remove cmds are still exercised
  // through the guard and refusal tests above.

`)
          }
          else if (compositeRoundTrip(e) && removeAddresses(e) &&
            !cmdRefuses(e, 'update')) {
            Content(`
` + crudTest(provider, e, 'offline'))
          }
          else if (removeAddresses(e) && cmdRefuses(e, 'update')) {
            Content(`
  // NO ${e.name} create/update/remove round-trip: THIS API HAS NO UPDATE
  // ROUTE FOR ONE ${e.name}. Its update route addresses
  // \`${addressNames(e, 'update').join('\`, \`')}\`, not
  // \`${0 < idPartsOf(e).length ?
              idPartsOf(e).join(String(e.idsep || '/')) : e.rk}\`, so the update leg of a round-trip
  // would change a different record. The cmd refuses instead — see
  // ${e.name}-update-refused. Create and remove are unaffected.

`)
          }
          else if (!removeAddresses(e)) {
            // Said in the file rather than silently omitted: a missing test
            // that nobody can see is how a gap becomes permanent. And the
            // refusal itself IS tested, below.
            Content(`
  // NO ${e.name} create/update/remove round-trip: THIS API HAS NO REMOVE
  // ROUTE FOR ONE ${e.name}.
  //
  // The key is \`${0 < idPartsOf(e).length ?
              idPartsOf(e).join(String(e.idsep || '/')) : e.rk}\`, which the remove route does not
  // take — it addresses ${0 === e.parents.length ? 'nothing more specific' :
                '\`' + e.parents.join('\`, \`') + '\` and no further'}. So there is
  // no record for this test to remove, and the cmd refuses rather than
  // deleting whatever that route names: see ${e.name}-remove-refused.
  //
  // This befalls an entity whose ops address DIFFERENT resources, which a
  // tag-derived entity can. Reads and lists are unaffected.

`)
          }
          else {
            Content(`
  // NO ${e.name} create/update/remove round-trip. This API addresses a
  // ${e.name} by \`${idPartsOf(e).join(String(e.idsep || '/'))}\`, and at least
  // one of those parts is carried NESTED in a response
  // (${Object.keys(e.idfrom || {}).filter((k: string) =>
              String((e.idfrom || {})[k]).includes('.'))
              .map((k: string) => k + ' at ' + (e.idfrom || {})[k]).join(', ')}).
  //
  // Reads, lists and removes work: they address a record and never rewrite
  // it. A create or update cannot, offline — the SDK takes path parameters
  // from the same object as the request body, so the flat value the URL
  // needs displaces the nested one the response shape requires, and this
  // transport echoes a create and merges an update. Against the real API,
  // where the two are separate, the cycle is fine.

`)
          }
        }
      })


      each(provider.entities, (e: any) => {
        for (const cmd of ['remove', 'update']) {
          if (true !== (e.idmisaddressed || {})[cmd]) {
            continue
          }

          // `update` is reached through save$ on an entity CARRYING an id —
          // that is what makes it an update rather than a create.
          const call = 'remove' === cmd ?
            `remove$({ ${parentPairs(e, false)}id: '${entIdLiteral(e, '0')}' })` :
            `make$({ ${parentPairs(e, false)}id: '${entIdLiteral(e, '0')}' }).save$()`

          Content(`
  it('${e.name}-${cmd}-refused', async () => {
    const seneca = await makeSeneca()

    await assert.rejects(
      () => seneca.entity('provider/${provider.lower}/${e.name}').${call},
      /has no ${cmd} route for one ${e.name}/,
    )
  })

`)
        }
      })


      each(provider.entities, (e: any) => {
        const pairs = parentPairs(e, false)
        const acts = e.actionList.filter((a: any) => 'save' === a.cmd)

        if (e.cmds.includes('save')) {
          Content(`
  it('${e.name}-action-unknown-save', async () => {
    const seneca = await makeSeneca()

    await assert.rejects(
      () => seneca.entity('provider/${provider.lower}/${e.name}')
        .make$({ ${pairs}id: '${entIdLiteral(e, '0')}' })
        .directive$({ action$: 'no_such_action' })
        .save$(),
      /action\\$ "no_such_action" is not an action/,
    )
  })

`)
        }

        if (e.cmds.includes('list')) {
          Content(`
  it('${e.name}-action-unknown-list', async () => {
    const seneca = await makeSeneca()

    await assert.rejects(
      () => seneca.entity('provider/${provider.lower}/${e.name}')
        .list$({ ${pairs}action$: 'no_such_action' }),
      /action\\$ "no_such_action" is not an action/,
    )
  })

`)
        }

        const canPlainSave = e.cmds.includes('load') &&
          e.canonicalOps.includes('update') &&
          !cmdRefuses(e, 'update')

        if (0 < acts.length && e.cmds.includes('save')) {
          const mut = canPlainSave ? mutableField(e) : ''
          if ('' !== mut) {
            Content(`
  // No action$ named, so this is the plain update — the action route must
  // not run on a call that did not ask for it.
  it('${e.name}-save-without-action', async () => {
    const seneca = await makeSeneca()
    const ent = seneca.entity('provider/${provider.lower}/${e.name}')

    const loaded = await ent.load$({ ${queryPairs(e, false)}id: '${entIdLiteral(e, '0')}' })
    loaded.${mut} = 'plain-${mut}'
    const saved = await loaded.save$()

    assert.equal(saved.${mut}, 'plain-${mut}')
    assert.equal(
      saved.canon$({ string: true }),
      'provider/${provider.lower}/${e.name}',
    )
  })

`)
          }

          const act = acts[0]
          Content(`
  // \`${act.action}\` is an action of \`${act.op}\`: ${act.path}
  it('${e.name}-action-${act.action}', async () => {
    const seneca = await makeSeneca()
    let err = null

    try {
      await seneca.entity('provider/${provider.lower}/${e.name}')
        .make$({ ${pairs}id: '${entIdLiteral(e, '0')}' })
        .directive$({ action$: '${act.action}' })
        .save$()
    }
    catch (e) { err = e }

    if (null != err) {
      assert.ok(!/is not an action/.test(err.message),
        'the action was refused instead of routed: ' + err.message)
    }
  })

`)
        }
      })

      // Live tests, against the companion server in the SDK repo's `app/`.
      // They PROBE first and skip when nothing is listening, so the suite is
      // green on a machine that has never started it — a live suite that
      // fails when the server is absent is one nobody runs.
      if ('' !== provider.liveBase) {
        Content(`
  describe('live', () => {
    let live = false

    before(async () => {
      live = await serverUp(LIVE_BASE)
    })

`)
        if (subject.cmds.includes('list')) {
          Content(`    it('${subject.name}-list', async (t) => {
      if (!live) return t.skip(noServer())
      const seneca = await makeSeneca(liveOpts())

      const list = await seneca.entity('provider/${provider.lower}/${subject.name}').list$()

      assert.ok(Array.isArray(list))
      if (0 < list.length) {
        assert.equal(
          list[0].canon$({ string: true }),
          'provider/${provider.lower}/${subject.name}',
        )
      }
    })

`)
        }
        // A nested subject needs its parent ids from the server, and a
        // composite one an id built from them; neither is available to a
        // literal, so the missing-record read is emitted only where it can
        // address something.
        if (subject.cmds.includes('load') && 0 === idPartsOf(subject).length &&
          liveParentsResolvable(provider, subject)) {
          const missing = 0 === subject.parents.length ?
            `'nosuch${subject.name}'` :
            `{ ${queryPairs(subject, true)}id: 'nosuch${subject.name}' }`
          Content(`    // A read of something that is not there is \`null\`, live as well as
    // offline: the provider's 404 handling is the same code path either way.
    it('${subject.name}-load-missing', async (t) => {
      if (!live) return t.skip(noServer())
      const seneca = await makeSeneca(liveOpts())

${liveParentSetup(provider, subject, '    ')}      assert.equal(
        await seneca
          .entity('provider/${provider.lower}/${subject.name}')
          .load$(${missing}),
        null,
      )
    })

`)
        }

        each(provider.entities, (e: any) => {
          if (e.cmds.includes('save') && e.cmds.includes('remove') &&
            e.canonicalOps.includes('create') &&
            liveParentsResolvable(provider, e) && compositeRoundTrip(e)) {
            Content(crudTest(provider, e, 'live'))
          }
        })

        Content(`  })

`)
      }

      Content(`
  it('maintain', async () => {
    const exclude = []

    // check_default proves the default branch is main by looking for
    // [branch "main"] in .git/config. Only a branch checkout records that
    // section: a pull_request build checks out the merge ref, and the
    // publish build checks out a tag as a detached HEAD. Neither says
    // anything about what the default branch is, so skip rather than fail.
    if ('pull_request' === process.env.GITHUB_EVENT_NAME ||
        'tag' === process.env.GITHUB_REF_TYPE) {
      exclude.push('check_default')
    }

    // url_pkgjson locates package.json by comparing process.cwd() + '/package.json'
    // against a path found with Filehound. On Windows those are the same file
    // spelt with different separators, so the url is never read.
    if ('win32' === process.platform) {
      exclude.push('url_pkgjson')
    }

    await Maintain({ exclude })
  })

`)

      Content(`})

`)

      if ('' !== provider.liveBase) {
        Content(`
function noServer() {
  return 'no ${provider.lower} server at ' + LIVE_BASE
}


function liveOpts() {
  return { sdk: { base: LIVE_BASE } }
}


// Probe the companion test server so live tests skip cleanly when it is not
// running, rather than failing the suite.
async function serverUp(base) {
  try {
    const res = await fetch(base + '${provider.probePath}', {
      signal: AbortSignal.timeout(2000),
    })
    return res.ok
  }
  catch (e) {
    return false
  }
}

`)
      }

      Content(`
// Default to the SDK's offline mock transport, seeded from ./seed.
async function makeSeneca(pluginopts) {
  pluginopts = pluginopts || { test: true, testopts: SEED }

  const seneca = Seneca({ legacy: false })
    .test()
    .use('promisify')
    .use('entity')
    .use('env', {
      // Declared so the provider convention is exercised, and defaulted so
      // the suite runs with nothing configured.
      var: {
        $${provider.ENV}_APIKEY: '',
      },
    })
    .use('provider', {
      provider: {
        ${provider.lower}: {
          keys: {
            apikey: { value: '$${provider.ENV}_APIKEY' },
          },
        },
      },
    })
    .use(${provider.pluginName}, pluginopts)

  return seneca.ready()
}
`)
    })
  })
})



const Scripts = cmp(function Scripts(props: any) {
  const { provider } = props

  // Nothing to point at without a declared server.
  if ('' === provider.liveBase) {
    return
  }

  const subject = [...provider.entities]
    .sort((a: any, b: any) =>
      (a.parents.length - b.parents.length) || (b.cmds.length - a.cmds.length))[0]

  const senecaSetup = `const Seneca = require('seneca')

const BASE = process.env.${provider.ENV}_TEST_BASE || '${provider.liveBase}'

async function makeSeneca() {
  return Seneca({ legacy: false })
    .test()
    .use('promisify')
    .use('entity')
    .use('provider', {
      provider: {
        ${provider.lower}: {
          keys: {
            apikey: { value: '' },
          },
        },
      },
    })
    .use('..', { sdk: { base: BASE } })
    .ready()
}
`

  Folder({ name: 'test' }, () => {

    File({ name: 'live.js' }, () => {
      Content(`/* Manual script: read from a running ${provider.api} server.
 *
 * Start the companion test server from the SDK repo first:
 *   cd ${provider.sdkSrc}/app && npm start
 *
 * Then:  node test/live.js
 */

${senecaSetup}

run()

async function run() {
  const seneca = await makeSeneca()

`)
      // A nested entity's list needs its parent's id, so LOOK ONE UP rather
      // than emitting a placeholder: a script that 404s on first run teaches
      // nothing and reads as a broken provider.
      each(provider.entities.filter((e: any) => e.cmds.includes('list')), (e: any) => {
        if (0 === e.parents.length) {
          Content(`  console.log('${e.name.toUpperCase()}', await seneca
    .entity('provider/${provider.lower}/${e.name}')
    .list$())

`)
          return
        }

        const parent = provider.entities
          .find((p: any) => p.name === e.parentEntity && p.cmds.includes('list'))
        if (null == parent) {
          // Nothing to derive the parent id from. Say so in the script
          // rather than emitting a call that cannot work.
          Content(`  // ${e.name}: needs ${e.parents.join(', ')}; no listable parent to take
  // one from, so supply it yourself:
  //   await seneca.entity('provider/${provider.lower}/${e.name}')
  //     .list$({ ${e.parents.map((k: string) => `${jsKey(k)}: '...'`).join(', ')} })

`)
          return
        }

        const key = e.parents[0]
        Content(`  const ${parent.name}s = await seneca
    .entity('provider/${provider.lower}/${parent.name}')
    .list$()

  if (0 < ${parent.name}s.length) {
    console.log('${e.name.toUpperCase()}', await seneca
      .entity('provider/${provider.lower}/${e.name}')
      .list$({ ${jsKey(key)}: ${parent.name}s[0].id }))
  }

`)
      })
      Content(`}
`)
    })


    // The write cycle, kept separate: it MUTATES the server, so it is not
    // something to run by reflex. It cleans up after itself.
    if (subject.cmds.includes('save') && subject.cmds.includes('remove')) {
      const idf = 'id'
      const writable = subject.fields.filter((f: any) => ownField(subject, f))

      const make = writable
        .map((f: any) => `${jsKey(f.name)}: ${fieldLiteral(f, 'quick')}`)
        .join(', ')

      File({ name: 'quick.js' }, () => {
        Content(`/* Manual script: exercise the full CRUD cycle against a running server.
 *
 * Start the companion test server from the SDK repo first:
 *   cd ${provider.sdkSrc}/app && npm start
 *
 * Then:  node test/quick.js
 *
 * Creates and then removes a ${subject.name}, so the server is left as found.
 */

${senecaSetup}

run()

async function run() {
  const seneca = await makeSeneca()

  // Create: ${true === subject.rkoncreate ?
            `this API keys ${subject.name} records by \`${subject.rk}\` and the create\n  // request requires it, so it is sent and comes back as the id.` :
            'the API assigns the id, so none is supplied here.'}
  let ${subject.name} = await seneca
    .entity('provider/${provider.lower}/${subject.name}')
    .make$({ ${make} })
    .save$()
  console.log('CREATED', ${subject.name})

  const id = ${subject.name}.${idf}

  try {
`)
        // Change something an assertion could SEE. A container field would be
        // rewritten to the same empty literal, which demonstrates nothing.
        const upd = writable.find((f: any) => changeField(subject, f) &&
          ('string' === f.kind || 'number' === f.kind)) || null

        if (subject.ops.includes('update') && null != upd) {
          const f = upd
          const v = 'number' === f.kind ? '4321' : `'quick-${f.name}-2'`
          Content(`    // Update: an entity carrying an id is an update.
    ${jsProp(subject.name, f.name)} = ${v}
    console.log('UPDATED', await ${subject.name}.save$())

`)
        }
        if (subject.cmds.includes('load')) {
          Content(`    console.log(
      'LOADED',
      await seneca.entity('provider/${provider.lower}/${subject.name}').load$(id)
    )

`)
        }

        const child = provider.entities.find((e: any) =>
          1 === e.parents.length &&
          e.parentEntity === subject.name &&
          e.cmds.includes('save') && e.cmds.includes('remove'))

        if (null != child) {
          const ckey = child.parents[0]
          const cidf = 'id'
          const cmake = (child.fields || [])
            .filter((f: any) => ownField(child, f))
            .map((f: any) => `${jsKey(f.name)}: ${fieldLiteral(f, 'quick')}`)
            .join(', ')

          Content(`    // ${child.name} records hang off ${subject.name} records, so this one
    // goes under the ${subject.name} just created — and comes back off again.
    const ${child.name} = await seneca
      .entity('provider/${provider.lower}/${child.name}')
      .make$({ ${jsKey(ckey)}: id${'' === cmake ? '' : ', ' + cmake} })
      .save$()
    console.log('${child.name.toUpperCase()} CREATED', ${child.name})

    await seneca
      .entity('provider/${provider.lower}/${child.name}')
      .remove$({ ${jsKey(ckey)}: id, ${cidf}: ${child.name}.${cidf} })
    console.log('${child.name.toUpperCase()} REMOVED')

`)
        }

        Content(`  }
  finally {
    await seneca.entity('provider/${provider.lower}/${subject.name}').remove$(id)
    console.log('REMOVED', id)
  }
`)
        if (subject.cmds.includes('load')) {
          Content(`
  console.log(
    'AFTER REMOVE (expect null)',
    await seneca.entity('provider/${provider.lower}/${subject.name}').load$(id)
  )
`)
        }
        Content(`}
`)
      })
    }
  })
})



const Workflow = cmp(function Workflow(props: any) {
  const { provider } = props

  Folder({ name: '.github' }, () => {
    Folder({ name: 'workflows' }, () => {
      File({ name: 'build.yml' }, () => {
        Content(`# Generated by @voxgig/sdkgen. Do not edit.
#
${'git' === provider.sdkDepKind ?
          `# The ${provider.api} SDK is depended on by GIT TAG rather than taken from a\n` +
          '# registry, so `npm install` resolves the tag named in package.json and\n' +
          '# needs git on PATH — every GitHub runner has it.\n' +
          '#\n' +
          '# npm 12 refuses a git dependency by default (allow-git defaults to\n' +
          '# "none"), which is what --allow-git=all below opts back into. Nothing\n' +
          '# else is needed to build and run the offline tests on any platform.' :
          'release' === provider.sdkDepKind ?
            `# The ${provider.api} SDK is depended on by GITHUB RELEASE ASSET rather than\n` +
            '# taken from a registry: an npm-pack tarball attached to the tag, which\n' +
            '# npm installs without looking at the repository layout.\n' +
            '#\n' +
            '# npm 12 refuses a remote tarball by default (allow-remote defaults to\n' +
            '# "none"), which is what --allow-remote=all below opts back into. That\n' +
            '# flag does not travel to consumers of this package, so publishing the\n' +
            '# SDK remains the durable answer.' :
            `# The ${provider.api} SDK is a normal published dependency, so \`npm install\`\n` +
            '# is all that is needed to build and run the offline tests on every\n' +
            '# platform.'}
${!provider.liveApp ? '' : `#
# The live tests additionally need the companion server, which is only
# distributed in the SDK's source repository (it is not published). That repo
# is cloned and started on Linux only, because backgrounding the server
# assumes a POSIX shell. The live tests probe for the server and skip cleanly
# when it is absent, so on Windows and macOS they simply skip.`}

name: build

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  build:
    timeout-minutes: 10

    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest, macos-latest]
        node-version: [24.x]

    runs-on: \${{ matrix.os }}

    steps:
      # EVERY ACTION IS PINNED TO A SHA, with the version in a comment.
      #
      # Not a preference: an organisation can require it (the repository
      # setting is sha_pinning_required), and a workflow naming a TAG then
      # fails to START — no jobs, no logs, just a startup_failure on every
      # push. The senecajs org has that policy on, so this workflow never ran
      # once in the repository it was generated for, and weeks of red marks
      # said nothing about the code.
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7

      - name: Use Node.js \${{ matrix.node-version }}
        uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7
        with:
          node-version: \${{ matrix.node-version }}

${!provider.liveApp ? '' : `
      # Live-test target. Failure to start degrades coverage (the live tests
      # probe first and skip) rather than failing the build — which is what
      # continue-on-error is for, and what its absence undid: GitHub runs a
      # run: block under bash -e, so a repo whose app/ has no build script,
      # or no app/ at all, went red on its first push with the comment
      # above still claiming otherwise.
      - name: Start the ${provider.api} test server
        if: runner.os == 'Linux'
        continue-on-error: true
        run: |
          git clone --depth 1 \\
            ${provider.sdkRepoUrl}.git \\
            "$RUNNER_TEMP/sdk"
          cd "$RUNNER_TEMP/sdk/app"
          npm install
          npm run build
          npm start &
          for i in $(seq 1 30); do
            if curl -sf ${provider.liveBase}${provider.probePath} > /dev/null; then
              echo "server up"
              exit 0
            fi
            sleep 1
          done
          echo "server did not start; live tests will skip"
`}
      - run: npm install${provider.sdkInstallFlag}

      - run: npm run build --if-present
      - run: npm test
`)
      })

      File({ name: 'publish.yml' }, () => {
        Content(`# Generated by @voxgig/sdkgen. Do not edit.
#
# Publishes ${provider.pkgName} to npm on a \`v*\` tag push, via GitHub OIDC
# Trusted Publishing — no NPM_TOKEN secret. The \`id-token: write\` permission
# lets npm exchange a GitHub OIDC token for a short-lived publish credential,
# and provenance is attached automatically.
#
# TWO JOBS, BECAUSE THEY NEED DIFFERENT PRIVILEGES.
#
#   verify   contents: read, and nothing else. Runs npm install, the build
#            and the tests — i.e. dependency lifecycle scripts and project
#            code. It holds no publish credential.
#   publish  id-token: write, contents: read. Installs NO project
#            dependencies and runs NO project code: this package ships
#            \`dist\`, which is committed, so nothing needs building to pack.
#
# THE SPLIT IS THE POINT. A compromised dependency lifecycle script can ask
# the runner for any OIDC token the JOB is permitted to mint, so a job that
# both installs dependencies and holds \`id-token: write\` can be made to
# publish as this package before its own gates finish. Keeping the install in
# a job with no id-token, and the credential in a job that installs nothing,
# is what makes the isolation real rather than nominal.
#
# The trusted publisher must be registered on npmjs.com for this package
# against THIS filename (publish.yml); renaming this file breaks publishing
# until the npm-side config is updated to match.
#
# npm cannot configure a trusted publisher for a package that does not exist
# yet — the settings page appears once a version is on the registry. So the
# FIRST version of a new package is published by hand, once, with an
# authenticated npm; every release after that is a tag push.
#
# Release flow: bump the version in the SDK model
# (\`main: kit: target: 'seneca-provider': publish: version\`), regenerate,
# merge, then push a v* tag.

name: publish

on:
  push:
    tags: ['v*']
  workflow_dispatch:

jobs:
  verify:
    name: verify
    runs-on: ubuntu-latest
    timeout-minutes: 15

    # Deliberately the default-minimum. This job runs third-party code.
    permissions:
      contents: read

    outputs:
      version: \${{ steps.version.outputs.version }}

    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7

      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7
        with:
          node-version: 24.x

      # install, not ci: this package does not commit a lockfile.
      - run: npm install${provider.sdkInstallFlag}

      - run: npm run build
      - run: npm test

      # The tag must match what the manifest declares, or a tag push silently
      # republishes whatever version happens to be in package.json.
      - name: Check the tag matches the manifest version
        id: version
        run: |
          set -euo pipefail
          PKG=\$(node -p "require('./package.json').version")
          if [ "\${GITHUB_REF_TYPE:-}" = "tag" ]; then
            TAG="\${GITHUB_REF_NAME#v}"
            if [ "\$TAG" != "\$PKG" ]; then
              echo "::error::tag v\$TAG does not match package.json \$PKG"
              exit 1
            fi
          fi
          echo "version=\$PKG" >> "\$GITHUB_OUTPUT"

      # WHAT THE PUBLISH JOB WILL PACK, checked HERE where the code already
      # ran. That job builds nothing, so a missing or stale \`dist\` would
      # otherwise be discovered by consumers rather than by this workflow.
      - name: The committed dist matches the source
        run: |
          set -euo pipefail
          if ! git diff --quiet -- dist; then
            echo "::error::dist/ is not up to date with src/ -- rebuild and commit it"
            git diff --stat -- dist
            exit 1
          fi

  publish:
    name: npm publish
    needs: verify
    runs-on: ubuntu-latest
    timeout-minutes: 15

    # The ONLY job holding the publish credential — and it installs no
    # project dependencies and runs no project code. See the header.
    permissions:
      id-token: write
      contents: read

    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7

      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7
        with:
          node-version: 24.x
          registry-url: 'https://registry.npmjs.org'

      # Trusted publishing requires npm >= 11.5.1. This is npm itself, not a
      # project dependency: no package.json here is consulted.
      - name: Use a trusted-publishing capable npm
        run: npm install -g npm@latest

      # THE REGISTRY IS THE SOURCE OF TRUTH FOR "IS THIS RELEASED", not the
      # tag. A re-run of a workflow that already published would otherwise
      # fail on a version conflict and report a red release that in fact
      # succeeded.
      - name: Is this version already on npm?
        id: registry
        env:
          VERSION: \${{ needs.verify.outputs.version }}
        run: |
          set -euo pipefail
          if npm view "${provider.pkgName}@\$VERSION" version >/dev/null 2>&1; then
            echo "published=true" >> "\$GITHUB_OUTPUT"
            echo "\$VERSION is already on npm — skipping publish"
          else
            echo "published=false" >> "\$GITHUB_OUTPUT"
          fi

      - name: Publish to npm
        if: steps.registry.outputs.published == 'false'
        run: npm publish --access public
`)
      })
    })
  })
})



const Readme = cmp(function Readme(props: any) {
  const { provider } = props

  const subject = [...provider.entities]
    .sort((a: any, b: any) =>
      (a.parents.length - b.parents.length) || (b.cmds.length - a.cmds.length))[0]

  const nested = provider.entities.filter((e: any) => 0 < e.parents.length)

  File({ name: 'README.md' }, () => {
    Content(`![Seneca ${provider.Name}-Provider](http://senecajs.org/files/assets/seneca-logo.png)

> _Seneca ${provider.Name}-Provider_ is a plugin for [Seneca](http://senecajs.org)

Provides access to the ${provider.api} API using the Seneca _provider_
convention. ${provider.api} entities are represented as Seneca entities so that
they can be accessed using the Seneca entity API and messages.

Requests are handled by the [${provider.api} SDK](${provider.sdkRepoUrl}),
which is generated from the API's OpenAPI specification. This plugin is
generated from the same specification by
[@voxgig/sdkgen](https://github.com/voxgig/sdkgen) — do not edit it by hand,
change the model and regenerate.

See [seneca-entity](https://github.com/senecajs/seneca-entity) and the [Seneca Data
Entities
Tutorial](https://senecajs.org/docs/tutorials/understanding-data-entities.html)
for more details on the Seneca entity API.

[![build](${provider.repoUrl}/actions/workflows/build.yml/badge.svg)](${provider.repoUrl}/actions/workflows/build.yml)

| This open source module is sponsored and supported by [${provider.publisher}](${provider.publisherUrl}). |
| --- |


<!--START:SECTION:intro-->
<!--END:SECTION:intro-->


## Documentation

Full documentation lives in [\`doc/\`](doc/README.md) and follows the
[Diátaxis](https://diataxis.fr) framework:

| Document | Purpose |
| -------- | ------- |
| [Tutorial](doc/tutorial.md) | Start here. Build a working script from an empty folder. |
| [How-to guides](doc/how-to.md) | Recipes for specific tasks. |
| [Reference](doc/reference.md) | Every pattern, entity, option and export. |
| [Explanation](doc/explanation.md) | Why the plugin is designed this way. |


## Quick Example

\`\`\`js
const Seneca = require('seneca')

const seneca = Seneca()
  .use('promisify')
  .use('entity')
  .use('env', { var: { $${provider.ENV}_APIKEY: '' } })
  .use('provider', {
    provider: {
      ${provider.lower}: {
        keys: { apikey: { value: '$${provider.ENV}_APIKEY' } },
      },
    },
  })
  .use('${provider.pkgName}'${'' === provider.specBase ?
      `, { sdk: { base: 'https://${provider.lower}.example.com' } }` : ''})

await seneca.ready()

`)
    if (subject.cmds.includes('list')) {
      Content(`const ${subject.name}s = await seneca
  .entity('provider/${provider.lower}/${subject.name}').list$()
`)
    }
    if (subject.cmds.includes('load')) {
      const cparts = idPartsOf(subject)
      const loadArg = 0 < cparts.length ?
        `'${cparts.map((p: string) => 'some-' + p).join(
          null != subject.idsep && '' !== String(subject.idsep) ?
            String(subject.idsep) : '/')}'` :
        0 === subject.parents.length ? (loadHasKey(subject) ? `'some-id'` : '') :
          `{ ` + subject.parents.map((p: string) => `${jsKey(p)}: 'some-${p}'`).join(', ') +
          `, id: 'some-id' }`
      Content(`const ${subject.name} = await seneca
  .entity('provider/${provider.lower}/${subject.name}').load$(${loadArg})
`)
    }
    Content(`\`\`\`


## Install

\`\`\`sh
npm install ${provider.pkgName}
\`\`\`

This plugin expects the Seneca host framework to be present:

\`\`\`sh
npm install seneca seneca-entity seneca-promisify @seneca/provider @seneca/env
\`\`\`


## Options

| Option | Type | Description |
| --- | --- | --- |
| \`sdk\` | object | Passed straight to the \`${provider.sdkClass}\` constructor. Most usefully \`base\`, to point at a server. |
| \`test\` | boolean | Run the SDK in offline test mode (in-memory mock transport). |
| \`testopts\` | object | Seed and options for the mock, used only when \`test\` is true. |


## Entities

Each API entity is exposed as a Seneca entity under
\`provider/${provider.lower}/<entity>\`.

| Seneca entity | Commands | Fields |
| --- | --- | --- |
`)
    each(provider.entities, (e: any) => {
      const fields = 0 === e.fields.length ? '—' :
        e.fields.map((f: any) => '`' + f.name + '`').join(', ')
      Content(`| \`provider/${provider.lower}/${e.name}\` | ${e.cmds.map((c: string) => '`' + c + '$`').join(', ')} | ${fields} |
`)
    })

    if (0 < nested.length) {
      Content(`
### Nested entities

Some entities live under a parent in the API path, so every command needs the
parent's id in the query. Leaving it out throws with a message naming the
missing key, rather than failing as an opaque 404 from a half-built URL.

`)
      each(nested, (e: any) => {
        Content(`- \`${e.name}\` requires \`${e.parents.join('`, `')}\`
`)
      })
    }

    const acting = provider.entities.filter((e: any) => 0 < e.actionList.length)

    if (0 < acting.length) {
      const first = acting[0]
      const firstAct = first.actionList[0]
      const saver = acting.find((e: any) =>
        e.actionList.some((a: any) => 'save' === a.cmd))

      Content(`
### Actions

Some API endpoints are not one of the five CRUD operations — merging a pull
request, uploading an image. The API definition folds each one into an
ordinary operation as an alternative route, and this plugin selects one with
the \`action$\` directive, alongside Seneca's own \`sort$\`, \`limit$\` and
\`fields$\`.

| Entity | Action | Route | Command |
| --- | --- | --- | --- |
`)
      each(acting, (e: any) => {
        each(e.actionList, (a: any) => {
          Content(`| \`${e.name}\` | \`${a.action}\` | \`${a.path}\` | \`${a.cmd}$\` |
`)
        })
      })

      Content(`
An action returns that action's OWN response, which is not necessarily a
record of the entity it hangs off — check the API definition for its shape.
Naming an action the entity does not have throws, and names the ones it
does have. It never falls back to the plain command.

`)

      if (null != saver) {
        const act = saver.actionList.find((a: any) => 'save' === a.cmd)
        Content(`On \`save$\`, pass it as a directive. The rest of the entity is the
action's payload:

\`\`\`js
const ${saver.name} = seneca.entity('provider/${provider.lower}/${saver.name}')

await ${saver.name}
  .make$({ id: 'some-id', /* ...the action's own arguments */ })
  .directive$({ action$: '${act.action}' })
  .save$()
\`\`\`

> **\`make$({ action$: '${act.action}' })\` does not work**, and cannot.
> \`seneca-entity\`'s \`make$\` copies only keys without a \`$\`, plus the four
> directives it knows by name (\`id$\`, \`merge$\`, \`custom$\`, \`directive$\`),
> so any other trailing-\`$\` key is dropped before this plugin sees it —
> there is nothing left for it to refuse. Use \`directive$\` as above, or
> assign the property to an entity you already made:
>
> \`\`\`js
> const p = ${saver.name}.make$({ id: 'some-id' })
> p.action$ = '${act.action}'
> await p.save$()
> \`\`\`

`)
      }

      if ('save' !== firstAct.cmd) {
        Content(`On \`${firstAct.cmd}$\`, pass it in the query:

\`\`\`js
await seneca.entity('provider/${provider.lower}/${first.name}')
  .${firstAct.cmd}$({ action$: '${firstAct.action}' })
\`\`\`

`)
      }
    }

    Content(`

## Action Patterns

Every message pattern this plugin registers. The entity actions are the ones
\`seneca-entity\` dispatches to when you call \`list$\` / \`load$\` / \`save$\` /
\`remove$\` on a canon below — you rarely post them by hand, but they are what
appears in a Seneca log, and a plugin that documents one of nine is a plugin
whose logs cannot be read.

| Pattern | Description |
| --- | --- |
| \`sys:provider,provider:${provider.lower},get:info\` | Plugin and SDK version information. |
`)

    const CMD_DESC: Record<string, string> = {
      list: 'List records',
      load: 'Load one record',
      save: 'Create or update a record',
      remove: 'Remove a record',
    }

    each(provider.entities, (e: any) => {
      each(e.cmds, (cmd: any) => {
        const c = String(cmd.val$ ?? cmd)
        const desc = 'save' !== c ? CMD_DESC[c] :
          !e.ops.includes('update') ? 'Create a record' :
            !e.ops.includes('create') ? 'Update a record' : CMD_DESC[c]
        Content(`| \`sys:entity,cmd:${c},zone:provider,base:${provider.lower},name:${e.name}\` | ${desc}. |
`)
      })
    })

    Content(`


## More Examples

### Offline testing

The SDK ships an in-memory mock transport, so this plugin can be exercised
with no server:

\`\`\`js
.use('${provider.pkgName}', { test: true, testopts: { entity: { ... } } })
\`\`\`

\`testopts\` is passed straight to the SDK's test constructor; \`entity\`
seeds the mock store. See \`test/seed.js\` for the shape.

`)
    if ('' !== provider.liveBase) {
      Content(`### Running against a server

\`\`\`js
.use('${provider.pkgName}', { sdk: { base: '${provider.liveBase}' } })
\`\`\`

The companion test server is distributed in the SDK's source repository
only. From a checkout beside this one:

\`\`\`sh
cd ${provider.sdkSrc}/app && npm start
\`\`\`

Then \`node test/live.js\` reads from it, and \`node test/quick.js\` runs a
full create/update/load/remove cycle.

`)
    }

    Content(`
## Motivation

Applications rarely talk to one external service, and each service usually
arrives with its own client library, authentication style and error
conventions. That variety leaks into application code and makes it harder to
test.

The Seneca provider convention removes the variety: every external service
becomes a Seneca entity reached with \`list$\`, \`load$\`, \`save$\` and
\`remove$\`, so application code has one shape regardless of what it talks to.

The SDK underneath arrives at a similar conclusion from the other side — it
deliberately exposes entities rather than HTTP routes. This plugin is the
short bridge between the two.


## Support

- Issues and bugs: [GitHub issues](${provider.repoUrl}/issues)
- Seneca community: [senecajs.org](http://senecajs.org)


## API

### Plugin export: \`${provider.pluginName}/sdk\`

Returns the configured \`${provider.sdkClass}\` instance, for the operations
the entity API does not cover:

\`\`\`js
const sdk = seneca.export('${provider.pluginName}/sdk')()
\`\`\`


## Contributing

${provider.standalone ?
`This plugin is GENERATED, by the builder in \`.sdk/\` from the API definition
of the SDK it depends on. Changes to the API belong in the SDK project's
model, this package's own decisions in \`.sdk/model/project.aontu\`, and
everything else in the components that build this target — anything edited
elsewhere in this repository is overwritten by the next \`make regen\`.` :
`This plugin is GENERATED. Changes belong in the SDK project's model and
components, not here — anything edited in this repository is overwritten by
the next generation run.`}

The [Senecajs org](http://senecajs.org) encourages open participation. If you
feel you can help in any way, be it with bug reporting, documentation,
examples, extra testing, or new features, please get in touch.


## Background

Generated by [@voxgig/sdkgen](https://github.com/voxgig/sdkgen) from the
${provider.api} API definition, against the
[${provider.sdkPkg}](https://www.npmjs.com/package/${provider.sdkPkg}) SDK.
`)
  })
})



const DocTutorial = cmp(function DocTutorial(props: any) {
  const { provider } = props

  // Entity and field names come from an API definition, so they cannot be
  // assumed to be legal JavaScript identifiers.
  const ident = (s: string) => String(s).replace(/[^A-Za-z0-9_$]/g, '_')
  const qkey = (k: string) =>
    /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(String(k)) ? String(k) : `'${k}'`
  const plural = (n: string) =>
    n.endsWith('s') ? `${ident(n)}List` : `${ident(n)}s`
  const canon = (n: string) => `provider/${provider.lower}/${n}`
  const entOf = (name: string) =>
    provider.entities.find((e: any) => e.name === name) || null

  // The entity the lesson is built on: fewest parent keys to arrange, then
  // most cmds to show. The same choice the tests and the README make, so all
  // three talk about the same thing.
  const subject = [...provider.entities]
    .sort((a: any, b: any) =>
      (a.parents.length - b.parents.length) || (b.cmds.length - a.cmds.length))[0]

  const idf = 'id'
  const subjParent = 0 < subject.parents.length ?
    entOf(subject.parentEntity) : null

  const hasServer = '' !== provider.liveBase

  // Can the live lesson actually be written? It needs a server AND a first id
  // the script can discover for itself.
  const live = hasServer &&
    subject.cmds.includes('list') &&
    (0 === subject.parents.length ||
      (1 === subject.parents.length &&
        null != subjParent && subjParent.cmds.includes('list')))

  const offline = !live

  // The nested entity the lesson finishes on. Prefer one hanging off the
  // subject, so the reader recognises the parent id when it turns up.
  const readable = (e: any) => e.cmds.includes('list') || e.cmds.includes('load')
  const nested = provider.entities
    .filter((e: any) => 0 < e.parents.length && e.name !== subject.name)
    .filter(readable)
    // Live, the parent id has to come from somewhere: exactly one parent key,
    // and a parent that can be listed.
    .filter((e: any) => offline ||
      (1 === e.parents.length && null != entOf(e.parentEntity) &&
        entOf(e.parentEntity).cmds.includes('list')))
  const child = nested.find((e: any) => e.parentEntity === subject.name) ||
    nested.find((e: any) => null != entOf(e.parentEntity)) ||
    nested[0] || null
  const childParent = null == child ? null : entOf(child.parentEntity)

  // The value seedRecord() gives a parent key, so a query written here finds
  // the seeded record instead of quietly matching nothing.
  const seedParentVal = (e: any, k: string) => parentSeed(e, k)

  // A seed record guaranteed to carry its id and its parent keys.
  // seedRecord() emits only the fields the model marks required, and a record
  // missing its parent key is invisible to the very query this lesson makes.
  const demoRecord = (e: any, idx: number) => {
    const rec: any = seedRecord(e, idx)
    const eidf = e.rk || 'id'
    if (null == rec[eidf]) {
      rec[eidf] = `${e.name}${idx}`
    }
    for (const k of e.parents) {
      if (null == rec[k]) {
        rec[k] = seedParentVal(e, k)
      }
    }
    return rec
  }

  // Only the entities the lesson touches, in model order.
  const seedNames = [subject.name]
  if (null != subjParent) seedNames.push(subjParent.name)
  if (null != child) seedNames.push(child.name)
  if (null != childParent) seedNames.push(childParent.name)

  const seedLiteral = provider.entities
    .filter((e: any) => seedNames.includes(e.name))
    .map((e: any) =>
      `    ${qkey(e.name)}: {\n` +
      [0, 1].map((idx: number) =>
        `      ${qkey(e.name + idx)}: ${JSON.stringify(demoRecord(e, idx))},\n`)
        .join('') +
      `    },\n`)
    .join('')

  // Every call on the subject carries its parent keys, if it has any: live
  // they come from a lookup, offline from the seed.
  const subjKeys = subject.parents.map((k: string) =>
    `${qkey(k)}: ${offline ? `'${seedParentVal(subject, k)}'` : ident(k)}`)
  const listArg = 0 === subjKeys.length ? '' : `{ ${subjKeys.join(', ')} }`
  const oneArg = (id: string) => 0 === subjKeys.length ? id :
    `{ ${subjKeys.concat([`${qkey(idf)}: ${id}`]).join(', ')} }`

  const subjVar = plural(subject.name)
  const subjOne = ident(subject.name)

  // Live, the first id is whatever the server answered with; offline it is
  // seeded above.
  const firstId = offline ? `'${subject.name}0'` : `${subjVar}[0].${idf}`

  // A nested subject needs its parent's id before anything else can run.
  const subjPre = (live && null != subjParent) ?
    `  // ${subject.name} records live under ${subjParent.name} records in the API,
  // so every ${subject.name} call needs a ${subject.parents[0]}.
  const ${plural(subjParent.name)} = await seneca
    .entity('${canon(subjParent.name)}')
    .list$()
  const ${ident(subject.parents[0])} = ${plural(subjParent.name)}[0].id

` : ''

  // Fields worth printing, and worth writing: not the id, not a parent key.
  const plainFields = subject.fields.filter((f: any) => ownField(subject, f))
  const changeFields = plainFields.filter((f: any) => changeField(subject, f))
  const shown = plainFields.slice(0, 2)
  const litval = (f: any, alt: boolean) =>
    'number' === f.kind ? (alt ? '4321' : '1234') :
      'boolean' === f.kind ? (alt ? 'true' : 'false') :
        `'tutorial-${f.name}${alt ? '-2' : ''}'`

  const makeFields = subject.parents
    .map((k: string) =>
      `${qkey(k)}: ${offline ? `'${seedParentVal(subject, k)}'` : ident(k)}`)
    .concat(plainFields.map((f: any) => `${qkey(f.name)}: ${litval(f, false)}`))

  const hasRead = subject.cmds.includes('list') || subject.cmds.includes('load')
  // Creating a record with nothing in it teaches nothing, so the write step
  // needs at least one field the caller actually supplies.
  const canWrite = subject.cmds.includes('save') && 0 < plainFields.length
  const canUpdate = canWrite && subject.ops.includes('update') &&
    0 < changeFields.length
  const canRemove = canWrite && subject.cmds.includes('remove')

  const cmdList = subject.cmds.map((c: string) => '`' + c + '$`').join(', ')

  // Entity names are lowercase, and some of them have to start a sentence.
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

  // A nested SUBJECT would otherwise carry an unexplained parent key through
  // every example in the lesson. Said once, before the first call.
  const nestedNote = 0 === subject.parents.length ? '' :
    `${cap(subject.name)} records live inside ${'' === subject.parentEntity ?
      'a parent record' : `${subject.parentEntity} records`} in the API,
and the route says so:

\`${subject.path}\`

The parent id there is not optional, so every ${subject.name} call
carries ${subject.parents.map((k: string) => '`' + k + '`').join(' and ')} in its query. Leave it out and the provider
names the key you missed, rather than letting a half-built URL come
back as a puzzling 404.

`

  // ONE PATH, BOTH WAYS IN. `provider.sdkSrc` is where the SDK source is
  // reached: the pinned fetch target when the SDK has a repository, and the
  // relative walk back when it has none and nothing can be fetched. So the
  // instruction differs but the path does not, and neither spelling carries a
  // directory name off anyone's machine.
  const appDir = `${provider.sdkSrc}/app`

  const getServer = provider.sdkPinned ?
    `You also need a server to talk to. The SDK itself installs from npm,
but its test server does not — it ships only in the SDK's source
repository. \`make sdk-src\` fetches that source at the tag this plugin
was generated from, into \`${provider.sdkSrc}\`:

\`\`\`sh
$ make sdk-src
\`\`\`
` :
    `You also need a server to talk to. The SDK itself installs from npm,
but its test server does not — it ships only in the SDK's source
project, in its \`app\` folder, which is at \`${provider.sdkSrc}\`
relative to this one.
`

  // What a bare GET on the probe route answers with, when the model has one.
  const probeEnt = '' === provider.probePath ? null :
    provider.entities.find((e: any) => e.path === provider.probePath)

  // Who assigns ids and holds the data, in prose.
  const source = live ? 'server' : 'store'

  // Where the nested-subject note lands: the first step that shows a call.
  const noteAt = subject.cmds.includes('list') ? 'list' :
    subject.cmds.includes('load') ? 'load' : 'write'

  let stepno = 0
  const step = (title: string) => `## Step ${++stepno}: ${title}`

  File({ name: 'tutorial.md' }, () => {

    Content(`# Tutorial: your first ${provider.Name} query

This tutorial takes you from an empty folder to a script that
${canWrite ? 'reads and writes' : 'reads'} ${provider.api} data through
Seneca entities. It should take about fifteen minutes.

You will build one script and add to it as you go.`)

    if (live) {
      Content(` Everything runs
locally against a test server you start yourself, so nothing here can
affect anything outside your machine.

You need [Node.js](https://nodejs.org) 24 or later.

${getServer}
${step('Start the test server')}

That server implements the ${provider.api} API. Build and start it:

\`\`\`sh
$ cd ${appDir}
$ npm install
$ npm run build
$ npm start
\`\`\`

It listens on \`${provider.liveBase}\`. Check it from another terminal:

\`\`\`sh
$ curl ${provider.liveBase}${provider.probePath}
\`\`\`

`)
      Content(null == probeEnt ?
        `You should get a JSON answer rather than a refused connection.
Leave the server running.

` :
        `You should see a JSON array of ${probeEnt.name} records.
Leave the server running.

`)
    }
    else {
      Content(` Everything runs in
memory: the SDK ships an offline mode backed by a small in-memory
store, and you supply that store's contents yourself. No request leaves
your machine, so nothing here can affect anything outside it.

You need [Node.js](https://nodejs.org) 24 or later. You do not need a
server, a network connection, or credentials.

`)
    }

    Content(`${step('Create the project')}

`)
    if (live) {
      Content(`In a new terminal:

`)
    }
    Content(`\`\`\`sh
$ mkdir ${provider.lower}-demo
$ cd ${provider.lower}-demo
$ npm init -y
$ npm install seneca seneca-entity seneca-promisify @seneca/provider ${provider.pkgName}
\`\`\`

The first four are the Seneca host: the framework itself, the entity
API, the promise wrapper that makes calls awaitable, and the shared
machinery every Seneca provider is built on. The last is this plugin,
which brings the ${provider.api} SDK with it.

${step('Connect')}

Create \`demo.js\`:

\`\`\`js
const Seneca = require('seneca')

`)

    if (offline) {
      Content(`// The offline store. Each key under an entity name is that record's
// id, and each record is what the API would have answered with.
const SEED = {
  entity: {
${seedLiteral}  },
}

`)
    }

    Content(`async function main() {
  const seneca = await Seneca({ legacy: false })
    .use('promisify')
    .use('entity')
    .use('provider', {
      provider: {
        ${qkey(provider.lower)}: {
          keys: {
            apikey: { value: '' },
          },
        },
      },
    })
`)
    Content(live ?
      `    .use('${provider.pkgName}', {
      sdk: { base: '${provider.liveBase}' },
    })
` :
      `    .use('${provider.pkgName}', {
      test: true,
      testopts: SEED,
    })
`)
    Content(`    .ready()

  const info = await seneca.post('sys:provider,provider:${provider.lower},get:info')
  console.log(info)
}

main()
\`\`\`

Run it:

\`\`\`sh
$ node demo.js
\`\`\`

You should see:

\`\`\`js
{
  ok: true,
  name: '${provider.lower}',
  version: '${provider.version}',
  sdk: { name: '${provider.sdkPkg}', version: '${provider.sdkVersion}' },
}
\`\`\`

Two details of that configuration are worth a moment. The \`apikey\` is
declared even though nothing here asks for credentials — ${provider.authActive ?
      'an empty\nvalue simply means no credential is sent' :
      'this API declares\nno authentication, so the value is never read'}. Every Seneca
provider is configured the same way, so an application that later moves
to an authenticated service changes one value rather than its shape.
And \`get:info\` is answered by the plugin itself, without calling the
API, so a reply tells you the plugin loaded and initialised before any
request goes anywhere.

`)

    if (subject.cmds.includes('list')) {
      Content(`${step(`List the ${subject.name} records`)}

${'list' === noteAt ? nestedNote : ''}Replace the \`console.log(info)\` line with:

\`\`\`js
${subjPre}  const ${subjVar} = await seneca
    .entity('${canon(subject.name)}')
    .list$(${listArg})

  console.log('Found ' + ${subjVar}.length + ' ${subject.name} record(s):')
  ${subjVar}.forEach((r) => {
    console.log('  ' + r.${idf}${shown.map((f: any) => ` + '  ' + r.${f.name}`).join('')})
  })
\`\`\`

`)
      Content(offline ?
        `Run it again and you will see the two ${subject.name}
records you seeded, under the ids they are filed by.

` :
        `Run it again and you will see every ${subject.name}
record the server holds.

`)
      Content(`No URL, no HTTP verb, no JSON parsing. You asked a Seneca entity for
a list, the provider turned that into an SDK call, and the SDK turned
it into a request. These are ordinary Seneca entities, so everything
you already know about the entity API applies to them.

`)
    }

    if (subject.cmds.includes('load')) {
      Content(`${step(`Load one ${subject.name}`)}

${'load' === noteAt ? nestedNote : ''}Add:

\`\`\`js
  const one = await seneca
    .entity('${canon(subject.name)}')
    .load$(${oneArg(firstId)})

  console.log('loaded', one.${idf}${0 < shown.length ? `, one.${shown[0].name}` : ''})
\`\`\`

`)
      Content(subject.cmds.includes('list') ?
        `\`list$\` gives you many, \`load$\` gives you one. Now ask for
something that is not there:

` :
        `\`load$\` gives you one record by its id. Now ask for something
that is not there:

`)
      Content(`\`\`\`js
  const missing = await seneca
    .entity('${canon(subject.name)}')
    .load$(${oneArg(`'nosuch${subject.name}'`)})

  console.log('missing =', missing)   // null
\`\`\`

You get \`null\`, not an exception. "There is no such
${subject.name}" is an ordinary answer to a lookup, so it does not
interrupt your code.

`)
    }

    if (canWrite) {
      Content(`${step('Create, change and remove')}

${'write' === noteAt ? nestedNote : ''}`)
      Content(hasRead ?
        `Everything so far has been reading. This entity accepts writes too,
so add:

` :
        `Now write one. Add:

`)
      Content(`\`\`\`js
  // Create: make$ builds an entity, save$ persists it.
  let ${subjOne} = await seneca
    .entity('${canon(subject.name)}')
    .make$({ ${makeFields.join(', ')} })
    .save$()

  console.log('created with id', ${subjOne}.${idf})
\`\`\`

${true === subject.rkoncreate ?
        `Run it, and note the id printed: it is the \`${subject.rk}\` you sent.
The ${source} addresses ${subject.name} records by that key rather than by an
id of its own, and the provider carries it as the entity's id.` :
        `Run it, and note the id printed. It is **not** one you chose — the
${source} assigns ids itself and ignores any you send. That is worth
knowing before you write code that assumes otherwise.`}

`)

      if (canUpdate) {
        Content(`Now change it. An entity that already carries an id is an update
rather than a create, and \`save$\` decides between the two on exactly
that:

\`\`\`js
  ${subjOne}.${changeFields[0].name} = ${litval(changeFields[0], true)}
  ${subjOne} = await ${subjOne}.save$()

  console.log('updated:', ${subjOne}.${changeFields[0].name})
\`\`\`

`)
      }

      if (canRemove) {
        Content(`And remove it, leaving the ${source} as you found it:

\`\`\`js
  await seneca
    .entity('${canon(subject.name)}')
    .remove$(${oneArg(`${subjOne}.${idf}`)})
\`\`\`

`)
        if (subject.cmds.includes('load')) {
          Content(`Load it once more and, as before, you get \`null\`:

\`\`\`js
  console.log(
    'after remove:',
    await seneca
      .entity('${canon(subject.name)}')
      .load$(${oneArg(`${subjOne}.${idf}`)})
  )   // null
\`\`\`

`)
        }
      }
      else {
        Content(`This entity declares no remove operation, so the record you have just
created stays where it is.

`)
      }

      Content(`Those are the only methods there are:

${cmdList}

They behave the same way on every entity this plugin exposes.

`)
    }

    if (null != child) {
      const ckey = child.parents[0]
      const cidf = 'id'
      const cparent = null == childParent ? 'their parent' :
        `${childParent.name} records`
      const cop = child.cmds.includes('list') ? 'list' : 'load'

      // Live, the parent id comes from a list; offline it is seeded, so a
      // literal is both shorter and exactly reproducible.
      const reuse = `${subjVar}[0].${idf}`
      const cval = offline ? `'${seedParentVal(child, ckey)}'` :
        (null != childParent && childParent.name === subject.name &&
          subject.cmds.includes('list') && 0 === subject.parents.length) ?
          reuse : ident(ckey)

      const cpre = (live && reuse !== cval) ?
        `  const ${plural(childParent.name)} = await seneca
    .entity('${canon(childParent.name)}')
    .list$()
  const ${ident(ckey)} = ${plural(childParent.name)}[0].id

` : ''

      const cargs = child.parents.map((k: string) => k === ckey ?
        `${qkey(k)}: ${cval}` : `${qkey(k)}: '${seedParentVal(child, k)}'`)

      Content(`${step(`Reach the ${child.name} records`)}

${cap(child.name)} records live inside ${cparent}, and the API route
says so:

\`${child.path}\`

The parent id in that path is not optional, so every ${child.name}
call needs a \`${ckey}\` in its query:

\`\`\`js
`)

      if (child.cmds.includes('list')) {
        Content(`${cpre}  const ${plural(child.name)} = await seneca
    .entity('${canon(child.name)}')
    .list$({ ${cargs.join(', ')} })

  console.log('found ' + ${plural(child.name)}.length + ' ${child.name} record(s)')
`)
      }
      else {
        Content(`${cpre}  const found = await seneca
    .entity('${canon(child.name)}')
    .load$({ ${cargs.concat([`${qkey(cidf)}: '${child.name}0'`]).join(', ')} })

  console.log('found', found.${cidf})
`)
      }

      Content(`\`\`\`

Leave the \`${ckey}\` out and the call throws at once, naming the key it
needed, rather than letting a half-built URL come back as a puzzling
404:

\`\`\`js
  // throws: ${provider.pkgName}: ${child.name} ${cop}: ${ckey} is required
  await seneca
    .entity('${canon(child.name)}')
    .${'list' === cop ? 'list$()' : `load$('${child.name}0')`}
\`\`\`

`)
    }

    if (offline) {
      Content(`## Talking to a real server

The script you have just written never touched the network. To point it
at a running ${provider.api} server instead, replace the \`test\` and
\`testopts\` options with that server's base URL:

\`\`\`js
    .use('${provider.pkgName}', {
      sdk: { base: '${hasServer ? provider.liveBase : 'https://api.example.com'}' },
    })
\`\`\`

Nothing else in the script changes — the entity calls are the same
calls. Your seeded ids will not exist there, so read the ids you need
from a \`list$\` first.

`)
      if (hasServer && provider.sdkPinned) {
        Content(`A test server that answers on that address is distributed in the SDK's
source repository, which is the only place it ships. \`make sdk-src\`
fetches that source at the pinned tag; then run \`npm install\`,
\`npm run build\` and \`npm start\` in its \`app\` folder.

`)
      }
    }

    Content(`## What you have learned

You built a script that ${canWrite ? 'reads and writes' : 'reads'}
${provider.api} data through Seneca entities,
${live ? 'against a real server' : 'with no server involved'}. Along
the way you saw:

- Provider configuration has the same shape even when no credentials
  are needed.
- API resources are Seneca entities under \`provider/${provider.lower}/\`,
  reached with the entity API you already know.
`)
    if (null != child || 0 < subject.parents.length) {
      Content(`- A resource nested under another in the API needs its parent's id in
  every query, and says which key is missing when you forget.
`)
    }
    if (subject.cmds.includes('load')) {
      Content(`- \`load$\` answers \`null\` for something that is not there, rather
  than throwing.
`)
    }
    if (canWrite) {
      Content(`- \`save$\` creates without an id and updates with one, and the
  ${true === subject.rkoncreate ?
          `id is the \`${subject.rk}\` the create sends.` :
          `${source} chooses the id.`}
`)
    }
    if (offline) {
      Content(`- The offline store makes all of this runnable with nothing installed
  but npm packages, which is also how you test your own code.
`)
    }

    Content(`
## Where to go next

- To do a specific job — ${live ? 'run without a server' : 'point at a real server'}, reach the raw SDK,
  test your own code — see the [how-to guides](how-to.md).
- To look up an exact pattern, field or option, see the
  [reference](reference.md).
- To understand why the plugin is built this way — why entities rather
  than one message per route, and what it does with the SDK's answers
  — see the [explanation](explanation.md).
- For what each of these documents is for, see the
  [documentation index](README.md).
`)
  })
})



const DocHowto = cmp(function DocHowto(props: any) {
  const { provider } = props

  const ents = provider.entities
  const nested = ents.filter((e: any) => 0 < e.parents.length)

  // The model gives '' when the API definition declares no server. Normalise
  // an absent value to the same thing, so a missing base is treated as absent
  // rather than printed as a default nobody can use.
  const liveBase = provider.liveBase || ''
  const specBase = provider.specBase || ''

  // The same choice the tests and the manual scripts make: fewest parent keys
  // (nothing to arrange), then most cmds. Recipes prefer it, so one entity
  // carries the reader through the document wherever it can.
  const subject = [...ents]
    .sort((a: any, b: any) =>
      (a.parents.length - b.parents.length) || (b.cmds.length - a.cmds.length))[0]

  const forCmd = (cmd: string) => {
    const able = ents.filter((e: any) => e.cmds.includes(cmd))
    return able.find((e: any) => e === subject) ||
      able.find((e: any) => 0 === e.parents.length) ||
      able[0] || null
  }

  const canon = (e: any) => `provider/${provider.lower}/${e.name}`

  // Seneca's key, on every entity: the provider translates it to whatever
  // the API calls it. `apiKey` is that name, for the SDK-direct examples.
  const idf = (_e: any) => 'id'
  const apiKey = (e: any) => e.rk || 'id'
  const modelsId = (e: any) => null != e.ent?.id || null != (e.ent?.fields || {})[apiKey(e)]

  // A parent key's example value. This MIRRORS seedRecord rather than
  // inventing something more readable: the offline recipe below seeds with
  // seedRecord, and an example id that does not match what was seeded turns
  // every other recipe into a lookup that answers null.
  const parentVal = (e: any, k: string) => parentSeed(e, k)

  const parentArgs = (e: any) =>
    e.parents.map((k: string) => `${jsKey(k)}: '${parentVal(e, k)}'`).join(', ')

  // A query naming ONE record. A top-level entity takes the bare id string;
  // a nested one cannot, because it is identified by the whole set of keys.
  const oneArgs = (e: any) => 0 === e.parents.length ?
    `'${e.name}0'` : `{ ${parentArgs(e)}, ${idf(e)}: '${e.name}0' }`

  const listArgs = (e: any) =>
    0 === e.parents.length ? '' : `{ ${parentArgs(e)} }`

  // The SDK's own entity ops always take an object, even for a bare id.
  const sdkLoadArgs = (e: any) => 0 === e.parents.length ?
    `{ ${jsKey(apiKey(e))}: '${e.name}0' }` :
    `{ ${parentArgs(e)}, ${jsKey(apiKey(e))}: '${e.name}0' }`

  const key = (k: string) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : `'${k}'`

  const jsval = (v: any): string => {
    if (null === v || undefined === v) {
      return 'null'
    }
    if ('string' === typeof v) {
      // Escape what would otherwise end the literal early.
      return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`
    }
    if ('number' === typeof v || 'boolean' === typeof v) {
      return String(v)
    }
    if (Array.isArray(v)) {
      return 0 === v.length ? '[]' : '[' + v.map(jsval).join(', ') + ']'
    }
    const ks = Object.keys(v)
    return 0 === ks.length ? '{}' :
      '{ ' + ks.map((k) => `${key(k)}: ${jsval(v[k])}`).join(', ') + ' }'
  }

  const literal = (rec: Record<string, any>) => jsval(rec)

  // What a create sends: the seeded record without its id, because the id is
  // the API's to assign. Parent keys stay — a nested write carries them in
  // the data rather than the query — and so does a key the create request
  // requires, which is the caller's to supply.
  const createData = (e: any) => {
    const rec = seedRecord(e, 0)
    if (true !== e.rkoncreate) {
      delete rec[apiKey(e)]
    }
    delete rec.id
    return rec
  }

  const changeable = (e: any) => e.fields.find((f: any) => changeField(e, f))

  const newValue = (f: any) => 'number' === f.kind ? '999' :
    'boolean' === f.kind ? 'true' : `'${f.name}-changed'`

  const pathParams = (p: string) =>
    (String(p).match(/\{([^}]+)\}/g) || []).map((s: string) => s.slice(1, -1))

  const eList = forCmd('list')
  const eLoad = forCmd('load')
  const forOp = (op: string) => {
    const able = ents.filter((e: any) => e.ops.includes(op))
    return able.find((e: any) => e === subject) ||
      able.find((e: any) => 0 === e.parents.length) ||
      able[0] || null
  }

  const eCreate = forOp('create')
  const eUpdate = forOp('update')
  const eRemove = forCmd('remove')

  // Sections as data, so the contents list and the sections cannot disagree.
  const sections: any[] = []
  const sec = (title: string, body: string) => sections.push({ title, body })

  // GitHub's heading anchors: lowercased, punctuation dropped, spaces
  // hyphenated. Section titles avoid backticks and full stops so this stays
  // a faithful reproduction rather than an approximation.
  const anchor = (title: string) => '#' + title.toLowerCase()
    .replace(/[^a-z0-9 _-]/g, '').trim().replace(/ +/g, '-')

  const NESTED_TITLE = 'Work with nested entities'
  const OFFLINE_TITLE = 'Run offline, without a server'


  if (null != eList) {
    sec('List the records of an entity', `Every resource this plugin covers is a Seneca entity under
\`provider/${provider.lower}/\`, so listing one is \`list$\`:

\`\`\`js
const ${eList.name}s = await seneca
  .entity('${canon(eList)}')
  .list$(${listArgs(eList)})
\`\`\`

You get an ordinary array of Seneca entities back, so \`length\`, \`map\`
and \`data$()\` behave exactly as they do for any other store.

Fields in the query travel to the API as match criteria. Seneca's own
directives — \`sort$\`, \`limit$\` and the rest — are stripped before the
call, because they are features of a database store and not of an HTTP
API. If you need ordering or paging, ask the API for it using fields it
recognises, or sort the returned array yourself.${0 < nested.length ? `

An entity nested under a parent in the API path cannot be listed without
the parent's id; see [${NESTED_TITLE}](${anchor(NESTED_TITLE)}).` : ''}`)
  }


  if (null != eLoad) {
    sec('Read one record by id', `\`load$\` answers a single record:

\`\`\`js
const ${eLoad.name} = await seneca
  .entity('${canon(eLoad)}')
  .load$(${oneArgs(eLoad)})
\`\`\`
${'id' === apiKey(eLoad) ? '' : `
The API addresses \`${eLoad.name}\` records by \`${apiKey(eLoad)}\`; the
provider carries that value as the entity's \`id\`, so the query is the
same as for any other entity.
`}
A record that is not there comes back as \`null\`. It is not an error and
it does not throw, so test the value rather than wrapping the call:

\`\`\`js
const missing = await seneca
  .entity('${canon(eLoad)}')
  .load$(${0 === eLoad.parents.length ? `'nosuch'` :
    `{ ${parentArgs(eLoad)}, ${idf(eLoad)}: 'nosuch' }`})

if (null == missing) {
  // no such ${eLoad.name}
}
\`\`\`

Everything else that can go wrong — a network failure, a 5xx, a rejected
key — does throw, so an unhandled rejection still means something is
genuinely wrong.`)
  }


  if (null != eCreate) {
    const created = literal(createData(eCreate))
    const updates = eCreate.ops.includes('update')

    sec('Create a record', `\`make$\` builds an entity and \`save$\` writes it. ${updates ?
      'An entity with no id\nis a create:' :
      `The API has no update\nfor a \`${eCreate.name}\`, so \`save$\` always creates one, even from an entity\nthat carries an id:`}

\`\`\`js
const ${eCreate.name} = await seneca
  .entity('${canon(eCreate)}')
  .make$(${created})
  .save$()

console.log(${eCreate.name}${modelsId(eCreate) ? '.' + idf(eCreate) : ''})
\`\`\`
${0 === eCreate.parents.length ? '' : `
Note that \`${eCreate.parents.join('`, `')}\` travels in the DATA for a write,
not in a query: a \`${eCreate.name}\` is created inside its parent.
`}
${modelsId(eCreate) ?
      `\`save$\` resolves to the record as the API returned it, which is the only
reliable source of the id. Read it from there rather than predicting it:
what an API does with an id you supply on create is its own business, and
several ignore it entirely.` :
      `\`save$\` resolves to the record as the API returned it. The API definition
declares no id for a \`${eCreate.name}\`, so the record is the only place to
read what identifies one.`}`)
  }


  if (null != eUpdate) {
    const f = changeable(eUpdate)

    sec('Update a record', `${eUpdate.ops.includes('create') ?
      'The same call updates. `save$` dispatches on the id: an entity carrying\none is an update, an entity without one is a create.' :
      `\`save$\` updates: the API has no create for a \`${eUpdate.name}\`.`} So the safe shape is
load, change, save:

\`\`\`js${eUpdate.cmds.includes('load') ? `
const ${eUpdate.name} = await seneca
  .entity('${canon(eUpdate)}')
  .load$(${oneArgs(eUpdate)})
` : `
const ${eUpdate.name} = seneca
  .entity('${canon(eUpdate)}')
  .make$(${literal(0 === eUpdate.parents.length ?
      { [idf(eUpdate)]: `${eUpdate.name}0` } :
      { ...Object.fromEntries(eUpdate.parents.map(
        (k: string) => [k, parentVal(eUpdate, k)])),
      [idf(eUpdate)]: `${eUpdate.name}0` })})
`}${null == f ? `
// change the fields you need
` : `
${eUpdate.name}.${f.name} = ${newValue(f)}
`}
await ${eUpdate.name}.save$()
\`\`\`

Mutating the record you loaded sends it as it stood plus your change, so
you do not depend on how the API treats a request that omits fields —
some merge, some replace.`)
  }


  if (null != eRemove) {
    sec('Remove a record', `\`\`\`js
await seneca
  .entity('${canon(eRemove)}')
  .remove$(${oneArgs(eRemove)})
\`\`\`
${0 === eRemove.parents.length ? '' : `
As with a read, the parent keys are part of naming the record, so they go
in the query object alongside the id.
`}${eRemove.cmds.includes('load') ? `
A \`load$\` of the same id afterwards answers \`null\`.` :
      `
\`remove$\` resolves once the API has accepted the removal.`}`)
  }


  if (0 < nested.length) {
    // A nested entity that declares no cmds has nothing to demonstrate, so
    // prefer one that does; the error example needs a command that exists.
    const n = nested.find((e: any) => 0 < e.cmds.length) || nested[0]
    const firstCmd = n.cmds[0] || 'list'

    sec(NESTED_TITLE, `Some resources live inside a parent, and the API path says so — the
route for \`${n.name}\` is:

\`\`\`
${n.path}
\`\`\`

So a \`${n.name}\` cannot be addressed at all without its parent's id, and
the provider requires those keys on every command.

${nested.map((e: any) =>
      `- \`${e.name}\` requires \`${e.parents.join('`, `')}\``).join('\n')}

For reads the keys go in the query; for writes they go in the data:

\`\`\`js${n.cmds.includes('list') ? `
await seneca.entity('${canon(n)}').list$({ ${parentArgs(n)} })
` : ''}${n.cmds.includes('load') ? `
await seneca.entity('${canon(n)}')
  .load$({ ${parentArgs(n)}, ${idf(n)}: '${n.name}0' })
` : ''}${n.cmds.includes('save') ? `
await seneca.entity('${canon(n)}')
  .make$(${literal(createData(n))})
  .save$()
` : ''}${n.cmds.includes('remove') ? `
await seneca.entity('${canon(n)}')
  .remove$({ ${parentArgs(n)}, ${idf(n)}: '${n.name}0' })
` : ''}\`\`\`

Leave a key out and the call throws at once, naming what is missing:

\`\`\`
${provider.pkgName}: ${n.name} ${firstCmd}: ${n.parents[0]} is required
\`\`\`

That is deliberate: without it the SDK would build half a URL and the
server would answer 404, which is a much harder message to act on. The
[explanation](explanation.md) covers why this is a guard rather than a
silent default.`)
  }


  {
    // Seed the entity the recipes use, plus the first nested entity AND its
    // parent — a child seeded under a parent that is not there lists as
    // empty, which reads as a passing test that proves nothing.
    const seeded: any[] = []
    const add = (e: any) => {
      if (null != e && !seeded.includes(e)) {
        seeded.push(e)
      }
    }
    const child = 0 < nested.length ? nested[0] : null
    const parent = null == child ? null :
      ents.find((p: any) => p.name === child.parentEntity)

    add(subject)
    if (null != child) {
      add(parent)
      add(child)
    }
    seeded.sort((a: any, b: any) => ents.indexOf(a) - ents.indexOf(b))

    const seed = seeded.map((e: any) => `      ${e.name}: {
` + [0, 1].map((i: number) =>
      `        ${e.name}${i}: ${literal(seedRecord(e, i))},`).join('\n') + `
      },`).join('\n')

    sec(OFFLINE_TITLE, `The SDK ships an in-memory mock transport. Turn it on with \`test\` and
seed it with \`testopts\`:

\`\`\`js
.use('${provider.pkgName}', {
  test: true,
  testopts: {
    entity: {
${seed}
    },
  },
})
\`\`\`

Records are keyed by id under their entity name, and the id inside the
record has to match the key it is filed under. Every command then works
offline, not-found included: an id you did not seed answers \`null\`,
exactly as it would against a real server.${null == parent || null == child ? '' : `

A nested record has to point at a parent that is actually seeded: each
\`${child.name}\` above carries \`${child.parents[0]}: '${parentVal(child, child.parents[0])}'\`, and
that is a \`${parent.name}\` the seed contains. Seed a child under a parent
that is not there and its list comes back empty rather than failing —
which, in a test, reads as a pass that proves nothing.`}

This is how this plugin's own suite runs, and it is the recommended way
to test application code that uses the provider: no server, no network,
and the same code path as production. See \`test/seed.js\`, which seeds
every entity this way.`)
  }


  sec('Point at a different server', `The \`sdk\` option is passed straight to the \`${provider.sdkClass}\`
constructor, so \`base\` chooses the host:

\`\`\`js
.use('${provider.pkgName}', {
  sdk: { base: 'https://${provider.lower}.example.com' },
})
\`\`\`

${'' === specBase ?
    `The API definition declares no server, so there is no default worth
relying on: set \`base\` explicitly, or run against the mock instead (see
[${OFFLINE_TITLE}](${anchor(OFFLINE_TITLE)})).` :
    specBase === liveBase ?
      `The SDK's own default is \`${liveBase}\`, which is where the
companion test server listens, so local development usually needs no
\`base\` at all.` :
      `The SDK's own default is \`${specBase}\`, the server the API definition
declares, so \`base\` is needed only to reach another one.`}`)


  if (!provider.authActive) {
    sec('Send an API key', `The ${provider.api} definition declares no authentication, so this plugin
reads no key and adds no credential to any request. The \`apikey\` entry in
the provider configuration is the convention's shape, and stays empty:

\`\`\`js
  .use('provider', {
    provider: {
      ${provider.lower}: {
        keys: {
          apikey: { value: '' },
        },
      },
    },
  })
\`\`\`

To send a header the definition does not describe, supply it through
\`sdk\`; it goes on every request as given:

\`\`\`js
.use('${provider.pkgName}', {
  sdk: { headers: { 'x-api-key': process.env.${provider.ENV}_APIKEY } },
})
\`\`\``)
  }
  else {
    sec('Send an API key', `Credentials are not a plugin option: they come through the provider
convention, so that every provider in an application is configured the
same way. Declare the variable with \`env\` and set the key under this
provider's name:

\`\`\`js
  .use('env', {
    var: { $${provider.ENV}_APIKEY: String${provider.authBasic ?
        `, $${provider.ENV}_SECRET: String` : ''} },
  })
  .use('provider', {
    provider: {
      ${provider.lower}: {
        keys: {
          apikey: { value: '$${provider.ENV}_APIKEY' },${provider.authBasic ? `
          secret: { value: '$${provider.ENV}_SECRET' },` : ''}
        },
      },
    },
  })
\`\`\`

Every request then carries ${credentialWire(provider)}.${provider.authBasic ? `
HTTP Basic needs the pair: with either \`apikey\` or \`secret\` missing, no
credential is sent.` : ''} An absent
or empty key sends no credential at all, so an API that needs none
is configured in exactly the same shape with an empty value — which is
why it is worth writing even when there is nothing to send. An
application that later moves to an authenticated service then changes one
value rather than its structure.

For a different scheme, set the header yourself. Headers supplied through
\`sdk\` win over the one the key would have set:

\`\`\`js
.use('${provider.pkgName}', {
  sdk: { headers: { 'x-api-key': process.env.${provider.ENV}_APIKEY } },
})
\`\`\``)
  }


  sec('Check which plugin and SDK are running', `One message, and the thing to reach for when a deployment is behaving
unexpectedly:

\`\`\`js
const info = await seneca.post(
  'sys:provider,provider:${provider.lower},get:info')
\`\`\`

\`\`\`js
{
  ok: true,
  name: '${provider.lower}',
  version: '${provider.version}',
  sdk: { name: '${provider.sdkPkg}', version: '${provider.sdkVersion}' },
}
\`\`\`

\`version\` is this plugin's; \`sdk.version\` is the SDK it is running
against. That pair is what to quote in a bug report, because the two are
released separately and most surprises live in the gap between them.`)


  {
    const dpe = eList || subject
    const dpath = dpe.path || provider.probePath || '/'
    const dparams = pathParams(dpath)
    const dval = (k: string) => (k === apiKey(dpe) || 'id' === k) ?
      `${dpe.name}0` : `${k.replace(/_id$/, '')}0`

    sec('Reach the SDK directly', `The entity API covers the operations the API model declares. For
anything else — an endpoint with no entity behind it, a response header
you need to read — take the configured SDK client out of the plugin's
exports:

\`\`\`js
const sdk = seneca.export('${provider.pluginName}/sdk')()
\`\`\`

The export is a function, so call it, and it only answers after
\`seneca.ready()\` — that is when the plugin builds the client with the
resolved key.

SDK operations resolve to SDK ENTITY instances rather than plain data, so
read the record out with \`.data()\`. The provider does this for you; here
you do it yourself:

\`\`\`js${dpe.cmds.includes('list') ? `
const ${dpe.name}s = (await sdk.${dpe.acc}().list(${listArgs(dpe)}))
  .map((r) => r.data())
` : ''}${dpe.cmds.includes('load') ? `
const one = (await sdk.${dpe.acc}().load(${sdkLoadArgs(dpe)})).data()
` : ''}\`\`\`

For a route the entity model does not cover at all, \`direct\` sends a
request and hands back the raw response:

\`\`\`js
const res = await sdk.direct({
  path: '${dpath}',
  method: 'GET',${0 === dparams.length ? '' : `
  params: { ${dparams.map((k: string) => `${key(k)}: '${dval(k)}'`).join(', ')} },`}
})

if (res instanceof Error) throw res
if (!res.ok) throw (res.err || new Error('status ' + res.status))

console.log(res.data)
\`\`\`

\`prepare()\` builds the same request without sending it, which is the
quickest way to see what the SDK would actually do — url, method, headers
and body, before anything leaves the process.

Raw data becomes a Seneca entity again through \`data$\`:

\`\`\`js
const ent = seneca.entity('${canon(dpe)}').data$(res.data)
\`\`\``)
  }


  sec('Develop against a local SDK checkout', `The SDK is an ordinary published dependency, so normal use needs nothing
special:

\`\`\`sh
$ npm install
\`\`\`

If you are changing the SDK and this plugin together, point npm at a
local checkout instead. \`make sdk-src\` fetches the SDK this repository is
generated from — the repository and tag in \`sdk-pin.json\` — into
\`${provider.sdkSrc}\`, then build it, because it does not commit its build
output:

\`\`\`sh
$ make sdk-src
$ cd ${provider.sdkSrc}/ts
$ npm install && npm run build
\`\`\`

Already have that checkout elsewhere? Point the same target at it:

\`\`\`sh
$ make sdk-src SDK_SRC_FROM=../path/to/your/checkout
\`\`\`

Then link it in, without committing the change to \`package.json\`:

\`\`\`sh
$ npm install --no-save ${provider.sdkSrc}/ts
\`\`\`

npm creates a symlink, so a rebuild of the SDK is picked up here with no
reinstall:

\`\`\`sh
$ ls -l node_modules/${provider.sdkPkg}
\`\`\`

To go back to the published SDK:

\`\`\`sh
$ rm -rf node_modules/${provider.sdkPkg} package-lock.json && npm install
\`\`\`

Removing the lockfile matters. npm will happily keep resolving to the
link if the lockfile still records it and the local version satisfies the
range.`)


  {
    const pattern = subject.cmds.includes('load') ? `${subject.name}-load` :
      subject.cmds.includes('list') ? `${subject.name}-list` : 'happy'
    const skipped = subject.cmds.includes('list') ?
      `${subject.name}-list` : `${subject.name}-load-missing`

    sec('Run the test suite', `\`\`\`sh
$ npm run build
$ npm test
\`\`\`

The build comes first: the suite runs against \`dist\`, so an unbuilt
change is not the change you are testing.

The offline tests use the SDK mock and always run.${'' === liveBase ? '' : ` The live tests
probe for a server first and skip cleanly when there is none, so a clean
checkout is green on a machine that has never started one:

\`\`\`
﹣ ${skipped} # no ${provider.lower} server at ${liveBase}
\`\`\``}

Coverage, and a single test by name:

\`\`\`sh
$ npm run test-coverage
$ TEST_PATTERN=${pattern} npm run test-some
\`\`\``)
  }


  if ('' !== liveBase) {
    sec('Run the live tests against a server', `The companion test server ships only in the SDK's source repository, not
in the published package. \`make sdk-src\` fetches that source at the pinned
tag; the server is in its \`app\` folder:

\`\`\`sh
$ make sdk-src
$ cd ${provider.sdkSrc}/app
$ npm install && npm run build && npm start
\`\`\`

Then run the suite as usual: the live tests find the server and activate
themselves.

\`\`\`sh
$ npm test
\`\`\`

To target a server somewhere else:

\`\`\`sh
$ ${provider.ENV}_TEST_BASE=http://localhost:9000 npm test
\`\`\`

The generated live tests only read, so a run leaves the server exactly as
it found it.${subject.cmds.includes('save') && subject.cmds.includes('remove') ? `

Two manual scripts are there for poking at a running server by hand:

\`\`\`sh
$ node test/live.js     # read from each entity
$ node test/quick.js    # a full write cycle, cleaning up after itself
\`\`\`` : `

\`node test/live.js\` reads from each entity, for poking at a running
server by hand.`}`)
  }


  sec('Build and release', `\`\`\`sh
$ npm run build      # tsc --build src test
$ npm run watch      # the same, in watch mode
$ npm run reset      # clean, install, build, test
\`\`\`

Releasing follows the Seneca convention, in one command — clean, install,
build, test, tag from \`package.json\`, publish:

\`\`\`sh
$ npm run repo-publish
\`\`\`

Only \`dist\`, the TypeScript sources and the licence file are published;
the test suite and its build output stay in the repository.

${'npm' === provider.sdkDepKind ?
    `Before publishing, check that \`package.json\` still depends on the
published SDK by version range and not on a local path: a \`file:\`
dependency left behind from local development installs perfectly on your
own machine and cannot be resolved by anybody else.` :
    `Publish the SDK to npm first. \`package.json\` depends on it as
\`${provider.sdkDep}\`, which everyone installing this package would
have to fetch${'git' === provider.sdkDepKind ? ' with git' : ''}. Then drop \`sdk.dep\` from the model, regenerate,
and check that the dependency is a version range.`}

One last thing: this repository is GENERATED from the ${provider.api} API
model by [@voxgig/sdkgen](https://github.com/voxgig/sdkgen). An edit made
here survives exactly as long as the next generation run. Change the
model, or the components that build this target, and regenerate.`)


  File({ name: 'how-to.md' }, () => {
    Content(`# How-to guides

Each guide here solves one problem, and assumes you already have a
working Seneca instance with this plugin loaded. If you do not, work
through the [tutorial](tutorial.md) first.

These guides show what to do and leave out the reasoning — that is in the
[explanation](explanation.md), and the exact patterns, fields and options
are listed in the [reference](reference.md).

`)

    each(sections, (s: any) => {
      Content(`- [${s.title}](${anchor(s.title)})
`)
    })

    each(sections, (s: any) => {
      Content(`
## ${s.title}

${s.body}
`)
    })
  })
})



const DocReference = cmp(function DocReference(props: any) {
  const { provider } = props

  // The entities exposing a custom action. Empty for an API whose every
  // route is CRUD, and the reference says so rather than omitting the
  // section — a reader who has seen `action$` elsewhere needs to be told it
  // has nothing to select here.
  const acting = provider.entities.filter((e: any) => 0 < e.actionList.length)

  const subject = [...provider.entities]
    .sort((a: any, b: any) =>
      (a.parents.length - b.parents.length) || (b.cmds.length - a.cmds.length))[0]

  const nested = provider.entities.filter((e: any) => 0 < e.parents.length)
  const saving = provider.entities.filter((e: any) => e.cmds.includes('save'))

  // Entities whose API offers BOTH create and update: only for those does
  // `save$` dispatch on the id. Where it offers one, saying otherwise is wrong.
  const dispatch = saving.filter((e: any) =>
    e.ops.includes('create') && e.ops.includes('update'))
  const oneway = saving.filter((e: any) => !dispatch.includes(e))

  const anyCmd = (c: string) => provider.entities.some((e: any) => e.cmds.includes(c))
  const anyOp = (o: string) => saving.some((e: any) => e.ops.includes(o))

  const live = '' !== provider.liveBase

  const quick = live && subject.cmds.includes('save') && subject.cmds.includes('remove')

  const canon = (e: any) => `provider/${provider.lower}/${e.name}`

  const cmdList = (e: any) => e.cmds.map((c: string) => '`' + c + '$`').join(', ')

  const keys = (list: string[]) => '`' + list.join('`, `') + '`'

  // The same list as prose: `a`, `b` and `c`.
  const keysAnd = (list: string[]) => 1 === list.length ? keys(list) :
    `${keys(list.slice(0, -1))} and \`${list[list.length - 1]}\``

  // A query literal for the docs: parent keys first, then whatever else the
  // command needs.
  const query = (e: any, extra: string[]) =>
    `{ ${[...e.parents, ...extra].map((k: string) => `${jsKey(k)}: '...'`).join(', ')} }`

  // How a single record is addressed. The `load$('x')` short form only works
  // when the id field is literally `id`.
  const oneArg = (e: any) => 0 < e.parents.length ? query(e, ['id']) : `'...'`

  const apiKeyOf = (e: any) => 0 < idPartsOf(e).length ?
    idPartsOf(e).join(String(e.idsep || '/')) : (e.rk || 'id')

  // The required-key phrasing, which has to read correctly for one key as
  // well as several.
  const reqd = (list: string[]) =>
    1 === list.length ? `${keys(list)} **required**` :
      2 === list.length ? `\`${list[0]}\` and \`${list[1]}\`, both **required**` :
        `${keys(list)}, all **required**`

  // The example used in the error block: whichever command the subject has.
  const errCall = subject.cmds.includes('list') ?
    `list$(${0 < subject.parents.length ? query(subject, []) : ''})` :
    subject.cmds.includes('load') ? `load$(${oneArg(subject)})` :
      subject.cmds.includes('remove') ? `remove$(${oneArg(subject)})` :
        'make$({ ... }).save$()'

  File({ name: 'reference.md' }, () => {
    Content(`# Reference

Complete description of the interface exposed by
\`${provider.pkgName}\` version ${provider.version}.

This document describes the machinery and assumes you know what you are
looking for. To learn the plugin, start with the [tutorial](tutorial.md);
for recipes, see the [how-to guides](how-to.md); for the reasoning behind
the design, see the [explanation](explanation.md). The package overview is
the [README](../README.md), and the document index is [here](README.md).

- [Requirements](#requirements)
- [Registration](#registration)
- [Options](#options)
- [Entities](#entities)
- [Actions](#actions)
- [Action patterns](#action-patterns)
- [Plugin exports](#plugin-exports)
- [Errors](#errors)
- [Authentication keys](#authentication-keys)
- [Environment variables](#environment-variables)
- [Package scripts](#package-scripts)

## Requirements

| Item | Value |
| ---- | ----- |
| Node.js | \`>=24\` |
| Module format | CommonJS |
| SDK | [\`${provider.sdkPkg}\`](https://www.npmjs.com/package/${provider.sdkPkg}) \`^${provider.sdkVersion}\` |

The SDK is an ordinary published dependency, installed by \`npm install\`
like any other.
`)

    if (live) {
      Content(`
The companion **test server** used by the live tests is a separate matter:
it ships only in the SDK's [source repository](${provider.sdkRepoUrl}) under
\`app/\`, and is not published. It is needed only to run the live tests —
see the [how-to guides](how-to.md).
`)
    }

    Content(`
### Peer dependencies

All must be present in the host application. The accepted version ranges are
declared in this package's \`package.json\`.

| Package | Purpose |
| ------- | ------- |
| \`seneca\` | The host framework. The plugin runs inside the host's instance, never its own. |
| \`seneca-entity\` | The entity API the canons below are served through. |
| \`seneca-promisify\` | The promise-returning message API. |
| \`@seneca/provider\` | The provider convention, including \`provider/entityBuilder\`. |
| \`@seneca/env\` | Resolves \`$\`-prefixed key values from the environment. |

## Registration

The plugin name is \`${provider.pluginName}\`. It must be registered after
\`entity\`, \`promisify\` and \`provider\`:

\`\`\`js
Seneca({ legacy: false })
  .use('promisify')
  .use('entity')
  .use('provider', { ... })
`)

    if (live) {
      Content(`  .use('${provider.pkgName}', { sdk: { base: '${provider.liveBase}' } })
\`\`\`
`)
    }
    else if ('' !== provider.specBase) {
      Content(`  .use('${provider.pkgName}')
\`\`\`

The SDK's default base URL is \`${provider.specBase}\`, the server the
${provider.api} definition declares. Pass \`sdk: { base }\` to reach another.
`)
    }
    else {
      Content(`  .use('${provider.pkgName}', { sdk: { base: BASE } })
\`\`\`

The ${provider.api} definition declares no server, so there is no default
base URL: \`BASE\` is the URL of the API you are talking to, and it must be
supplied through the \`sdk\` option.
`)
    }

    Content(`
The SDK client is constructed during plugin startup and is not available
until \`seneca.ready()\` resolves.

## Options

| Option | Type | Default | Effect |
| ------ | ---- | ------- | ------ |
| \`sdk\` | object | \`{}\` | Passed straight to the \`${provider.sdkClass}\` constructor. Most usefully \`base\`. |
| \`test\` | boolean | \`false\` | Run the SDK against its in-memory mock transport instead of HTTP. |
| \`testopts\` | object | \`{}\` | Test-feature options, used only when \`test\` is true. \`{entity: {...}}\` seeds the mock. |

### \`sdk\`

Any option the \`${provider.sdkClass}\` constructor accepts:

| Key | Effect |
| --- | ------ |
| \`base\` | Base URL for API requests. ${'' !== provider.specBase ?
      `The SDK's own default is \`${provider.specBase}\`, the server the API definition declares.` :
      'There is no default: this API declares no server, so it must be set.'} |
| \`prefix\` / \`suffix\` | URL fragments placed around the path. |
| \`headers\` | Headers sent on every request. These win over the \`authorization\` header the provider adds from a configured key. |
| \`system\` | System overrides, e.g. a custom \`fetch\`. |

### \`test\` and \`testopts\`

\`\`\`js
.use('${provider.pkgName}', {
  test: true,
  testopts: {
    entity: {
`)
    each(provider.entities, (e: any) => {
      Content(`      ${e.name}: { ${e.name}0: ${JSON.stringify(seedRecord(e, 0))} },
`)
    })
    Content(`    },
  },
})
\`\`\`

Mock records are keyed by id under their entity name. In this mode no
network calls are made, and an unseeded id produces the same not-found
behaviour as a live server. This package's own \`test/seed.js\` is generated
in exactly this shape.
`)

    if (0 < nested.length) {
      Content(`
A nested record's parent key must name a record the parent entity also
seeds: the mock resolves the path literally, so an unmatched parent id
yields nothing rather than an error.
`)
    }

    Content(`
## Entities

The plugin registers ${1 === provider.entities.length ?
      'one entity canon' : `${provider.entities.length} entity canons`}.
A canon carries only the commands its API operations support — an entity the
API offers no delete for has no \`remove$\` — so the tables below are the
whole of what each one answers.

| Seneca canon | SDK accessor | Route | API key | Parent keys | Commands |
| ------------ | ------------ | ----- | ------- | ----------- | -------- |
`)
    each(provider.entities, (e: any) => {
      Content(`| \`${canon(e)}\` | \`sdk.${e.acc}()\` | \`${e.path}\` | \`${apiKeyOf(e)}\` | ${0 < e.parents.length ?
        keys(e.parents) : '—'} | ${cmdList(e)} |
`)
    })

    each(provider.entities, (e: any) => {
      const hasCreate = e.ops.includes('create')
      const hasUpdate = e.ops.includes('update')

      Content(`
### \`${canon(e)}\`

Backed by \`sdk.${e.acc}()\`, whose results are \`${e.cls}\` instances; the
provider hands Seneca the plain record from \`.data()\`.
`)

      if (0 < e.parents.length) {
        Content(`
\`${e.name}\` is nested under \`${e.path}\` in the API, so **every**
\`${e.name}\` command requires ${keysAnd(e.parents)}. Omitting one throws —
\`${provider.pkgName}: ${e.name} <cmd>: ${e.parents[0]} is required\` —
before any request is made, rather than issuing one that would 404.
`)
      }

      Content(`
| Command | Query / data | Returns |
| ------- | ------------ | ------- |
`)
      if (e.cmds.includes('list')) {
        Content(`| \`list$(q)\` | ${0 < e.parents.length ?
          `${reqd(e.parents)}, plus optional match fields` :
          'optional match fields'} | Array of \`${e.name}\` entities. |
`)
      }
      if (e.cmds.includes('load')) {
        Content(loadHasKey(e) ?
          `| \`load$(q)\` | ${reqd([...e.parents, 'id'])} | One \`${e.name}\`, or \`null\` if not found. |
` : `| \`load$(q)\` | ${0 < e.parents.length ? reqd(e.parents) : 'nothing: the route names no record'} | The one \`${e.name}\`, or \`null\` when \`id\` names one it does not carry. |
`)
      }
      if (e.cmds.includes('save')) {
        Content(`| \`save$()\` | entity data${0 < e.parents.length ?
          `, including ${keysAnd(e.parents)}` : ''} | ${hasCreate && hasUpdate ?
            `Created or updated \`${e.name}\`.` : hasCreate ?
              `Created \`${e.name}\`; the API declares no update operation.` :
              `Updated \`${e.name}\`; the API declares no create operation.`} |
`)
      }
      if (e.cmds.includes('remove')) {
        Content(`| \`remove$(q)\` | ${reqd([...e.parents, 'id'])} | \`null\`. |
`)
      }

      if ('id' !== apiKeyOf(e)) {
        Content(`
The API ${e.ops.some((op: string) => ['load', 'remove', 'update'].includes(op)) ?
          'addresses' : 'identifies'} \`${e.name}\` records by \`${apiKeyOf(e)}\`; the provider
carries that value as the entity's \`id\`, so every query and entity above
uses \`id\`. A record the API returns with an unrelated \`id\` of its own
${false === e.parkfree ?
          `keeps it where it is: \`${provider.lower}_id\`, where this provider
would otherwise park it, is a name \`${e.name}\` itself uses.` :
          `keeps that under \`${provider.lower}_id\`.`}
`)
      }

      if (0 === e.fields.length) {
        Content(`
The API definition declares no required fields for this entity; whatever it
returns is passed through unchanged.
`)
      }
      else {
        Content(`
Required fields, as declared by the API definition. Optional fields the API
also defines are passed through unchanged in both directions.

| Field | Type | Notes |
| ----- | ---- | ----- |
`)
        each(e.fields, (f: any) => {
          Content(`| \`${f.name}\` | ${f.kind}${f.nullable ? ' or null' : ''} | ${f.name === (e.rk || 'id') ?
            ('id' === f.name ? 'Id field.' : 'API key; carried as the entity\'s `id`.') :
            e.parents.includes(f.name) ? ('' === f.parentEntity ?
              'Parent key. Required by every command.' :
              `Parent key: the id of a \`${f.parentEntity}\`. Required by every command.`) : ''} |
`)
        })
      }

      if (e.cmds.includes('list') || e.cmds.includes('load')) {
        Content(`
\`\`\`js
`)
        if (e.cmds.includes('list')) {
          Content(`const ${e.name}s = await seneca
  .entity('${canon(e)}')
  .list$(${0 < e.parents.length ? query(e, []) : ''})
`)
        }
        if (e.cmds.includes('load')) {
          Content(`const ${e.name} = await seneca
  .entity('${canon(e)}')
  .load$(${oneArg(e)})
`)
        }
        Content(`\`\`\`
`)
      }
    })

    if (0 < dispatch.length) {
      // The dispatching entity to show it with: the subject when it qualifies,
      // otherwise the first that does.
      const s = dispatch.includes(subject) ? subject : dispatch[0]
      const writable = s.fields.filter((f: any) => ownField(s, f))
      const alterable = writable.filter((f: any) => changeField(s, f))
      const value = (f: any, alt: boolean) => 'number' === f.kind ?
        (alt ? '4321' : '1234') : 'boolean' === f.kind ?
          (alt ? 'true' : 'false') : `'${f.name}${alt ? '-changed' : '-value'}'`
      const make = [
        ...s.parents.map((k: string) => `${jsKey(k)}: '...'`),
        ...writable.map((f: any) => `${jsKey(f.name)}: ${value(f, false)}`),
      ].join(', ')

      Content(`
### Create versus update

\`save$\` follows the Seneca convention: an entity **without** an id is
created, an entity **with** one is updated. The provider dispatches on the
id field, so the same call does both.

\`\`\`js
// Create — no id.
const ${s.name} = await seneca
  .entity('${canon(s)}')
  .make$({ ${make} })
  .save$()

// Update — id present.
${0 < alterable.length ? `${s.name}.${alterable[0].name} = ${value(alterable[0], true)}
` : ''}await ${s.name}.save$()
\`\`\`

Whether a client-supplied id survives a create is a property of the API, not
of this plugin: many assign the id themselves and ignore the one sent. Read
the id back off the returned entity rather than assuming the one you set.
`)
    }

    if (0 < oneway.length) {
      if (0 === dispatch.length) {
        Content(`
### Create versus update

\`save$\` normally dispatches on the id: an entity without one is created,
an entity with one is updated.
`)
      }

      Content(`
${1 === oneway.length ?
        'This entity supports only one half of that pair, so `save$` does not' :
        'These entities support only one half of that pair, so `save$` does not'}
dispatch for ${1 === oneway.length ? 'it' : 'them'}:

| Canon | Behaviour of \`save$\` |
| ----- | -------------------- |
`)
      each(oneway, (e: any) => {
        Content(`| \`${canon(e)}\` | Always ${e.ops.includes('create') ? 'creates' : 'updates'}; the API declares no ${e.ops.includes('create') ? 'update' : 'create'} operation. |
`)
      })
    }

    Content(`
### Command to SDK operation

| Seneca command | SDK call | Notes |
| -------------- | -------- | ----- |
`)
    if (anyCmd('list')) {
      Content(`| \`list$(q)\` | \`.list(q)\` | Query keys are passed through as match fields. |
`)
    }
    if (anyCmd('load')) {
      Content(`| \`load$(q)\` | \`.load({ ...keys })\` | Only the keys the route needs are sent. |
`)
    }
    if (anyOp('create')) {
      Content(`| \`save$()\` on an entity with no id | \`.create(data)\` | Data is the entity's own fields, without Seneca metadata. |
`)
    }
    if (anyOp('update')) {
      Content(`| \`save$()\` on an entity with an id | \`.update(data)\` | |
`)
    }
    if (anyCmd('remove')) {
      Content(`| \`remove$(q)\` | \`.remove({ ...keys })\` | Resolves to \`null\` whatever the API returns. |
`)
    }

    Content(`
Every SDK operation resolves to an SDK entity instance, or a list of them,
rather than raw data. The provider calls \`.data()\` on each and hands the
plain record to \`entize\`, so what comes back is an ordinary Seneca entity
under this plugin's canon, carrying none of the SDK's own markers.

### Query fields

Seneca query directives — any key ending in \`$\`, such as \`sort$\` or
\`limit$\` — are stripped before the query reaches the SDK. They are
instructions to a store, not match fields for the API, and are not
otherwise supported.

\`action$\` is the one this plugin reads. It is stripped from the match
fields like the rest, but it is read FIRST, and it selects a custom API
action instead of the plain command. See
[Actions](#actions) below.

### Actions
${0 === acting.length ? `
This API declares no custom actions: every route is one of the five CRUD
operations, so \`action$\` has nothing to select and naming one throws.
` : `
An action is an API route folded into an ordinary operation as an
alternative point — a verb that is not create, read, update or delete.
Select one with the \`action$\` directive; the rest of the call is that
action's own payload.

| Entity | Action | Route | Operation | Command |
| --- | --- | --- | --- | --- |
${acting.map((e: any) => e.actionList.map((a: any) =>
  `| \`${e.name}\` | \`${a.action}\` | \`${a.path}\` | \`${a.op}\` | \`${a.cmd}$\` |`)
  .join('\n')).join('\n')}

On a read command (\`list$\`, \`load$\`, \`remove$\`) \`action$\` is a key of
the query. On \`save$\` it is a directive on the entity, set with
\`directive$({ action$: '...' })\` or assigned as a property —
\`make$({ action$ })\` does NOT work, because \`seneca-entity\`'s \`make$\`
drops any trailing-\`$\` key it does not know by name.

Routing is by the operation the action belongs to, not by the command:
\`save$\` covers both create and update, so an action folded into \`create\`
is called as a create even when the entity carries an id.

An action name the entity does not have throws, naming the entity, the
command and the valid actions. It never falls back to the plain command.
`}

## Action patterns

### \`sys:provider,provider:${provider.lower},get:info\`

Returns metadata about the plugin and SDK. Answered locally; makes no API
call.

\`\`\`js
await seneca.post('sys:provider,provider:${provider.lower},get:info')
\`\`\`

\`\`\`js
{
  ok: true,
  name: '${provider.lower}',
  version: '${provider.version}',
  sdk: {
    name: '${provider.sdkPkg}',
    version: '${provider.sdkVersion}',
  },
}
\`\`\`

Both versions are read at runtime from the respective \`package.json\`, so
they describe what is installed rather than what was generated.

### Entity patterns

Registered by \`@seneca/provider\`. Normally reached through the entity API
rather than posted directly.

| Pattern |
| ------- |
`)
    each(provider.entities, (e: any) => {
      Content(e.cmds
        .map((c: string) =>
          `| \`sys:entity,zone:provider,base:${provider.lower},name:${e.name},cmd:${c}\` |\n`)
        .join(''))
    })

    Content(`
### Inherited from \`@seneca/provider\`

| Pattern | Purpose |
| ------- | ------- |
| \`sys:provider,get:key\` | Fetch one named key for a provider. |
| \`sys:provider,get:keymap\` | Fetch all keys for a provider. |
| \`sys:provider,list:provider\` | List registered providers and their key names. |

## Plugin exports

### \`${provider.pluginName}/sdk\`

A function returning the configured \`${provider.sdkClass}\` instance.

\`\`\`js
const sdk = seneca.export('${provider.pluginName}/sdk')()
`)
    if (subject.ops.includes('list')) {
      Content(`
// Every SDK operation resolves to an SDK entity (or a list of them),
// not raw data; \`.data()\` gives the plain record.
const ${subject.name}s = (await sdk.${subject.acc}().list()).map((e) => e.data())
`)
    }
    if ('' !== provider.probePath) {
      Content(`
// \`direct\` reaches endpoints outside the entity model.
const res = await sdk.direct({ path: '${provider.probePath}', method: 'GET' })
`)
    }
    Content(`\`\`\`

Available only after \`seneca.ready()\`. Use it for SDK features the entity
API does not surface — notably \`direct()\` and \`prepare()\` for endpoints
the entity model does not cover.

## Errors

| Situation | Behaviour |
| --------- | --------- |
`)
    if (anyCmd('load')) {
      Content(`| \`load$\` for a non-existent id | Resolves to \`null\`. |
`)
    }
    if (anyCmd('remove')) {
      Content(`| \`remove$\` for a non-existent id | Resolves to \`null\`; not an error. |
`)
    }
    if (0 < nested.length) {
      Content(`| A nested entity command missing a parent key | Throws before any request is made. |
`)
    }
    if (anyCmd('list') || anyCmd('save')) {
      Content(`| A 404 from \`${[anyCmd('list') ? 'list$' : '', anyCmd('save') ? 'save$' : ''].filter((s: string) => '' !== s).join('` or `')}\` | Thrown. Only single-record reads and removes map a 404 to \`null\`. |
`)
    }
    Content(`| Any other non-2xx response | Thrown as raised by the SDK. |
| A request that never got a response | Thrown, with \`status\` \`-1\`. |

SDK errors are \`${provider.Name}Error\` instances carrying
\`is${provider.Name}Error: true\`, a \`code\` (e.g. \`request_status\`), the
HTTP \`status\` at the top level (\`-1\` when the request never got a
response), a \`notFound\` flag, and a \`ctx\` holding the request context and
its \`result\` — \`status\`, \`statusText\`, \`headers\` and \`body\`. The
\`null\`-on-missing behaviour is triggered by \`err.notFound\`, not by
inspecting the status at the call site.

\`\`\`js
try {
  await seneca.entity('${canon(subject)}').${errCall}
}
catch (err) {
  console.error(err.code, err.status, err.notFound)
}
\`\`\`
`)

    if (0 < nested.length) {
      Content(`
The missing-parent-key guard is this plugin's own, thrown before the SDK is
called at all. Its message names the entity, the command and the key:

| Entity | Message |
| ------ | ------- |
`)
      each(nested, (e: any) => {
        Content(e.parents
          .map((k: string) =>
            `| \`${e.name}\` | \`${provider.pkgName}: ${e.name} <cmd>: ${k} is required\` |\n`)
          .join(''))
      })
      Content(`
where \`<cmd>\` is the command that was called. A key counts as missing if
it is absent, \`null\` or the empty string.
`)
    }

    Content(`
## Authentication keys
${!provider.authActive ? `
The ${provider.api} definition declares no authentication. The plugin reads
no key and adds no credential to any request: \`sys:provider,get:keymap\` is
never posted. An \`apikey\` configured under this provider's name is
accepted, for uniformity with other providers, and ignored.
` : `
The plugin follows the provider convention: if an \`apikey\` key is
configured and non-empty, it is sent as ${credentialWire(provider)} on every
request.${provider.authBasic ? ` HTTP Basic needs a second key, \`secret\`; with
either missing, no credential is sent.` : ''} If the provider is not
registered, or the key is absent or empty, no credential is added and
startup proceeds with a warning in the log.

\`\`\`js
  .use('provider', {
    provider: {
      ${provider.lower}: {
        keys: {
          apikey: { value: '$${provider.ENV}_APIKEY' },${provider.authBasic ? `
          secret: { value: '$${provider.ENV}_SECRET' },` : ''}
        },
      },
    },
  })
\`\`\`

The key is read once, during \`seneca.prepare()\`, by posting
\`sys:provider,get:keymap,provider:${provider.lower}\`. A header supplied
through the \`sdk.headers\` option takes precedence over the one the key
would set.
`}
## Environment variables

The plugin never reads the environment itself. These are the variables the
surrounding convention and tooling resolve:

| Variable | Read by | Purpose |
| -------- | ------- | ------- |
| \`$${provider.ENV}_APIKEY\` | \`@seneca/env\` | Supplies the \`apikey\` value when the key is declared as \`'$${provider.ENV}_APIKEY'\`, as above. |
`)
    if (live) {
      Content(`| \`$${provider.ENV}_TEST_BASE\` | The test suite and the manual scripts | Base URL for the live tests. Defaults to \`${provider.liveBase}\`. |
`)
    }

    Content(`
## Package scripts

| Script | Action |
| ------ | ------ |
| \`npm run build\` | \`tsc --build src test\` — compiles to \`dist\` and \`dist-test\`. |
| \`npm run watch\` | The same, in watch mode. |
| \`npm test\` | Runs the \`node:test\` suite. |
| \`npm run test-some\` | Runs tests matching \`$TEST_PATTERN\`. |
| \`npm run test-watch\` | Test suite in watch mode. |
| \`npm run test-coverage\` | Test suite with Node's built-in coverage. |
| \`npm run clean\` | Removes \`node_modules\`, \`dist\`, \`dist-test\`, \`.tsbuildinfo\`, lockfiles. |
| \`npm run reset\` | \`clean\`, then install, build and test. |
| \`npm run repo-tag\` | Commits, tags and pushes \`v<version>\` taken from \`package.json\`. |
| \`npm run repo-publish\` | Clean install, then \`repo-publish-quick\`. |
| \`npm run repo-publish-quick\` | Build, test, tag, and publish to npm. |

### Repository layout

| Path | Contents |
| ---- | -------- |
| \`src/\` | TypeScript source, with its own \`tsconfig.json\`. |
| \`test/\` | Test suite (\`.js\`, run by \`node:test\`) and TypeScript fixtures. |
| \`dist/\` | Compiled source. Committed; published. |
| \`dist-test/\` | Compiled test fixtures. Committed; **not** published. |
| \`.tsbuildinfo/\` | Incremental build cache. Not committed. |
| \`doc/\` | This documentation. |

This repository is generated by
[@voxgig/sdkgen](https://github.com/voxgig/sdkgen) from the ${provider.api}
API definition. Anything edited here is overwritten by the next generation
run; changes belong in the model.
`)

    if (live) {
      const listable = provider.entities
        .filter((e: any) => e.cmds.includes('list'))
        .map((e: any) => e.name)

      Content(`
### Manual scripts

Not part of \`npm test\`: they need the companion test server, which is
distributed only in the SDK's source repository.

| Script | Purpose |
| ------ | ------ |
`)
      Content(`| \`node test/live.js\` | ${0 < listable.length ?
        `Read ${listable.join(', ')} from a running server.` :
        'Reads from a running server; no entity here supports `list$`, so it does nothing.'} |
`)
      if (quick) {
        Content(`| \`node test/quick.js\` | Exercise the full write cycle on \`${subject.name}\`, cleaning up after itself. |
`)
      }
      Content(`
${quick ? 'Both scripts target' : 'It targets'} \`$${provider.ENV}_TEST_BASE\`, defaulting to
\`${provider.liveBase}\`.
`)
    }
  })
})



const DocExplanation = cmp(function DocExplanation(props: any) {
  const { provider } = props

  const subject = [...provider.entities]
    .sort((a: any, b: any) =>
      (a.parents.length - b.parents.length) || (b.cmds.length - a.cmds.length))[0]

  const nested = provider.entities.filter((e: any) => 0 < e.parents.length)
  const writable = provider.entities.filter((e: any) => e.cmds.includes('save'))
  const loadable = provider.entities.filter((e: any) => e.cmds.includes('load'))
  const removable = provider.entities.filter((e: any) => e.cmds.includes('remove'))

  // Entities where `save` has nothing to dispatch on, because the API offers
  // only one of create/update. Worth naming: their `save$` ignores the id
  // rule the rest of this document explains.
  const onesided = writable.filter((e: any) =>
    !(e.ops.includes('create') && e.ops.includes('update')))

  const code = (s: string) => '`' + s + '`'
  const list = (names: string[]) => names.map(code).join(', ')

  // What the offline suite actually covers, so the prose does not claim a
  // `load` test for an entity that has no load.
  const covered: string[] = []
  if (subject.cmds.includes('list')) covered.push('list')
  if (subject.cmds.includes('load')) covered.push('load', 'the not-found answer')
  if (0 < nested.length) covered.push('the nested-entity rules')
  const coveredPhrase = 0 < covered.length ? ` — ${covered.join(', ')} —` : ''

  const othersSentence = 1 < provider.entities.length ?
    'The other entities carry whatever their own operations support; the\n' +
    '[reference](reference.md) lists them all.' :
    'It is the only entity this API declares, and the\n' +
    '[reference](reference.md) spells its commands out.'

  // The nesting section names the parent entity when the model knows it, and
  // falls back to the path params when a parent key points at nothing declared.
  const n = nested[0]
  const nestLead = null == n ? '' :
    '' !== n.parentEntity ?
      `The API nests ${code(n.name)} under ${code(n.parentEntity)}: a ` +
      `${code(n.name)}'s URL contains its ${code(n.parentEntity)}.` :
      `The API nests ${code(n.name)} under a parent resource: a ` +
      `${code(n.name)}'s URL contains ${list(n.parents)}.`

  File({ name: 'explanation.md' }, () => {
    Content(`# Explanation

This document discusses why \`${provider.pkgName}\` is built the way it is.
It does not tell you how to do anything — for that see the
[tutorial](tutorial.md) and the [how-to guides](how-to.md), and for the exact
patterns, entities and options, the [reference](reference.md). The whole set is
indexed in [doc/README.md](README.md).


## The provider convention

Seneca applications talk to the outside world through *providers*. A provider
is a plugin that makes a third-party API look like a Seneca data source, so
application code uses the entity API it already knows instead of learning a
client library per service.

The payoff is uniformity. An application reading from ${provider.api}, a
payment processor and a CRM uses one access pattern for all three:

\`\`\`js
await seneca.entity('provider/${provider.lower}/${subject.name}').list$()
await seneca.entity('provider/stripe/charge').list$()
\`\`\`

Because these are ordinary Seneca entities, everything built on the entity API
— logging, tracing, message interception, test doubles — applies to remote
calls without any special support for HTTP.


## What entityBuilder buys

The convention is more than a naming scheme. \`@seneca/provider\` exports
\`provider/entityBuilder\`, and this plugin hands it exactly one thing: a map
from entity name to a small set of cmd actions. Recognising the
\`provider/${provider.lower}/\` canon, registering the \`role:entity\` messages
that sit behind \`list$\`, \`load$\`, \`save$\` and \`remove$\`, and turning
whatever an action returns into an entity of the right canon — none of that is
written here. It arrives with the convention.

What remains is a handful of async functions, each a few lines long, whose
whole job is to call the SDK and hand the result back through the \`entize\`
function entityBuilder supplies. That thinness is the point rather than an
accident of effort: a provider that is nearly all glue can be read at a glance,
generated in full, and regenerated when the API moves. Cleverness added here is
cleverness that has to be maintained against a moving target.


## Two layers of the same idea

This provider is unusual among Seneca providers in that the thing it wraps is
*already* entity-shaped. The ${provider.api} SDK exposes accessors like
\`client.${subject.acc}()\` — carrying
${list(subject.ops)} —
rather than raw HTTP routes, for much the same reason Seneca does. A small,
uniform surface is easier for people and for agents to reason about than a set
of URL templates.

So the provider is mostly a translation between two entity models that already
agree on the important things. Where they *disagree* is where this plugin has
to do real work, and each disagreement is discussed below.


## Where the SDK and Seneca disagree

### Four commands, five operations

Seneca's store commands are \`list\`, \`load\`, \`save\` and \`remove\`. The
SDK's operations are \`list\`, \`load\`, \`create\`, \`update\` and \`remove\`.
Four of the five line up. \`save\` is the join, and it dispatches on the id: an
entity carrying one is an update, an entity without one is a create.

`)

    if (0 < writable.length) {
      Content(`That is Seneca's convention rather than this plugin's invention, and it is a
good one. Exposing create and update separately would push the HTTP verb back
into application code — the caller who loaded a record, changed a field and
called \`save$\` would have to know whether that becomes a POST or a PUT. The
presence of the id already answers the question. Asking the caller to answer it
again only adds a way to be wrong.

`)
    }

    Content(`Which commands exist at all is decided per entity, from the operations the API
declares, rather than from an assumption that everything is CRUD.
\`${subject.name}\` carries
${list(subject.cmds.map((c: string) => c + '$'))}.
${othersSentence}
An entity whose API has no create and no update simply has no \`save$\`, which
is a better answer than a \`save$\` that exists and then fails at the HTTP
layer.

`)

    if (0 < onesided.length) {
      Content(`Where an entity declares only one of create and update there is nothing to
dispatch on, and \`save$\` means that operation whether an id is present or not:

`)
      each(onesided, (e: any) => {
        Content(`- \`${e.name}\`: \`save$\` always ${e.ops.includes('create') ? 'creates' : 'updates'}
`)
      })
      Content(`
`)
    }

    Content(`### Entity instances versus plain data

Every SDK operation resolves to an SDK entity instance, never to raw data:
\`list\` to a list of them, and each single-record operation to one. The record
is absorbed into the instance and read back through \`.data()\`.${0 < removable.length ?
      ` A removed\nentity is the same instance, marked deleted, still holding what it held.` : ''}

Seneca's \`entize\` wants plain data, so the provider takes the \`.data()\` hop
on everything the SDK hands back, before it goes anywhere near an entity. That
is the whole of the \`plain\` helper in the source, and it is the only place in
the plugin that knows the SDK deals in instances at all.

The hop earns its keep for a second reason. An SDK instance carries its own
serialisation marker, and that marker must not survive into a Seneca entity:
Seneca reads \`entity$\` on a data object as the *canon*. A marker landing on
that key would be taken as a canon, and the record would come back under the
wrong one — or under none. The SDK namespaces its marker so the collision
cannot happen by accident, but normalising at this boundary is still the right
call. It is what makes the data plain, and it keeps the provider independent of
whatever the SDK decides to carry alongside a record.

`)

    if (0 < loadable.length) {
      Content(`### Missing things

\`load$\` for an id that does not exist resolves to \`null\`. Only a 404 is
translated this way; every other failure propagates.

"This thing does not exist" is an ordinary answer to a lookup, not a failure of
the lookup. It is usually a branch in the caller's logic, and forcing every call
site into a \`try\`/\`catch\` to express that branch makes the common path noisy.
A malformed request, a rejected credential or an unreachable server means
something else entirely: the question could not be asked, and that should
interrupt rather than quietly look like an empty result.

The SDK does not draw this line — it throws for any non-2xx — so the provider
asks the thrown error, which reports \`notFound\` and the HTTP \`status\` at the
top level. That coupling to the SDK's error shape is a deliberate and narrow
one, and it is why the shape is written down in the
[reference](reference.md).

`)

      if (0 < removable.length) {
        Content(`\`remove$\` is treated the same way and for the same reason: removing something
that is already gone leaves the caller with what the caller wanted.

`)
      }
    }
    else if (0 < removable.length) {
      Content(`### Missing things

Nothing here reads a single record by id, but \`remove$\` still has to decide
what "it was not there" means, and it treats a 404 as an ordinary outcome rather
than a failure: the record is gone, which is what the caller asked for. Every
other failure — a malformed request, a rejected credential, an unreachable
server — means the question could not be asked at all, and propagates.

The SDK does not draw that line; it throws for any non-2xx. So the provider asks
the thrown error, which reports \`notFound\` and the HTTP \`status\` at the top
level. That coupling to the SDK's error shape is a deliberate and narrow one,
and it is why the shape is written down in the [reference](reference.md).

`)
    }

    if (0 < nested.length) {
      Content(`### Nesting

${nestLead}
Seneca's entity model is flat — a canon has no notion of a parent.

The gap is bridged by putting the parent id in the query, which is why
\`${n.parents[0]}\` is required on every \`${n.name}\` command${n.cmds.includes('load') ?
        `, and why\n\`${n.name}\` \`load$\` takes an object rather than a bare id string` : ''}.
This is inherited from the API's URL structure — \`${n.path}\` — rather than
chosen here.

The provider checks for \`${n.parents[0]}\` itself and throws a named error
rather than letting the request go out. Without the check, the SDK builds a URL
with a missing segment and the server answers 404${n.cmds.includes('load') ?
        `, and that 404 is\nindistinguishable from "that ${n.name} does not exist" — which the provider\nwould then dutifully translate to \`null\`. A forgotten argument would look\nexactly like an empty result` :
        ` — an opaque failure that says\nnothing about the argument that was left out`}. Failing early turns a confusing
wrong answer into an obvious mistake.

`)
      if (1 < nested.length) {
        Content(`The same applies to every nested entity here —
${list(nested.map((e: any) => e.name))} — each guarded on its own keys.

`)
      }
    }

    Content(`### Query directives

Seneca store queries can carry directives such as \`sort$\` and \`limit$\`.
These are instructions to a *store*, and the API has no equivalent, so the
provider strips any key ending in \`$\` before the query becomes an API match.

Passing them through would be worse than dropping them: the SDK would forward
them as ordinary match fields, and the API would either ignore them or reject
the request outright. Dropping them is imperfect too — a caller who writes
\`list$({ sort$: 'name' })\` gets unsorted results and no complaint — but it is
the behaviour least likely to produce a wrong answer, and the limitation is
documented rather than hidden. Sorting and limiting belong on the caller's
side, or in the API's own query fields where it has them.


`)

    if (0 < writable.length) {
      Content(`## Why writes are supported here

The read-only question is worth asking of every provider, and the answer here
follows from the API rather than from taste.

Writes map cleanly onto entities only when the API's notion of "save" is
unambiguous. For a CMS with draft states, localised fields and a separate
publish step, \`save$\` would have to pick one interpretation and would mislead
whoever guessed differently. Here the write operations are plain whole-record
ones, so \`save$\` can mean exactly one thing for each of
${list(writable.map((e: any) => e.name))}, and the store surface those
operations support is implemented in full.

One wrinkle does not map cleanly. Seneca's model lets a caller choose an id;
many APIs assign ids themselves and ignore any id sent on create. The provider
does not try to paper over that, because it cannot make a server honour an id
it did not issue. Code that predicts the id of a record it is about to create
will be wrong on such an API, and the remedy is to read the id back from what
\`save$\` returns rather than to guess it beforehand.


`)
    }
    else {
      Content(`## Why this provider only reads

Every entity here exposes reads alone. That is not a policy decision taken in
the plugin: the cmd map is built from the operations the API declares, and none
of these entities declares a create or an update. A \`save$\` that existed only
to fail at the HTTP layer would be worse than no \`save$\` at all — the absence
is the honest signal, and it appears in the entity table in the
[reference](reference.md).

If the API grows write operations, they arrive here by regeneration rather than
by hand. Nothing about the mapping is waiting to be written.


`)
    }

    Content(provider.authActive ? `## Credentials, whether or not the API needs them

At startup the plugin asks \`@seneca/provider\` for the keymap of
\`${provider.lower}\` and sends the \`apikey\` as ${credentialWire(provider)}
when one is configured.
` : `## Credentials, for an API that declares none

The ${provider.api} definition declares no authentication, so the plugin
plumbs no credential: it does not ask \`@seneca/provider\` for a keymap at
startup, and adds nothing to a request. The SDK's own auth stage is empty
for such a definition, so a key handed to it could not reach the wire.
`)
    Content(`
The key is *optional*. Absent, unconfigured and empty all mean "send no
header", and none of them is an error. For an API that needs no credential this
looks like ceremony, and it is worth keeping anyway: the shape of a Seneca
application should not depend on whether a particular service happens to need a
key. An application that moves from an open endpoint to an authenticated
deployment then changes one configuration value rather than restructuring how
the plugin loads — and a provider that demanded a key from an API that has none
would force every user to invent a fake one.


## Depending on a published SDK

The SDK is an ordinary published dependency: \`${provider.sdkPkg}\` at
\`^${provider.sdkVersion}\`, resolved by npm like anything else.

The alternative is vendoring — copying the generated client into this
repository. That is tempting, since both artefacts come from the same model and
change together. It is also wrong. It makes a second copy of something that is
regenerated whenever the API moves, and it puts this plugin's release cycle in
charge of the API's. As a dependency, the SDK carries its own semantic version:
when the API changes, the SDK is versioned, and this plugin either follows the
range or pins until it is ready. Keeping them separable also matters to the
people who use the SDK with no Seneca anywhere in sight.

One consequence of depending on generated code is worth stating plainly. The
SDK is regenerated as the API model changes, so its surface can shift in ways a
hand-written library's would not. That argues for keeping this plugin thin, and
for pinning behaviour in tests. Everything this plugin knows about the SDK's
shapes is concentrated in three small functions — the \`.data()\` hop, the query
cleaner and the not-found translation — plus the construction of the client, so
an SDK change is absorbed in one place and surfaces as a failing offline test
rather than as a surprise in production.

`)

    if ('' === provider.liveBase) {
      Content(`${'' === provider.specBase ?
        `The API definition declares no server, so this plugin has no default host: the
base URL arrives through the \`sdk.base\` option, supplied by whoever configures
the plugin for a particular deployment. The tests therefore run entirely
against the SDK's mock transport, which is the one host that is always
available.` :
        `The SDK's default host is \`${provider.specBase}\`, the server the API
definition declares, and the \`sdk.base\` option points the plugin at another.
Nothing declares a test server, so the tests run entirely against the SDK's
mock transport, which is the one host that is always available.`}


`)
    }
    else {
      Content(`The distinction that does survive is between the SDK and its **test server**.
The SDK is published; the server is not, and ships only in
[the SDK's source repository](${provider.sdkRepoUrl}). So the offline tests need
nothing but \`npm install\`, while the live tests need a clone. That asymmetry
is why the live tests probe for the server and skip rather than fail: the common
case is a contributor who has the dependency but not the repository.


`)
    }

    Content(`## A generated plugin

Nothing in this repository is hand-written. The plugin source, its tests, its CI
workflow, its manifest and these documents are all emitted by
[@voxgig/sdkgen](https://github.com/voxgig/sdkgen) from the ${provider.api} API
model — the same model the SDK is generated from, which is why the two cannot
disagree about entity names, id fields, or which operations exist.

There is one blunt consequence for anyone reading the code and reaching for an
edit: the edit will not survive. The next generation run overwrites this
repository, without a merge and without a warning. A fix applied here is a fix
that has to be applied again, silently, forever.

The source of truth is the SDK project's model — the repository and tag named
in \`sdk-pin.json\`, which \`make sdk-src\` fetches to \`${provider.sdkSrc}\` —
together with the sdkgen component that emits this target.${provider.standalone ? `
This repository builds itself: the builder in \`.sdk/\` carries a copy of that
SDK's API definition, which \`make regen\` refreshes from the fetched source,
and generation refuses to write when the copy no longer matches it.` : ''} A change to *what*
the API offers belongs in the model; a change to
*how* the provider expresses it belongs in the component. Both are versioned,
both regenerate every provider built this way rather than just this one, and
both are where a fix is worth making. See
[Contributing](../README.md#contributing).


## How the tests are arranged

The suite runs offline by default. It needs no credentials and no network.

The **offline** tests use the SDK's own mock transport, reached through this
plugin's own options:

\`\`\`js
.use('${provider.pkgName}', {
  test: true,
  testopts: { entity: { ${subject.name}: { '${subject.name}0': { ... } } } },
})
\`\`\`

This is better than the usual provider-testing compromise. Rather than checking
only that the plugin loads and answers
\`sys:provider,provider:${provider.lower},get:info\`, the tests exercise the
entity commands themselves${coveredPhrase}
through the real code path, from a Seneca entity call down to the transport and
back. The only thing replaced is the socket. And because the mock belongs to the
SDK, it stays honest as the SDK changes: a regeneration that alters a return
shape breaks a test here rather than someone's production run.

Seeding the mock is not decoration either. The seed is generated from the same
model as the entities, so the records the tests read carry the fields the API
would really return${0 < nested.length ? `, and a nested record's parent id
names a parent record that exists — otherwise the nested tests would read an
empty store and pass without proving anything` : ''}.

`)

    if ('' !== provider.liveBase) {
      Content(`The **live** tests point at the companion server in the SDK repository and probe
it before running, skipping with a stated reason when nothing answers. So a
contributor who has just cloned this repository gets a meaningful result
immediately, and a more thorough one after starting the server.

Skipping is deliberate, and preferred over quietly returning early. An early
\`return\` reports a test as *passed*, which makes an unconfigured checkout look
as though it verified the integration when it verified nothing at all. A skip is
honest about coverage, and the summary count shows how much did not run.

`)

      if (subject.cmds.includes('save') && subject.cmds.includes('remove')) {
        Content(`The manual scripts in \`test/\` that write to a live server remove what they
create, in a \`finally\` block, so the server is left as it was found. A run that
leaks a record changes the result of the next one, which is how a suite becomes
order-dependent and then flaky.
`)
      }
    }
  })
})



const DocIndex = cmp(function DocIndex(props: any) {
  const { provider } = props

  File({ name: 'README.md' }, () => {
    Content(`# Documentation

The documentation for \`${provider.pkgName}\` follows the
[Diátaxis](https://diataxis.fr) framework. Each document serves one purpose,
and that purpose decides what belongs in it. If you are unsure where to look,
use the table below.

| Document | Purpose | Read it when |
| -------- | ------- | ------------ |
| [Tutorial](tutorial.md) | Learning-oriented. A lesson that takes you from nothing to a working script. | You have never used this plugin and want to see it work. |
| [How-to guides](how-to.md) | Task-oriented. Recipes that solve one problem each. | You know what you want to do and need the steps. |
| [Reference](reference.md) | Information-oriented. A complete, factual description of the interface. | You need to look up a message pattern, entity field, or option. |
| [Explanation](explanation.md) | Understanding-oriented. The reasoning behind the design. | You want to know *why* it works this way, or you are debugging something surprising. |

## The distinction that matters most

The tutorial and the how-to guides look alike — both are sequences of steps —
but they are not interchangeable.

The **tutorial** is a lesson. It is safe to follow, it produces a result you
can see, and it asks you to make no decisions. Its job is to build confidence,
so it deliberately avoids alternatives and edge cases.

A **how-to guide** assumes competence. It answers "how do I list every record
of a collection?", and it assumes you already have a working Seneca instance.
Its job is to get a task done, so it omits the explanation.

Likewise **reference** describes the machinery and nothing else — it never
teaches. **Explanation** discusses and gives context — it never instructs.

## These documents are generated

This plugin, and this documentation with it, is generated by
[@voxgig/sdkgen](https://github.com/voxgig/sdkgen) from the ${provider.api} API
definition held in the [SDK project](${provider.sdkRepoUrl}). An edit made here
is lost on the next regeneration.

Something genuinely specific to this API — a quirk of its authentication, a
rate limit worth warning about — belongs in the model the generator reads, not
in the output it writes. Everything else belongs in the generator's own
components, where fixing it once fixes every provider.
`)
  })
})


const Docs = cmp(function Docs(props: any) {
  const { provider } = props

  Folder({ name: 'doc' }, () => {
    DocIndex({ provider })
    DocTutorial({ provider })
    DocHowto({ provider })
    DocReference({ provider })
    DocExplanation({ provider })
  })
})


export {
  Tests,
  Scripts,
  Workflow,
  Readme,
  Docs,
  seedRecord,
  parentSeed,
  SdkPin,
  SDK_SRC_DIR,
}
