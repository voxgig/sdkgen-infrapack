import Path from 'node:path'

import {
  entityOps, packageName, packageVersion,
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


function entitySurface(model: any): Record<string, string> {
  const coll = model?.main?.[KIT]?.entity || {}
  const out: Record<string, string> = {}

  for (const name of Object.keys(coll).sort()) {
    const ent = coll[name]
    if (null != ent && false !== ent.active) {
      out[name] = 'ops ' + (entityOps(ent).join(',') || '-') +
        '; fields ' + (Object.keys(ent.fields || {}).sort().join(',') || '-')
    }
  }

  return out
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

  const here = entitySurface(model)
  const there = entitySurface(sdk)

  for (const name of [...new Set([...Object.keys(here), ...Object.keys(there)])].sort()) {
    if (here[name] !== there[name]) {
      problems.push('entity ' + name + ': here ' + (here[name] || 'absent') +
        '; SDK ' + (there[name] || 'absent'))
    }
  }

  if (0 < problems.length) {
    throw new SdkGenError(
      'seneca-provider: this builder\'s model does not match the SDK it ' +
      'depends on, as fetched to ' + provider.sdkSrc + ':\n  ' +
      problems.join('\n  ') +
      '\n`make regen` copies the SDK\'s API definition and guide into .sdk/ ' +
      'before generating. A difference that remains comes from a decision in ' +
      'the SDK project\'s own model: declare the same in ' +
      '.sdk/model/project.aontu.')
  }
}


export {
  standaloneBuilder,
  sdkIdentity,
  entitySurface,
  checkSdkSource,
}
