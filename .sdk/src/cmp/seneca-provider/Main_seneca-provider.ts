import {
  cmp, each,
  File, Content, Copy, Folder,
  entityCollection, entityOps, entityIdField, entityDataIdField, entityClassName,
  entityActions,
  opRequestShape, opParams, ownPoint, entityPath,
  collectDeps, repoInfo, packageName, packageVersion, apiName, envName,
  authorInfo, contributorList, isAuthActive, isHttpBasicAuth, jsKey, jsProp,
  resolveAuthIn, resolveAuthName, resolveAuthPrefix,
  SdkGenError,
  PUBLISHER, PUBLISHER_URL,
  pointSegments,
} from '@voxgig/sdkgen'

import {
  KIT,
} from '@voxgig/apidef'

import {
  Tests, Scripts, Workflow, Readme, Docs, SdkPin, SDK_SRC_DIR,
} from './Extras_seneca-provider'
import { Gitignore } from './Gitignore_seneca-provider'
import { Makefile } from './Makefile_seneca-provider'
import {
  standaloneBuilder, sdkIdentity, checkSdkSource,
} from './Standalone_seneca-provider'




const CMD_OPS: Record<string, string[]> = {
  list: ['list'],
  load: ['load'],
  save: ['create', 'update'],
  remove: ['remove'],
}


function cmdActions(ent: any, cmd: string): Record<string, string> {
  const ops = CMD_OPS[cmd] || []

  // ACTIVE ops only, for the same reason `parentKeys` uses `entityOps`: an op
  // the model marks `active: false` generates no SDK method, so an action
  // folded into it is not reachable and must not be advertised as if it were.
  const live = entityOps(ent)
  const out: Record<string, string> = {}

  // `null == out[a.action]` on a plain object reads Object's PROTOTYPE for a
  // name like `toString` or `constructor`, finds a function, and concludes
  // the name is already claimed — dropping a modelled action that happens to
  // carry one. Ask whether the map itself has the key.
  const claimed = (name: string) =>
    Object.prototype.hasOwnProperty.call(out, name)

  for (const a of entityActions(ent)) {
    if (ops.includes(a.op) && live.includes(a.op) && !claimed(a.action)) {
      out[a.action] = a.op
    }
  }

  return out
}


function canonicalOps(ent: any): string[] {
  return entityOps(ent).filter((opname: string) => {
    const op = (ent.op || {})[opname]
    const points: any[] = (op && op.points) || []

    return points.some((pt: any) =>
      null == (pt && pt.q && pt.q['$action']))
  })
}


// Every action the entity exposes, with the cmd that reaches it — for the
// README and the generated tests, which describe the entity rather than one
// call. `cmd` is what a Seneca user types; `op` is what the SDK is asked for.
function entityActionList(ent: any):
  { cmd: string, op: string, action: string, path: string }[] {
  const out: { cmd: string, op: string, action: string, path: string }[] = []

  for (const cmd of Object.keys(CMD_OPS).sort()) {
    const map = cmdActions(ent, cmd)
    for (const a of entityActions(ent)) {
      if (map[a.action] === a.op) {
        out.push({ cmd, op: a.op, action: a.action, path: a.path })
      }
    }
  }

  return out
}


function requiredKeys(ent: any, opname: string): string[] {
  const idf = entityIdField(ent)
  return opRequestShape(ent, opname).items
    .filter((it: any) => !it.optional)
    .map((it: any) => it.name)
    .sort((a: string, b: string) => (a === idf ? 0 : 1) - (b === idf ? 0 : 1))
}


// The keys a single-record call actually sends: the op's required keys, plus
// the record's own key when the match declares it at all. One definition,
// because the handler emitter and the test emitter disagreeing about it is
// how a test comes to assert something the generated code never does.
function addressKeys(ent: any, opname: string): string[] {
  const keys = requiredKeys(ent, opname)
  const parts = idParts(ent)

  if (0 < parts.length) {
    const shape = opRequestShape(ent, opname).items
    for (const part of parts) {
      if (!keys.includes(part) &&
        shape.some((it: any) => it.name === part)) {
        keys.push(part)
      }
    }
    return keys
  }

  const rk = recordKey(ent)
  if (null != rk && '' !== rk && !keys.includes(rk) &&
    opRequestShape(ent, opname).items.some((it: any) => it.name === rk)) {
    keys.push(rk)
  }

  return keys
}


function idParts(ent: any): string[] {
  const parts = ent?.id?.parts
  return Array.isArray(parts) && 1 < parts.length ?
    parts.map((p: any) => String(p)) : []
}


function idSep(ent: any): string {
  const sep = ent?.id?.sep
  return null != sep && '' !== String(sep) ? String(sep) : '/'
}


function idSpec(ent: any): { parts: string[], sep: string, from?: Record<string, string> } | null {
  const parts = idParts(ent)
  if (0 < parts.length) {
    const from = ent?.id?.from
    return {
      parts,
      sep: idSep(ent),
      ...(null != from && 'object' === typeof from ? { from } : {}),
    }
  }

  const rk = recordKey(ent)
  if ('id' === rk) {
    return null
  }

  const from = ent?.id?.from
  const path = null != from && 'object' === typeof from ? from[rk] : null
  return {
    parts: [rk],
    sep: idSep(ent),
    ...(null != path && '' !== String(path) ? { from: { [rk]: String(path) } } : {}),
  }
}


// The model's identifier when the load match carries it, else the terminal
// path parameter, else a lone required query parameter: the rule the SDK's
// offline transport keys its store by.
function recordKey(ent: any): string {
  const idf = entityIdField(ent)
  if (null != idf && '' !== idf) {
    return String(idf)
  }

  let fallback = ''

  for (const opname of ['load', 'remove', 'update']) {
    const op = (ent.op || {})[opname]
    if (null == op || 0 === (op.points || []).length) {
      continue
    }

    const canonical = op.points.filter((pt: any) =>
      null == (pt && pt.q && pt.q['$action']))
    const point = ownPoint(0 < canonical.length ? canonical : op.points)
    const segs = pointSegments(point)
    const last = segs[segs.length - 1]

    if (null != last && null != last.var) {
      return String(last.var)
    }

    const query = (point && point.g && point.g.query) || []
    const reqdQuery = query.filter((q: any) => false !== q.r)
    if (1 === reqdQuery.length) {
      return String(reqdQuery[0].n)
    }

    // A literal-terminal route names a facet of a record: a last resort.
    if ('' === fallback) {
      const vars = segs.filter((seg: any) => null != seg.var)
      if (0 < vars.length) {
        fallback = String(vars[vars.length - 1].var)
      }
    }
  }

  return '' !== fallback ? fallback : (entityDataIdField(ent) || 'id')
}


// Does a create have to SEND the record key, or does the API assign it?
function rkOnCreate(ent: any): boolean {
  const rk = recordKey(ent)

  if ('id' === rk || 0 < idParts(ent).length || null == (ent.op || {}).create) {
    return false
  }

  return opRequestShape(ent, 'create').items
    .some((it: any) => it.name === rk && !it.optional)
}


// Is `<provider>_id` free for this entity, or a name it already uses itself?
function parkFree(ent: any, parked: string): boolean {
  const taken = new Set<string>([
    recordKey(ent),
    ...idParts(ent),
    ...parentKeys(ent),
    ...Object.values(ent.fields || {}).map((f: any) => String(f.n)),
  ])

  return !taken.has(parked)
}


function guardName(e: any, key: string): string {
  return `need_${e.name}_${String(key).replace(/[^A-Za-z0-9_$]/g, '_')}`
    .replace(/^need_(\d)/, 'need__$1')
}


function opParentKeys(ent: any, opname: string): string[] {
  const rk = recordKey(ent)
  const op = (ent.op || {})[opname]

  if (null == op) {
    return []
  }

  const seen = new Set<string>()

  for (const p of opParams(op)) {
    const name = String((p as any).n)
    if (false !== (p as any).r && name !== rk && name !== 'id') {
      seen.add(name)
    }
  }

  return [...seen].sort()
}


function parentKeys(ent: any): string[] {
  const seen = new Set<string>()

  for (const opname of entityOps(ent)) {
    for (const key of opParentKeys(ent, opname)) {
      seen.add(key)
    }
  }

  return [...seen].sort()
}


const sentinelKey = (type: any): string =>
  String(type ?? '').replace(/[`$]/g, '').trim().toUpperCase()

const unionMembers = (type: any): any[] =>
  Array.isArray(type) && 'ONE' === sentinelKey(type[0]) && Array.isArray(type[1]) ?
    type[1] : []


function fieldKind(type: any): string {
  if (Array.isArray(type)) {
    const member = unionMembers(type).find((m: any) => 'NULL' !== sentinelKey(m))
    return null == member ? 'string' : fieldKind(member)
  }

  const t = String(type || '').toUpperCase()

  if (t.includes('ARRAY') || t.includes('LIST')) return 'array'
  if (t.includes('OBJECT') || t.includes('MAP')) return 'object'
  if (t.includes('BOOLEAN')) return 'boolean'
  if (t.includes('NUMBER') || t.includes('INTEGER')) return 'number'

  return 'string'
}


function fieldNullable(type: any): boolean {
  return unionMembers(type).some((m: any) => 'NULL' === sentinelKey(m))
}


function parentEntityOf(key: string, names: string[]): string {
  const stem = key.replace(/_id$/, '')
  return names.includes(stem) ? stem : ''
}


function providerRepo(model: any, lower: string, tname: string):
  { url: string, path: string, host: string } {
  const host = model?.main?.[KIT]?.repo?.host || 'github.com'
  const declared = model?.main?.[KIT]?.target?.[tname]?.output?.repo
  const path = null != declared && '' !== declared ?
    String(declared) : `senecajs/seneca-${lower}-provider`

  return { url: `https://${host}/${path}`, path, host }
}


// The provider's published package name: the project's pin when it has one,
// else `@seneca/<name>-provider`. packageName() cannot answer this — its
// derivations are all SDK-shaped (`@<origin>/<slug>-sdk`).
function providerPackage(model: any, lower: string, tname: string): string {
  const declared = model?.main?.[KIT]?.target?.[tname]
    ?.publish?.registry?.package
  return null != declared && '' !== declared ?
    String(declared) : `@seneca/${lower}-provider`
}


const Main = cmp(function Main(props: any) {
  const { target, ctx$ } = props
  const { model } = ctx$

  const standalone = standaloneBuilder(target)

  const targets = model.main[KIT].target || {}
  if (!standalone && null == targets.ts) {
    throw new SdkGenError(
      'seneca-provider requires the `ts` target in the same SDK: it imports ' +
      'the TypeScript SDK that `ts` generates. Add it with:\n' +
      '  npm run add-target ts\n' +
      'then regenerate.')
  }

  const Name = model.const.Name
  const lower = String(model.const.name)
  const ENV = envName(model)
  const sdkClass = `${Name}SDK`
  const pluginName = `${Name}Provider`
  const fileBase = `${lower}-provider`

  // The SDK is a PUBLISHED dependency, not a path: this package lives in its
  // own repo. Its name is whatever the ts target publishes under, pin
  // included, so the two can never disagree.
  // The TypeScript SDK this provider WRAPS — a different target, so it
  // keeps its own name and does not follow this provider's alias.
  const { sdkPkg, sdkVersion } = sdkIdentity(model, target)

  const entityColl = entityCollection(model)

  const activeEntities = Object.keys(entityColl).sort()
    .map((key: string) => entityColl[key])
    .filter((ent: any) => false !== ent.active)

  const entityNames = activeEntities.map((ent: any) => ent.name)

  const entities = activeEntities
    .map((ent: any) => {
      const parents = parentKeys(ent)

      const parentOf: Record<string, string> = {}
      for (const key of parents) {
        parentOf[key] = parentEntityOf(key, entityNames)
      }

      const opParents: Record<string, string[]> = {}
      for (const opname of entityOps(ent)) {
        opParents[opname] = opParentKeys(ent, opname)
      }

      return {
        ent,
        name: ent.name,
        acc: ent.Name,
        path: entityPath(ent),
        cls: entityClassName(ent, entityColl),
        ops: entityOps(ent),
        idf: entityIdField(ent),
        rk: recordKey(ent),
        rkoncreate: rkOnCreate(ent),
        parkfree: parkFree(ent, lower + '_id'),
        // The composite key, when this API addresses a record by several
        // path params at once. The doc and test emitters in Extras need the
        // same answer the handler emitters use: a test that addresses a
        // composite entity the single-key way builds a query its own handler
        // rejects.
        idparts: idParts(ent),
        idsep: idSep(ent),
        idmisaddressed: ['remove', 'update'].reduce(
          (acc: Record<string, boolean>, opname: string) => {
            acc[opname] = null != (ent.op || {})[opname] &&
              0 < addressKeys(ent, opname).length &&
              !(0 < idParts(ent).length ?
                idParts(ent).every((p: string) =>
                  addressKeys(ent, opname).includes(p)) :
                addressKeys(ent, opname).includes(recordKey(ent)))
            return acc
          }, {}),
        idaddressed: ['load', 'remove', 'update'].reduce(
          (acc: Record<string, boolean>, opname: string) => {
            const keys = addressKeys(ent, opname)
            const parts = idParts(ent)
            acc[opname] = 0 < parts.length ?
              parts.every((p: string) => keys.includes(p)) :
              keys.includes(recordKey(ent))
            return acc
          }, {}),
        idfrom: (ent?.id?.from) || {},
        parents,
        parentOf,
        opParents,
        // The entity the FIRST parent key points at. Kept because the docs and
        // the scripts speak about "the parent" in the singular; anything that
        // must be right per key reads parentOf.
        parentEntity: 0 < parents.length ? parentOf[parents[0]] : '',
        // The custom actions this entity exposes, as cmd -> action -> SDK
        // op. Emitted as a map in the plugin so a handler can route
        // `action$` to the op that actually serves it, and so an unknown
        // name can be refused with the valid ones named.
        actions: Object.keys(CMD_OPS).sort().reduce(
          (acc: Record<string, Record<string, string>>, cmd: string) => {
            acc[cmd] = cmdActions(ent, cmd)
            return acc
          }, {}),
        actionList: entityActionList(ent),
        canonicalOps: canonicalOps(ent),
        fields: (() => {
          const req = (Object.values(ent.fields || {}))
            .filter((f: any) => false !== f.r)
            .map((f: any) => ({
              name: f.n,
              kind: fieldKind(f.t),
              nullable: fieldNullable(f.t),
              parentEntity: parentEntityOf(f.n, entityNames),
            }))

          const have = new Set(req.map((f: any) => f.name))

          for (const key of parents) {
            if (!have.has(key)) {
              req.push({
                name: key,
                kind: 'string',
                nullable: false,
                parentEntity: parentOf[key],
              })
            }
          }

          return req
        })(),
      }
    })
    .map((e: any) => ({
      ...e,
      cmds: Object.keys(CMD_OPS)
        .filter((cmd) => CMD_OPS[cmd].some((op) => e.ops.includes(op))),
    }))
    .filter((e: any) => 0 < e.cmds.length)

  if (0 === entities.length) {
    throw new SdkGenError(
      'seneca-provider: no entity in this model declares a list/load/create/' +
      'update/remove operation, so the plugin would expose no entities at ' +
      'all. Remove the target, or add an entity with CRUD ops.')
  }

  const repo = providerRepo(model, lower, target.name)

  // The companion test server lives in the SDK repo's `app/` and is NOT
  // published, so the only way to reach it is the local checkout. The path
  // back to it is the inverse of this target's own `output: path`, computed
  // once by the external pass — see cmp/ExternalTarget.
  const sdkrel = ctx$.sdkrelpath || '..'

  const sdkRepoUrl = String(repoInfo(model).repoUrl || '')
  const sdkTag = 'v' + sdkVersion
  const sdkRepoDir = sdkRepoUrl.replace(/[/]+$/, '').split('/').pop() || 'sdk'

  // With NO repo url there is nothing to pin and nothing to clone, so the
  // only path anyone can be told is still the relative one. Honest, and the
  // case the pin cannot improve.
  const sdkPinned = '' !== sdkRepoUrl
  const sdkSrc = sdkPinned ? SDK_SRC_DIR + '/' + sdkRepoDir : sdkrel

  const live = model?.main?.[KIT]?.test?.live || {}
  const servers = (model?.main?.[KIT]?.info?.servers || [])
  const specBase = 0 < servers.length ? String(servers[0].url || '') : ''

  const loopback = (url: string) =>
    /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])([:/]|$)/i.test(url)

  const liveBase = null != live.base && '' !== live.base ? String(live.base) :
    (loopback(specBase) ? specBase : '')

  // Whether the SDK's own repo ships a runnable companion server under
  // `app/`. NOTHING in an API definition says so — it is a property of the
  // sibling project — so it cannot be inferred, and inferring it is what put
  // an unconditional `git clone && cd app && npm install && npm run build`
  // into every generated provider's CI.
  const liveApp = true === live.app || (loopback(specBase) && '' === (live.base || ''))

  const sdkDep = sdkDependency(model, target, {
    sdkPkg, sdkVersion, sdkRepoUrl: repoInfo(model).repoUrl,
  })

  const provider = {
    Name, lower, ENV, sdkClass, pluginName, fileBase,
    sdkPkg, sdkVersion, entities,
    sdkDep,
    standalone,
    // Whether that dependency comes from outside a registry. The generated
    // CI note says so, because "npm install is all you need" stops being
    // true the moment git or a tarball URL is in the path.
    sdkGit: !sdkDep.startsWith('^'),
    // WHICH non-registry kind, because the CI note has to be true: a git
    // dependency needs git on PATH and a release asset does not, and a note
    // that says the wrong one is worse than no note.
    sdkDepKind: sdkDep.startsWith('github:') ? 'git' :
      (sdkDep.startsWith('http') ? 'release' : 'npm'),
    sdkInstallFlag: sdkDep.startsWith('github:') ? ' --allow-git=all' :
      (sdkDep.startsWith('http') ? ' --allow-remote=all' : ''),
    repoUrl: repo.url,
    repoPath: repo.path,
    repoHost: repo.host,
    sdkRepoUrl,
    sdkTag,
    sdkRepoDir,
    sdkPinned,
    sdkSrc,
    api: apiName(model),
    version: packageVersion(model, target.name),
    liveBase,
    liveApp,
    // The server the API definition declares, which is the SDK's own default.
    specBase,
    publisher: PUBLISHER,
    publisherUrl: PUBLISHER_URL,
    probePath: (entities.find((e: any) =>
      '' !== e.path && !e.path.includes('{')) || { path: '' }).path,
    pkgName: providerPackage(model, lower, target.name),
    // Whether this API authenticates at all. Decides if the plugin plumbs a
    // credential: the SDK's auth stage emits nothing for an auth-inactive
    // model and strips the authorization header regardless of options, so
    // plumbing one anyway produces a credential path that cannot work.
    authActive: isAuthActive(model),
    authBasic: isAuthActive(model) && isHttpBasicAuth(model),
    // Where the credential goes, resolved as the SDK's auth stage does.
    authIn: resolveAuthIn(model),
    authName: 'header' === resolveAuthIn(model) ?
      resolveAuthName(model).toLowerCase() : resolveAuthName(model),
    authPrefix: resolveAuthPrefix(model),
  }

  if (standalone) {
    checkSdkSource(ctx$, provider, model)
  }

  // `.gitignore` is EMITTED rather than copied — npm strips that filename
  // from the tarball, so as a template it reached only checkout users. See
  // Gitignore_seneca-provider. Called before the Copy, as every language
  // target calls its own.
  Gitignore({})

  Copy({
    from: 'tm/' + target.name,
    replace: { ...ctx$.stdrep },
  })

  Makefile({ provider })
  SdkPin({ provider })
  PackageJson({ provider, target })
  ProviderSource({ provider })
  ProviderDoc({ provider })
  Tests({ provider })
  Scripts({ provider })
  Workflow({ provider })
  Readme({ provider })
  Docs({ provider })
})


function sdkDependency(model: any, target: any, provider: any): string {
  const dep = model?.main?.[KIT]?.target?.[target.name]?.sdk?.dep || {}

  const spec = String(dep.spec || '').trim()
  if ('' !== spec) {
    return spec
  }

  const kind = String(dep.kind || 'npm')
  if ('git' !== kind && 'release' !== kind) {
    return `^${provider.sdkVersion}`
  }

  // `owner/repo`, from the SDK's own repository unless the project says
  // otherwise. Accepts a full URL and reduces it, so a project can paste
  // what its remote prints.
  const repo = String(dep.repo || provider.sdkRepoUrl || '')
    .replace(/^git\+/, '')
    .replace(/^(https?:\/\/)?(www\.)?github\.com[/:]/, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')

  if ('' === repo) {
    throw new SdkGenError(
      'seneca-provider: sdk.dep.kind is "git" but no repository is known. ' +
      'Set `main.' + KIT + '.target.' + target.name +
      '.sdk.dep.repo` to `owner/repo`, or state the whole dependency with ' +
      '`sdk.dep.spec`.')
  }

  const ref = String(dep.ref || '').trim()
  if ('' === ref) {
    throw new SdkGenError(
      'seneca-provider: sdk.dep.kind is "git" but no `ref` is set. A git ' +
      'dependency with no ref follows the default branch, so an install ' +
      'today and an install tomorrow can differ — name the TAG to depend ' +
      'on, e.g. `sdk.dep.ref: "v' + provider.sdkVersion + '"`.')
  }

  if ('release' === kind) {
    const asset = String(dep.asset || '').trim() || (
      provider.sdkPkg.replace(/^@/, '').replace(/\//g, '-') +
      '-' + provider.sdkVersion + '.tgz')

    return `https://github.com/${repo}/releases/download/${ref}/${asset}`
  }

  return `github:${repo}#${ref}`
}



const PackageJson = cmp(function PackageJson(props: any) {
  const { provider, target } = props
  const { model } = props.ctx$

  const deps = collectDeps(model, target.name, target.deps, props.ctx$.log)

  const dep = (kind: string) => {
    const out: Record<string, string> = {}
    const kinds = (d: any) => String((d.raw && d.raw.kind) || '')
      .split(',').map((s: string) => s.trim()).filter((s: string) => '' !== s)

    for (const d of deps.filter((d: any) => kinds(d).includes(kind))) {
      out[d.name] = d.version
    }
    return out
  }

  // Attribution. Model-driven, because it cannot be derived and because
  // regeneration OVERWRITES the manifest: the hand-written provider this
  // target was modelled on lost its author and both named contributors on the
  // first regeneration, and nothing failed. Unset falls back to the publisher.
  const author = authorInfo(model)
  const contributors = contributorList(model)

  const pkg = {
    name: provider.pkgName,
    version: provider.version,
    main: `dist/${provider.fileBase}.js`,
    type: 'commonjs',
    types: `dist/${provider.fileBase}.d.ts`,
    description:
      `Seneca entity provider for the ${provider.api} API, using the ` +
      `${provider.sdkPkg} SDK.`,
    homepage: provider.repoUrl,
    keywords: ['seneca', provider.lower, `${provider.lower}-provider`,
      provider.publisher.toLowerCase(), 'sdk'],
    author,
    ...(0 < contributors.length ? { contributors } : {}),
    license: 'MIT',
    repository: { type: 'git', url: `git+${provider.repoUrl}.git` },
    scripts: {
      test: 'node --enable-source-maps --test test/**/*.test.js',
      'test-some':
        'node --enable-source-maps --test-name-pattern="$TEST_PATTERN" ' +
        '--test "test/**/*.test.js"',
      'test-watch': 'node --test --watch test/**/*.test.js',
      watch: 'tsc --build src test -w',
      build: 'tsc --build src test',
      'test-coverage':
        'node --enable-source-maps --experimental-test-coverage --test ' +
        'test/**/*.test.js',
      clean:
        'rm -rf node_modules dist dist-test .tsbuildinfo yarn.lock ' +
        'package-lock.json',
      reset: 'npm run clean && npm i && npm run build && npm test',
      // The Seneca release convention: tag from package.json, push, publish.
      // Generated because a provider is released like every other Seneca
      // plugin, and a maintainer who has to remember the incantation will
      // eventually publish an untested build.
      'repo-tag':
        'REPO_VERSION=`node -e "console.log(require(\'./package\').version)"` ' +
        '&& echo TAG: v$REPO_VERSION && git commit -a -m v$REPO_VERSION ' +
        '&& git push && git tag v$REPO_VERSION && git push --tags;',
      'repo-publish': 'npm run clean && npm i && npm run repo-publish-quick',
      'repo-publish-quick':
        'npm run build && npm run test && npm run repo-tag && ' +
        'npm publish --access public --registry https://registry.npmjs.org',
    },
    files: ['dist', 'doc', 'src/**/*.ts', 'LICENSE', 'README.md'],
    engines: { node: '>=24' },
    dependencies: {
      // The SDK this plugin wraps. Published-and-pinned by default; a git
      // tag when the project says so, because an unpublished SDK otherwise
      // leaves this package unable to install at all. See sdkDependency.
      [provider.sdkPkg]: provider.sdkDep,
      ...dep('prod'),
    },
    peerDependencies: dep('peer'),
    devDependencies: dep('dev'),
  }

  File({ name: 'package.json' }, () => {
    Content(JSON.stringify(pkg, null, 2) + '\n')
  })
})



const ProviderSource = cmp(function ProviderSource(props: any) {
  const { provider } = props

  const translated = provider.entities.filter((e: any) => null != idSpec(e.ent))

  Folder({ name: 'src' }, () => {
    File({ name: `${provider.fileBase}.ts` }, () => {
      Content(`/* Generated by @voxgig/sdkgen. Do not edit. */

const Pkg = require('../package.json')

const { ${provider.sdkClass} } = require('${provider.sdkPkg}')

const SdkPkg = require('${provider.sdkPkg}/package.json')


type ${provider.pluginName}Options = {
  // Options passed straight to the ${provider.sdkClass} constructor,
  // most usefully \`base\` to point at a server.
  sdk?: Record<string, any>

  // Run the SDK in offline test mode (in-memory mock transport).
  test?: boolean

  // Test feature options, e.g. {entity: {${provider.entities[0].name}: {...}}} to
  // seed the mock with data. Only used when \`test\` is true.
  testopts?: Record<string, any>
}


function ${provider.pluginName}(this: any, options: ${provider.pluginName}Options) {
  const seneca: any = this

  const entityBuilder = this.export('provider/entityBuilder')

  seneca.message('sys:provider,provider:${provider.lower},get:info', get_info)

  async function get_info(this: any, _msg: any) {
    return {
      ok: true,
      name: '${provider.lower}',
      version: Pkg.version,
      sdk: {
        name: '${provider.sdkPkg}',
        version: SdkPkg.version,
      },
    }
  }


  // Every SDK operation resolves to an SDK ENTITY rather than raw data (a
  // removed record included: it comes back marked deleted, still holding what
  // it held). Seneca wants plain data, which the entity hands over through
  // data().
  function plain(res: any) {
    return null == res ? res : res.data()
  }


  // Seneca query directives (sort$, limit$, ...) are for the store, not the
  // API, so they must not reach the SDK as match fields.
  function cleanq(q: any) {
    const out: any = {}
    for (const k in (q || {})) {
      if (!k.endsWith('$')) {
        out[k] = q[k]
      }
    }
    return out
  }


  // \`action$\` — the directive that selects a custom API action instead of
  // the plain cmd. READ BEFORE cleanq strips it, and still stripped from
  // what reaches the SDK as match fields: it is an instruction to the store,
  // like sort$ and limit$, not a value to filter on.
  //
  // THREE PLACES, because seneca-entity puts it in three places depending on
  // how the caller spelled it, and dropping any one of them silently turns a
  // named action into an ordinary call:
  //
  //   list$/load$/remove$({ action$ })         -> msg.q.action$
  //   ent.directive$({ action$ }).save$()      -> msg.action$
  //   const e = ent.make$({...}); e.action$=.. -> msg.ent.action$
  //
  // \`make$({ action$ })\` is NOT among them and cannot be: seneca-entity's
  // make$ copies only keys without a \`$\`, plus the four directives it knows
  // (id$, merge$, custom$, directive$), so an unknown trailing-\`$\` key is
  // dropped before any store sees it. \`id$\` reads like the precedent for
  // one, but it works only because make$ names it explicitly. The README
  // says so; there is nothing this plugin can check, because nothing arrives.
  function actionOf(msg: any) {
    const q = msg && msg.q
    const ent = msg && msg.ent

    return null != (q && q.action$) ? q.action$ :
      null != (msg && msg.action$) ? msg.action$ :
        null != (ent && ent.action$) ? ent.action$ :
          undefined
  }


  // The SDK argument for an ACTION on a read cmd: everything the caller sent
  // minus Seneca's own directives, with the id translated into the API's own
  // keys, plus the \`$action\` selector the SDK dispatches on.
  //
  // WIDER than the canonical argument on purpose. An action route has its own
  // parameters — GitHub's merge takes commit_title and merge_method, which the
  // canonical PATCH knows nothing about — so narrowing to the plain op's
  // required keys would strip the action's whole payload. The SDK still
  // validates: an action whose own point cannot be built is refused with
  // \`point_action_invalid\` rather than sent somewhere else.
  function actionq(q: any, ${0 === translated.length ? '' : 'name: string, '}action: string) {
    const out = cleanq(q)
${0 === translated.length ? '' : `
    // An action addresses the SAME record the canonical route does, so the id
    // is translated the same way a write translates it: split into the path
    // parameters the API names, under the names it names them by. Sending the
    // joined id as one terminal parameter asks for \`owner0/repo0\` as a repo.
    const own = Object.prototype.hasOwnProperty
    const spec = own.call(ID_SPEC, name) ? ID_SPEC[name] : null

    if (null != spec && null != out.id) {
      Object.assign(out, splitid(name, out.id, 'action'))
      delete out.id
    }
`}
    out.$action = action
    return out
  }


  // The SDK throws on any non-2xx. A 404 from a single-item read is an
  // ordinary "not found" answer rather than a failure, so return null and let
  // everything else propagate. SDK errors carry the HTTP status at the top
  // level, so ask them rather than digging into \`result\`.
  async function ornull(action: () => Promise<any>) {
    try {
      return await action()
    }
    catch (e: any) {
      if (true === e?.notFound) {
        return null
      }
      throw e
    }
  }

`)

      // A guard per required parent key. Without it the SDK builds a
      // half-formed URL and the caller gets an opaque 404 instead of being
      // told what they left out.
      const guarded = provider.entities.filter((e: any) => 0 < e.parents.length)
      if (0 < guarded.length) {
        Content(`  // Nested entities cannot build their path without the parent id, so
  // say which key is missing rather than letting the SDK report an opaque
  // 404 on a half-built URL.
`)
        each(guarded, (e: any) => {
          each(e.parents, (key: any) => {
            const k = String(key.val$ ?? key)
            Content(`  function ${guardName(e, k)}(value: any, cmd: string) {
    if (null == value || '' === value) {
      throw new Error(
        '${provider.pkgName}: ${e.name} ' + cmd + ': ${k} is required'
      )
    }

    // A path parameter is one value. A loaded record can carry an object
    // under the same name, and that must not be sent as a URL segment.
    if ('object' === typeof value) {
      throw new Error(
        '${provider.pkgName}: ${e.name} ' + cmd + ': ${k} must be a single ' +
        'value to build the request path, not an object'
      )
    }
    return value
  }


`)
          })
        })
      }

      if (0 < translated.length) {
        const rows = translated.map((e: any) => {
          const spec: any = idSpec(e.ent)
          const from = null == spec.from ? '' :
            `, from: { ${Object.keys(spec.from).sort()
              .map((k: string) => `${jsKey(k)}: '${spec.from[k]}'`).join(', ')} }`
          const park = false === e.parkfree ? ', park: false' : ''
          return `    ${jsKey(e.name)}: { parts: [${
            spec.parts.map((p: string) => `'${p}'`).join(', ')}], sep: '${spec.sep}'${from}${park} },`
        }).join('\n')

        Content(`  // HOW EACH ENTITY'S id MAPS TO THE API'S OWN KEYS, from the model.
  //
  // \`parts\`  the path parameters that address one record, in path order.
  //          One part is the ordinary case: the API just calls its key
  //          something other than \`id\`. Two or more is a compound key,
  //          where no single parameter names the record.
  // \`sep\`    joins the parts into the one id a Seneca entity carries. A
  //          slash cannot occur inside a path segment, so the join is
  //          unambiguous and the split cannot over-split.
  // \`from\`   where each part's value lives in a RESPONSE, as a dotted
  //          path. A path parameter's name is not generally a response
  //          field's name: github returns a repo's owner as an OBJECT
  //          (\`owner.login\`) and its name as \`name\`, never \`repo\`.
  //          A part missing here cannot be read back off a response.
  // \`park\`   false where \`${provider.lower}_id\` is a name this entity
  //          already uses, so the API's own id is left where it is.
  const ID_SPEC: Record<string, { parts: string[], sep: string, from?: Record<string, string>, park?: boolean }> = {
${rows}
  }


  // Read a dotted path out of a record. \`from\` maps a path parameter to
  // wherever the response actually carries it, and that is sometimes inside
  // a nested object.
  function idread(data: any, path: string) {
    let node: any = data
    for (const key of path.split('.')) {
      if (null == node) {
        return undefined
      }
      node = node[key]
    }
    return node
  }


  // The Seneca id, split back into the parameters the API addresses a record
  // with. Refuses a wrong part count rather than sending a URL built from
  // whatever the id happened to contain — that would address a different
  // record, or none, and the 404 would name nothing useful.
  function splitid(name: string, id: any, what: string) {
    const spec = ID_SPEC[name]
    const text = null == id ? '' : String(id)
    const got = 1 === spec.parts.length ? [text] : text.split(spec.sep)

    if (spec.parts.length !== got.length || got.some((p: string) => '' === p)) {
      throw new Error(
        '${provider.pkgName}: ' + name + ' ' + what +
        ": id must be '" + spec.parts.join(spec.sep) + "', got: " + JSON.stringify(id))
    }

    const out: Record<string, any> = {}
    spec.parts.forEach((p: string, i: number) => { out[p] = got[i] })
    return out
  }


  // The id for a record the API returned.
  //
  // \`vals\` are the parameters THIS request addressed it with, and they win:
  // a response does not always repeat them. Otherwise the parts are read out
  // of the response through \`from\`, which is what makes a created or listed
  // record identifiable at all.
  //
  // THE ADDRESSING KEY WINS over an \`id\` the response already carries. A
  // response often has both — github's pull has a global database \`id\` and
  // a repo-scoped \`number\` — and the unrelated one is no use for addressing
  // anything. It is kept as \`${provider.lower}_id\`, unless \`park\` forbids.
  function joinid(name: string, data: any, vals?: any) {
    const spec = ID_SPEC[name]
    if (null == data) {
      return data
    }

    let id = null

    if (null != vals) {
      const got = spec.parts.map((p: string) => vals[p])
      if (got.every((v: any) => null != v && '' !== String(v))) {
        id = got.join(spec.sep)
      }
    }

    if (null == id) {
      const got = spec.parts.map((p: string) =>
        idread(data, (spec.from || {})[p] || p))
      if (got.every((v: any) =>
        null != v && 'object' !== typeof v && '' !== String(v))) {
        id = got.join(spec.sep)
      }
    }

    if (null != id) {
      if (false !== spec.park && null != data.id && String(data.id) !== id &&
        null == ${jsProp('data', provider.lower + '_id')}) {
        ${jsProp('data', provider.lower + '_id')} = data.id
      }
      data.id = id
    }

    return data
  }


`)
      }

      Content(`  // The custom actions each cmd can reach, as action -> SDK op. An action
  // is an alternative POINT of an ordinary op (\`select.$action\` in the API
  // model), so \`save$\` routes by this map rather than assuming update: an
  // action folded into \`create\` is reached through \`save$\` too.
  const ACTIONS: Record<string, Record<string, Record<string, string>>> = {
`)
      each(provider.entities, (e: any) => {
        Content(`    [${JSON.stringify(e.name)}]: {
`)
        each(e.cmds, (cmd: any) => {
          const name = String(cmd.val$ ?? cmd)
          const map = e.actions[name] || {}
          const names = Object.keys(map).sort()
          Content(`      ${name}: {${names.map((a: string) =>
            ` [${JSON.stringify(a)}]: '${map[a]}'`).join(',')}${0 < names.length ? ' ' : ''}},
`)
        })
        Content(`    },
`)
      })
      Content(`  }


  // Resolve an \`action$\` to the SDK op that serves it, or REFUSE it.
  //
  // Never falls through to the ordinary call. An action name the entity does
  // not have is a caller mistake worth a message that names what is
  // available; performing a plain save instead is the one outcome that must
  // not happen, because it succeeds and does the wrong thing.
  // AN OWN PROPERTY, never an inherited one. \`map[name]\` resolves
  // \`toString\`, \`constructor\`, \`valueOf\` and the rest off Object's
  // prototype, and each of those is non-null — so the refusal below never
  // fired and the inherited function was handed to the SDK as an op name.
  // That is the silent drop in another hat: the caller named something the
  // entity does not have and was not told. An empty map inherits them all,
  // so a cmd with no actions was the most exposed.
  // THE CMD THAT WOULD WRITE TO THE WRONG RESOURCE.
  //
  // Some entities gather their ops from unrelated routes, and then a cmd's
  // only route addresses something that is not this record: \`migration\`'s
  // remove deletes a repository's migration ARCHIVE, \`user\`'s deletes a GPG
  // KEY, \`pull\`'s deletes a review COMMENT. The id the caller passed is not
  // in the request at all.
  //
  // Such a cmd is refused rather than sent. A caller asking to remove one
  // record must not have a different resource deleted instead, and a
  // successful-looking reply is the worst possible answer. Where the real
  // operation exists it is reachable by name, through \`action$\`.
  function misaddressed(
    entname: string, cmd: string, key: string, addresses: string[]
  ) {
    const own = Object.prototype.hasOwnProperty
    const ents: any = own.call(ACTIONS, entname) ? ACTIONS[entname] : {}
    const acts = Object.keys(own.call(ents, cmd) ? ents[cmd] : {}).sort()

    throw new Error(
      '${provider.pkgName}: ' + entname + ' ' + cmd +
      ': this API has no ' + cmd + ' route for one ' + entname +
      '. Its only ' + cmd + ' route addresses ' + addresses.join(', ') +
      ', not ' + key + ', so the id would be ignored and a different record ' +
      'changed. ' +
      (0 < acts.length ?
        'Name the operation with action\$ instead: ' + acts.join(', ') :
        'No action\$ of this cmd is available either'))
  }


  function actionop(name: string, entname: string, cmd: string) {
    const own = Object.prototype.hasOwnProperty
    const ents: any = own.call(ACTIONS, entname) ? ACTIONS[entname] : {}
    const map: any = own.call(ents, cmd) ? ents[cmd] : {}
    const op = own.call(map, name) ? map[name] : null

    if (null == op) {
      const valid = Object.keys(map).sort()
      throw new Error(
        '${provider.pkgName}: ' + entname + ' ' + cmd + ': action$ "' + name +
        '" is not an action of this operation. Valid: ' +
        (0 < valid.length ? valid.join(', ') : '(none)'))
    }

    return op
  }


`)

      Content(`  const entity: any = {
`)
      each(provider.entities, (e: any) => {
        Content(`    ${jsKey(e.name)}: {
      cmd: {
`)
        each(e.cmds, (cmd: any) => {
          Content(`        ${String(cmd.val$ ?? cmd)}: { action: (undefined as any) },
`)
        })
        Content(`      },
    },

`)
      })
      Content(`  }

`)

      each(provider.entities, (e: any) => {
        const eparts = idParts(e.ent)
        const espec = idSpec(e.ent)
        // Guards of ONE op: save's create and update branches guard their own.
        const guard = (opname: string, src: string, label = opname, ind = '      ') => {
          const keys = e.opParents[opname] || []

          return keys
            .filter((k: string) => !eparts.includes(k))
            .map((k: string) =>
              `${ind}${guardName(e, k)}(${jsProp(src, k)}, '${label}')\n`)
            .join('')
        }

        const refuse = (cmd: string, ind = '      ') => {
          if (true !== (e.idmisaddressed || {})[cmd]) {
            return ''
          }
          const key = 0 < eparts.length ? eparts.join(String(e.idsep || '/')) :
            recordKey(e.ent)
          const addresses = addressKeys(e.ent, cmd)

          return `${ind}misaddressed('${e.name}', '${cmd}', '${key}', ` +
            `[${addresses.map((k: string) => `'${k}'`).join(', ')}])
`
        }

        const rk = recordKey(e.ent)

        // Named only where there is a spec to translate the id through.
        const aq = `actionq(msg.q, ${0 === translated.length ? '' :
          `'${e.name}', `}action$)`

        const sdkArg = (opname: string) => {
          const keys = addressKeys(e.ent, opname)
          if (0 === keys.length) {
            return '{}'
          }
          if (0 < eparts.length) {
            return `{ ${keys.map((k: string) => eparts.includes(k) ?
              `${jsKey(k)}: ${jsProp('key', k)}` :
              `${jsKey(k)}: ${jsProp('q', k)}`).join(', ')} }`
          }
          return `{ ${keys.map((k: string) =>
            `${jsKey(k)}: ${jsProp('q', k === rk ? 'id' : k)}`).join(', ')} }`
        }

        // Seneca's `id` and the API's key differ: composite, or not called id.
        const keyed = null != espec

        // The entity-options argument carrying a write's addressing values.
        const entArg = !keyed ? '' : `null == key ? undefined : { match: key }`

        const splitLine = (cmd: string) => 0 === eparts.length ? '' :
          `      const key = splitid('${e.name}', q.id, '${cmd}')\n`

        // The data hop, plus the id from the values this request addressed the
        // record with, which the response need not repeat.
        const out = (expr: string, vals?: string) =>
          !keyed ? `plain(${expr})` :
            `joinid('${e.name}', plain(${expr})${null == vals ? '' : ', ' + vals})`

        const loadVals = 0 < eparts.length ? 'key' :
          !keyed ? undefined : `{ ${jsKey(rk)}: q.id }`

        const actionBranch = (cmd: string, call: string) => `      const action$ = actionOf(msg)
      if (null != action$) {
        const op$ = actionop(action$, '${e.name}', '${cmd}')
${call}      }

`

        if (e.cmds.includes('list')) {
          Content(`
  ${jsProp('entity', e.name)}.cmd.list.action =
    async function list_${e.name}(this: any, entize: any, msg: any) {
      const q = cleanq(msg.q)
${actionBranch('list',
            `        const found = await this.shared.sdk.${e.acc}()[op$](${aq})
        return found.map((data: any) => entize(${out('data')}))
`)}${guard('list', 'q')}      const list = await this.shared.sdk.${e.acc}().list(q)
      return list.map((data: any) => entize(${out('data')}))
    }

`)
        }

        if (e.cmds.includes('load')) {
          Content(`
  ${jsProp('entity', e.name)}.cmd.load.action =
    async function load_${e.name}(this: any, entize: any, msg: any) {
      const q = cleanq(msg.q)
${actionBranch('load',
            `        const hit = await ornull(() => this.shared.sdk.${e.acc}()[op$](${aq}))
        return null == hit ? null : entize(${out('hit')})
`)}${guard('load', 'q')}${splitLine('load')}      const res = await ornull(() => this.shared.sdk.${e.acc}().load(${sdkArg('load')}))
${0 < addressKeys(e.ent, 'load').length || 0 < eparts.length ? '' :
            `      // The route names no record, so an id finds only the record carrying it.
      if (null != res && null != q.id && String(${jsProp('plain(res)', rk)}) !== String(q.id)) {
        return null
      }
`}      return null == res ? null : entize(${out('res', loadVals)})
    }

`)
        }

        if (e.cmds.includes('save')) {
          const hasCreate = e.ops.includes('create')
          const hasUpdate = e.ops.includes('update')

          const refuseUpdate = true === (e.idmisaddressed || {}).update

          const isUpdate = keyed ? 'null != key' : 'null != data.id'

          // Deleting a name the entity owns strips a value the caller supplied.
          const dropPark = false === e.parkfree ? '' : `
      // \`${provider.lower}_id\` is this provider's own bookkeeping — the
      // API's unrelated \`id\`, parked by joinid(). It is not a field of the
      // API's write schema, so it must not travel in the request body.
      delete ${jsProp('data', provider.lower + '_id')}
`

          const keyBlock = 0 < eparts.length ? `
      // Seneca carries this ${e.name}'s key as one \`id\`; the API addresses
      // the record by ${eparts.map((p: string) => '`' + p + '`').join(' and ')}.
      //
      // THE PARTS GO IN THE ENTITY MATCH, NOT ONTO THE DATA. They are path
      // parameters, and the data is the request body. Writing them onto the
      // data is how the flat \`${eparts[0]}\` the URL needs came to displace
      // whatever the response carries under that name — for github's repo an
      // \`owner\` OBJECT, so a saved record lost the field that identifies
      // it. The SDK resolves a path parameter from the match ahead of the
      // body, so passing it here leaves the body exactly as the caller meant
      // it.
      //
      // \`key\` STAYS NULL ON A CREATE: there is no id yet, the API assigns
      // the record, and the id is rebuilt from the response instead.
      let key = null
      if (null != data.id) {
        key = splitid('${e.name}', data.id, 'save')
      }
${dropPark}
      // AND NEITHER DOES THE JOINED \`id\`. It is Seneca's key for this
      // record, not the API's: a composite ${e.name} is addressed by
      // \`${eparts.join('\` and \`')}\`, which travel as path parameters in
      // the match above. Leaving it on the body sent \`owner0/repo0\` as a
      // field the write schema has no place for — and the offline transport,
      // which matches a request against a stored record, then looked for a
      // record whose own \`id\` was that joined string and found none.
      delete data.id
` : !keyed ? '' : hasCreate && !hasUpdate && true !== e.rkoncreate ? `
      // The API assigns a ${e.name}'s \`${rk}\`, and a create names no record, so
      // Seneca's \`id\` is not sent: the id is read back from the response.
      const key: any = null
${dropPark}      delete data.id
` : `
      // This API keys a ${e.name} by \`${rk}\`; Seneca carries it as \`id\`.
      // The key goes on the body under the API's own name, where the route
      // reads it, and into the match, which the SDK consults first.
      let key = null
      if (null != data.id) {
        key = { ${jsKey(rk)}: data.id }
        if (null == ${jsProp('data', rk)}) {
          ${jsProp('data', rk)} = data.id
        }
      }
${dropPark}
      // NOR DOES SENECA'S \`id\`. It holds the \`${rk}\` this API addresses
      // the record by, under a name this API's ${e.name} does not have: sent
      // on the body it is at best an unknown property, and to a store that
      // matches a write against the record it names the wrong one.
      delete data.id
`

          const saveVals = keyed ? 'key' : undefined

          const call = (opname: string) =>
            `await sdk.${e.acc}(${entArg}).${opname}(data)`

          const body = hasCreate && hasUpdate
            ? (!refuseUpdate ? `      let res
      if (${isUpdate}) {
${guard('update', 'data', 'save', '        ')}        res = ${call('update')}
      }
      else {
${guard('create', 'data', 'save', '        ')}        res = ${call('create')}
      }` : `      if (${isUpdate}) {
${refuse('update', '        ')}      }

${guard('create', 'data', 'save')}      const res = ${call('create')}`)
            : hasCreate
              ? `${guard('create', 'data', 'save')}      const res = ${call('create')}`
              : `${refuse('update')}${guard('update', 'data', 'save')}      const res = ${call('update')}`

          Content(`
  ${jsProp('entity', e.name)}.cmd.save.action =
    async function save_${e.name}(this: any, entize: any, msg: any) {
      const data = msg.ent.data$(false)
${keyBlock}      const sdk = this.shared.sdk

${actionBranch('save',
            `        // The action's OWN payload is the entity's own fields — data$(false)
        // has already dropped every trailing-\`$\` key, \`action$\` included,
        // so \`$action\` is the only thing added here.
        data.$action = action$
        const done = await sdk.${e.acc}(${entArg})[op$](data)
        return entize(${out('done', saveVals)})
`)}${body}

      return entize(${out('res', saveVals)})
    }

`)
        }

        if (e.cmds.includes('remove')) {
          Content(`
  ${jsProp('entity', e.name)}.cmd.remove.action =
    async function remove_${e.name}(this: any, entize: any, msg: any) {
      const q = cleanq(msg.q)
${actionBranch('remove',
            `        const gone = await ornull(() => this.shared.sdk.${e.acc}()[op$](${aq}))
        return null == gone ? null : entize(${out('gone')})
`)}${'' !== refuse('remove') ? refuse('remove') :
            `${guard('remove', 'q')}${splitLine('remove')}      await ornull(() => this.shared.sdk.${e.acc}().remove(${sdkArg('remove')}))
`}      return null
    }

`)
        }
      })

      Content(`
  entityBuilder(this, {
    provider: {
      name: '${provider.lower}',
    },
    entity
  })


  seneca.prepare(async function(this: any) {
    const sdkopts: any = Object.assign({}, options.sdk)
${provider.authActive ? `
    // The provider convention carries credentials, so honour an \`apikey\`
    // when one is configured.
    const res = await this.post('sys:provider,get:keymap,provider:${provider.lower}')

    // ACCEPT \`api\` AS WELL AS \`apikey\`. The older provider convention
    // named this key \`api\` and read it with
    // \`sys:provider,get:key,...,key:api\`; the keymap message replaced that,
    // and the rename was silent. An application still configured as
    // \`keys: { api: { value: ... } }\` therefore resolved to undefined and
    // the SDK was constructed with NO credential at all — the request went
    // out unauthenticated and failed much later as a 401 or a 404 on
    // anything private, with nothing at startup to point at the cause.
    // \`apikey\` wins when both are set and it is not empty, so a config that
    // has migrated is unaffected.
    const apikey = [res?.keymap?.apikey?.value, res?.keymap?.api?.value]
      .find((value: any) => null != value && '' !== value)

    // Hand the credential to the SDK as \`apikey\`, NOT as an authorization
    // HEADER. The SDK's own auth stage owns that header: it reads
    // \`options.apikey\`, and on every path where it finds none it DELETES
    // \`authorization\` before the request goes out. A provider that set the
    // header itself was therefore never authenticated — the SDK stripped the
    // very thing it had just written, on every call, silently. The SDK also
    // owns the scheme prefix, which is resolved from the API definition
    // rather than assumed to be \`Bearer\`.
    if (null != apikey && '' !== apikey) {
      sdkopts.apikey = apikey
    }

    // AN UNRESOLVED CREDENTIAL IS SAID OUT LOUD. This API declares
    // authentication, so reaching here with nothing configured means every
    // call goes out unauthenticated. That is not always wrong — public
    // read-only endpoints work, at a much lower rate limit — so this warns
    // rather than throwing, and names both accepted key spellings so a
    // misnamed key is obvious from one line of log. Silence here is what
    // made the \`api\` -> \`apikey\` rename above cost a debugging session
    // instead of a glance.
    else {
      this.log.warn({
        fix: 'unauthenticated',
        note: 'no ${provider.lower} credential resolved from the keymap ' +
          '(looked for keys.apikey then keys.api); requests will be sent ' +
          'unauthenticated and will fail on anything non-public',
      })
    }
${provider.authBasic ? `
    // Genuine HTTP Basic Auth needs a SECOND credential (the SDK sends
    // \`Authorization: Basic base64(apikey:secret)\`) — without it the SDK's
    // auth stage treats the pair as incomplete and deletes the header, same
    // as a missing apikey.
    const secret = res?.keymap?.secret?.value

    if (null != secret && '' !== secret) {
      sdkopts.secret = secret
    }
` : ''}` : `
    // This API declares no authentication, so no credential is plumbed. The
    // SDK's auth stage emits nothing for an auth-inactive model and deletes
    // any \`authorization\` header regardless of options, so a keymap lookup
    // here would read a key that could not reach the wire — which is what the
    // first version of this target did.
`}
    this.shared.sdk = options.test
      ? ${provider.sdkClass}.test(options.testopts || {}, sdkopts)
      : new ${provider.sdkClass}(sdkopts)
  })


  return {
    exports: {
      sdk: () => this.shared.sdk,
    },
  }
}


// Default options.
const defaults: ${provider.pluginName}Options = {
  sdk: {},
  test: false,
  testopts: {},
}

Object.assign(${provider.pluginName}, { defaults })

export default ${provider.pluginName}

if ('undefined' !== typeof module) {
  module.exports = ${provider.pluginName}
}
`)
    })
  })
})



const ProviderDoc = cmp(function ProviderDoc(props: any) {
  const { provider } = props

  Folder({ name: 'src' }, () => {
    File({ name: `${provider.pluginName}-doc.ts` }, () => {
      Content(`/* Generated by @voxgig/sdkgen. Do not edit. */


const messages = {
  get_info: {
    desc: 'Get information about the ${provider.api} SDK.',
  },
}


const sections = {
  intro: {
    path: '../provider/doc/intro.md'
  }
}

const docs = {
  sections,
  messages
}

export default docs


if ('undefined' !== typeof module) {
  module.exports = docs
}
`)
    })
  })
})


export {
  Main,
  recordKey,
  rkOnCreate,
  cmdActions,
  entityActionList,
}
