import Path from 'node:path'

import {
  packageName, packageVersion,
  SdkGenError,
} from '@voxgig/sdkgen'

import {
  KIT,
} from '@voxgig/apidef'


// `output: root: true` means this repository's own `.sdk/` is the builder:
// the SDK is released elsewhere, and is not a target of this project.
function standaloneBuilder(target: any): boolean {
  return true === target?.output?.root
}


function sdkIdentity(model: any, target: any):
  { sdkPkg: string, sdkVersion: string } {
  const sdk = target?.sdk || {}
  const pkg = String(sdk.package || '')
  const version = String(sdk.version || '')
  const hasTs = null != model?.main?.[KIT]?.target?.ts

  if (!standaloneBuilder(target)) {
    if ('' !== pkg || '' !== version) {
      throw new SdkGenError(
        target.name + ': `sdk.package` and `sdk.version` apply only to a ' +
        'provider generated at the root of its own repository (`output: ' +
        'root: true`). Generated from the SDK project, the SDK is its `ts` ' +
        'target: set `main.' + KIT + '.target.ts.publish.version` instead.')
    }
    return { sdkPkg: packageName(model, 'npm'), sdkVersion: packageVersion(model, 'ts') }
  }

  if ('' === version && !hasTs) {
    throw new SdkGenError(
      target.name + ': name the SDK version this provider depends on, as ' +
      '`main.' + KIT + '.target.' + target.name + '.sdk.version`. Its ' +
      'builder has no `ts` target to read it from, and a default would pin ' +
      'whatever version it happens to be.')
  }

  return {
    sdkPkg: '' !== pkg ? pkg : packageName(model, 'npm'),
    sdkVersion: '' !== version ? version : packageVersion(model, 'ts'),
  }
}


// What the SDK was generated from and the provider reads: titles,
// descriptions and contract metadata are left out.
const FIELD_KEYS = ['n', 't', 'r', 'a', 'ro', 'wo', 'fo']
const POINT_KEYS = ['a', 'k', 'm', 'o', 's', 'r', 't', 'g', 'q', 'gq']

function pick(obj: any, keys: string[]): Record<string, any> {
  const out: Record<string, any> = {}
  for (const key of keys) {
    if (undefined !== obj?.[key]) {
      out[key] = obj[key]
    }
  }
  return out
}


// Keyed by path under `main.kit`, so a difference names where to look.
function apiSurface(model: any): Record<string, any> {
  const kit = model?.main?.[KIT] || {}
  const out: Record<string, any> = {
    info: {
      auth: kit.info?.auth,
      security: kit.info?.security,
      servers: (kit.info?.servers || []).map((server: any) => pick(server, ['url'])),
    },
    config: { auth: kit.config?.auth },
  }

  const coll = kit.entity || {}
  for (const name of Object.keys(coll).sort()) {
    const ent = coll[name]
    if (null != ent && false !== ent.active) {
      out['entity.' + name] = {
        id: ent.id,
        alias: ent.alias,
        relations: { ancestors: ent.relations?.ancestors },
        fields: Object.fromEntries(Object.entries(ent.fields || {})
          .map(([key, field]) => [key, pick(field, FIELD_KEYS)])),
        op: Object.fromEntries(Object.entries(ent.op || {})
          .map(([key, op]: [string, any]) => [key, {
            input: op?.input,
            points: (op?.points || []).map((point: any) => pick(point, POINT_KEYS)),
          }])),
      }
    }
  }

  return out
}


function brief(value: any): string {
  const text = undefined === value ? 'absent' : JSON.stringify(value)
  return 60 < text.length ? text.slice(0, 57) + '...' : text
}


// Keys ending in `$` are the generator's marks, present only on a live model.
function differences(here: any, there: any, path: string, out: string[]): void {
  const node = (value: any) => null != value && 'object' === typeof value
  if (node(here) && node(there) && Array.isArray(here) === Array.isArray(there)) {
    const keys = Array.isArray(here) ?
      Array.from({ length: Math.max(here.length, there.length) }, (_, i) => i) :
      [...new Set([...Object.keys(here), ...Object.keys(there)])]
        .filter((key) => !key.endsWith('$')).sort()
    for (const key of keys) {
      differences(here[key], there[key], Array.isArray(here) ?
        path + '[' + key + ']' : path + '.' + key, out)
    }
  }
  else if (JSON.stringify(here) !== JSON.stringify(there)) {
    out.push(path + ': here ' + brief(here) + ', SDK ' + brief(there))
  }
}


// The builder carries its own copy of the SDK's API definition, right only
// while it matches the SDK at the version depended on. `make sdk-src` fetches
// that SDK, whose compiled model is the comparison.
function checkSdkSource(ctx$: any, provider: any, model: any): void {
  const fs = ctx$.fs()
  const rel = provider.sdkSrc + '/.sdk/model/sdk.json'
  const file = Path.join(ctx$.folder || '.', rel)

  if (!fs.existsSync(file)) {
    ctx$.log?.warn?.({
      point: 'sdk-source-unchecked', file: rel,
      note: 'seneca-provider: ' + rel + ' is absent, so this model was NOT ' +
        'checked against ' + provider.sdkPkg + ' ' + provider.sdkVersion +
        '. `make sdk-src` fetches it.'
    })
    return
  }

  const sdk = JSON.parse(String(fs.readFileSync(file, 'utf8')))
  const problems: string[] = []

  // The SDK's own manifest, when fetched: this builder's naming rule need not
  // be the one that built the SDK.
  const manifestFile = Path.join(ctx$.folder || '.', provider.sdkSrc, 'ts', 'package.json')
  const manifest = fs.existsSync(manifestFile) ?
    JSON.parse(String(fs.readFileSync(manifestFile, 'utf8'))) : {}

  const sdkVersion = String(manifest.version || packageVersion(sdk, 'ts'))
  if (sdkVersion !== provider.sdkVersion) {
    problems.push('version: this provider depends on ' + provider.sdkVersion +
      ', the fetched SDK is ' + sdkVersion +
      ' (make regen SDK_TAG=v' + provider.sdkVersion + ')')
  }

  const sdkPkg = String(manifest.name || packageName(sdk, 'npm'))
  if (sdkPkg !== provider.sdkPkg) {
    problems.push('package: this provider depends on ' + provider.sdkPkg +
      ', the fetched SDK is ' + sdkPkg)
  }

  const here = apiSurface(model)
  const there = apiSurface(sdk)

  for (const part of [...new Set([...Object.keys(here), ...Object.keys(there)])].sort()) {
    const found: string[] = []
    differences(here[part], there[part], part, found)
    problems.push(...found.slice(0, 5))
    if (5 < found.length) {
      problems.push(part + ': and ' + (found.length - 5) + ' more')
    }
  }

  if (0 < problems.length) {
    throw new SdkGenError(
      'seneca-provider: this builder\'s model does not match the SDK it ' +
      'depends on, as fetched to ' + provider.sdkSrc + ' (paths under main.' +
      KIT + '):\n  ' +
      problems.join('\n  ') +
      '\n`make regen` replaces the API definition and guide in .sdk/ with the ' +
      'SDK\'s before generating. A difference that remains comes from a decision in ' +
      'the SDK project\'s own model, to be declared the same way in ' +
      '.sdk/model/project.aontu, or from an @voxgig/apidef version other ' +
      'than the one in the SDK\'s .sdk/package.json.')
  }
}


export {
  standaloneBuilder,
  sdkIdentity,
  apiSurface,
  checkSdkSource,
}
