# @voxgig/sdkgen-infrapack

**Infrastructure-provider targets** for the
[Voxgig SDK Generator](https://github.com/voxgig/sdkgen).

An infrastructure provider is not an SDK. It is a plugin for someone else's
system — Seneca, Terraform — that exposes your API's entities in that system's
own vocabulary, layered on the SDK generated from the same model. Every target
here wraps a language target rather than being one.

```bash
npm install --save-dev @voxgig/sdkgen-infrapack
voxgig-sdkgen package add @voxgig/sdkgen-infrapack
npm run generate
```

## Targets

| target | wraps | produces |
|---|---|---|
| `seneca-provider` | `ts` | a [Seneca](https://senecajs.org) plugin exposing entities as `provider/<name>/<entity>` |

`terraform-provider` is designed and not yet built; see the design notes in the
sdkgen repository.

## Every target here needs the target it wraps

These are consumer targets: they switch every standard generation phase off and
emit their whole package from `Main`, and each one fails without the target it
wraps, deliberately. Add `ts` to your project before `seneca-provider`. The
one exception is a provider that carries its own builder (below), which names
the SDK it wraps instead.

There is no manifest field for that requirement. Nothing in
`sdkgen-package.json` says "this target needs that one", so this paragraph and
the error at generation are where the requirement lives.

## Custom actions reach Seneca as `action$`

An API definition folds a non-CRUD verb into an ordinary operation as an
alternative route — GitHub's `PUT /repos/{owner}/{repo}/pulls/{n}/merge` is a
second point of the pull request's `update`. The SDK selects one with
`$action` in the call's argument. Seneca has no operation to add it to, so the
provider takes it as a directive, spelled the Seneca way:

```js
const pull = seneca.entity('provider/github/pull')

await pull
  .make$({ id: 42, owner: 'voxgig', repo: 'sdkgen',
           commit_title: 'Merge pull request #42' })
  .directive$({ action$: 'merge' })
  .save$()
```

`save$` routes by the operation the action belongs to, not by the command, so
an action folded into `create` is called as a create even on an entity that
carries an id. A name the entity does not have throws, naming the valid ones —
it never falls back to the plain command. Each generated provider lists its own
actions in its README and its reference.

`make$({ action$ })` does not work and cannot: `seneca-entity`'s `make$` copies
only keys without a `$`, plus the four directives it knows by name, so any
other trailing-`$` key is dropped before a store sees it. Use `directive$`, or
assign the property to an entity you have already made.

Providers generated before this gain their actions on the next regeneration.


## `seneca-provider` generates into its own repository

Unlike a language target, a Seneca provider is not a folder in the SDK
repository. It is an independently released npm package under the `@seneca`
scope, with its own license, workflow and release cadence, and it depends on
the SDK as an ordinary published dependency. Point it at that repository from
your project model:

```
main: kit: target: 'seneca-provider': output: path: '../../seneca/seneca-acme-provider'
```

The path resolves against the SDK repository root. Left unset, the provider
generates in-tree under `seneca-provider/`, which is a usable default for a
first look at the output.

Set that in `model/project.aontu`, not in the target's own file — `target add`
overwrites the latter.

## Or the provider carries its own builder

The provider repository can instead hold a `.sdk/` of its own, which generates
the provider and nothing else, and leaves the SDK repository untouched. Its
`model/project.aontu` says so, and the standard `Root` that create-sdkgen
scaffolds reads it:

```
main: kit: phase: top: active: false
main: kit: phase: build: active: false
main: kit: doc: active: false
main: kit: target: 'seneca-provider': output: root: true
main: kit: target: 'seneca-provider': sdk: version: '0.0.1'
```

`output: root: true` generates the provider at the repository root, and is how
this target knows the builder is the provider's own. That builder has no `ts`
target, so it names the SDK itself: `sdk.version` is required, and
`sdk.package` overrides the derived package name. Both are refused in an SDK
project, where the `ts` target is the SDK.

The builder carries a copy of the SDK's API definition and guide. `make regen`
copies them from the SDK fetched at the tag in `sdk-pin.json` before
generating, and generation refuses to write when the builder's entities differ
from that SDK's compiled model, or the package name or version differ from its
own `ts/package.json`. The manifest is read rather than the name re-derived,
because the SDK's generator may name packages by a rule this builder's does not
share. Generated without the SDK fetched, it warns that the check did not run.

To move to a newer SDK, set `sdk.version` and fetch its tag as you regenerate:

```bash
make regen SDK_TAG=v0.0.2
```

## An SDK that is not on npm yet

The generated `package.json` depends on the SDK by version range, which
installs only once the SDK is published. Until then, `sdk.dep` points it
elsewhere:

| `sdk.dep` | The dependency |
|---|---|
| `kind: 'release', ref: 'v1.0.0'` | the `npm pack` tarball attached to that GitHub release |
| `kind: 'git', ref: '<tag>'` | `github:<owner>/<repo>#<tag>`, installed from the root of that tag's tree |
| `spec: '<anything>'` | the value, verbatim |

npm cannot install a package from a subfolder of a git repository, and an
sdkgen SDK keeps its TypeScript package in `ts/`. A git dependency therefore
needs a tag whose tree is that folder, cut in the SDK repository:

```bash
git tag ts-v1.0.0 $(git commit-tree HEAD:ts -p HEAD -m "ts/ at v1.0.0")
git push origin ts-v1.0.0
```

and then `sdk: dep: { kind: 'git', ref: 'ts-v1.0.0' }`. The tag carries what
the folder holds, so an SDK that commits `ts/dist` needs nothing built on
install. The generated CI passes `--allow-git=all`, which npm 12 needs for a
git dependency, and so would anyone installing a published provider that
depends on one: publish the SDK to npm before the provider.

## Parity

Every target here declares `CONSUMER`. That is not a coverage tier alongside
`FULL`, `MIRRORED` and `UNCOVERED`, which grade a language target against the
shared corpus. A consumer target has no utility layer to measure, so it is
outside that system — and says so, rather than omitting the field, which cannot
be told apart from an author who did not know it existed.

## Developing

```bash
npm install
npm test          # the comment gate, the dependency gate, then the suite
```

A committed dependency must name a published npm package or a GitHub
reference; local wiring to a sibling checkout is how a change gets tested
before its dependency is released, and undoing it is part of finishing.
`make deps` checks that and `make deps-test` runs its own suite; `npm test`,
the pre-push hook and CI all run the gate, so it cannot be forgotten.

The suite runs on `@voxgig/sdkgen/testkit`: it installs this package into a
staged consumer through the real `package add`, compiles the components the way
a consumer's build does, and generates.

Two tests **skip** against a published sdkgen whose test kit predates the
`outside` option, which is what lets a suite express out-of-tree generation at
all. They report the skip rather than passing quietly, and start running as
soon as that release lands.

Validate the package itself with:

```bash
npx voxgig-sdkgen package check .
```

## Releasing — OIDC dispatch, never a local publish

**NOTHING IS PUBLISHED FROM A WORKSTATION.** The release is performed by
GitHub Actions over OIDC trusted publishing, and the way you start it is a
workflow dispatch:

```bash
gh workflow run publish.yml --ref main -f expect_sha=$(git rev-parse HEAD)
```

Bump the version in **both** `package.json` and `sdkgen-package.json` first,
on `main`, in a reviewable commit — nothing in the workflow commits. The
workflow verifies, publishes to npm, then tags `v<version>`.

Never `npm publish` from a checkout: it goes out over a stored token with no
provenance. The one exception is a package's very first version, which npm
gives no way to automate — see [`release/README.md`](release/README.md), which
carries the full record, the `npm trust` registration, and what the 404 at the
end of a green run actually means.

Never hand a release back as "run this locally yourself". A release is a
dispatch: prepare the commit, then dispatch the workflow.

## Provenance

`seneca-provider` was generated from the same trees that shipped inside
`@voxgig/sdkgen`. Before it moved, its output was compared file by file against
the bundled version from the same model: **21 files, 0 differences**, identical
warnings and an identical placeholder scan. Nothing about a generated provider
changed in the move.
