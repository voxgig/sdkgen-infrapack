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
wraps, deliberately. Add `ts` to your project before `seneca-provider`.

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

Set that in `model/project.aon`, not in the target's own file — `target add`
overwrites the latter.

## Parity

Every target here declares `CONSUMER`. That is not a coverage tier alongside
`FULL`, `MIRRORED` and `UNCOVERED`, which grade a language target against the
shared corpus. A consumer target has no utility layer to measure, so it is
outside that system — and says so, rather than omitting the field, which cannot
be told apart from an author who did not know it existed.

## Developing

```bash
npm install
npm test          # type-checks the components, then runs the suite
```

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

## Provenance

`seneca-provider` was generated from the same trees that shipped inside
`@voxgig/sdkgen`. Before it moved, its output was compared file by file against
the bundled version from the same model: **21 files, 0 differences**, identical
warnings and an identical placeholder scan. Nothing about a generated provider
changed in the move.
