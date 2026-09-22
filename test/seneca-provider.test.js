// The Seneca provider target's own suite.
//
// These tests used to live in sdkgen's `recordkey.test.ts`,
// `seedrecord.test.ts`, `generate.test.ts` and `external.test.ts`. They moved
// here with the target, which is the point of migrating: the target's
// coverage travels with the target, and sdkgen's closed guard suites shrink
// by exactly the target that left them.
//
// Two kinds of test live here, and they load the components differently on
// purpose:
//
//   - GENERATION tests run on `@voxgig/sdkgen/testkit`, so the pipeline under
//     test is the real one — `package add` installs this package into a
//     staged consumer, the consumer's components are compiled the way its own
//     build compiles them, and generation runs from `.sdk`.
//   - UNIT tests on an exported helper load the built component and
//     call the function directly. That is how they were written in sdkgen and
//     it is still the right shape: the cases below are hand-built model
//     fragments from real APIs, and driving them through a whole generation
//     would test the fragment's plumbing rather than the function.

const { test, describe, before, after } = require('node:test')
const { ok, strictEqual, deepStrictEqual } = require('node:assert')

const Fs = require('node:fs')
const Path = require('node:path')
const Os = require('node:os')
const { execFileSync } = require('node:child_process')

const { Aontu } = require('aontu')
const { Script } = require('node:vm')

const { stageConsumer, generateInto } = require('@voxgig/sdkgen/testkit')


const PKG = Path.resolve(__dirname, '..')
const CMP = Path.join(PKG, '.build', 'cmp', 'seneca-provider')


// Load a built component and hand back its exports.
//
// `@voxgig/sdkgen` is shimmed to the resolved package rather than left to
// Node: the component requires it by bare name, which is right for a consumer
// (it has the dependency) and resolvable here only because this package
// devDepends on it. Shimming keeps the two readings the same one.
function loadComponent(file, extraShims = {}) {
  const path = Path.join(CMP, file.replace(/\.ts$/, '.js'))
  const js = Fs.readFileSync(path, 'utf8')

  const shims = { '@voxgig/sdkgen': require('@voxgig/sdkgen'), ...extraShims }
  const req = (p) => (p in shims ? shims[p] : require(p))

  const mod = { exports: {} }
  const fn = new Function(
    'exports', 'require', 'module', '__dirname', '__filename', js)
  fn(mod.exports, req, mod, Path.dirname(path), path)
  return mod.exports
}


// The API this target is generated from. Small, but carrying the shapes that
// have historically broken provider generation: an entity with a full CRUD
// set and an id binding, a required and an optional field, and a load op with
// a real path param.
const API = `
main: kit: info: { title: 'Demo', version: '1.0.0', auth: false }
main: kit: config: headers: { 'content-type': 'application/json' }

main: kit: entity: planet: {
  alias: field: {}
  name: "planet"
  id: { field: "id", name: "id" }
  field: {
    id:     { name: "id",     kind: "field", type: "\`$STRING\`", required: true }
    title:  { name: "title",  kind: "field", type: "\`$STRING\`", required: true }
    radius: { name: "radius", kind: "field", type: "\`$NUMBER\`" }
  }
  fields: {
    "id": { h: 'Id', n: "id",     r: true,  t: "\`$STRING\`" }
    "radius": { h: 'Radius', n: "radius", r: false, t: "\`$NUMBER\`" }
    "title": { h: 'Title', n: "title",  r: true,  t: "\`$STRING\`" }
  }
  op: {
    list: { name: "list", points: [ {
      g: {}, m: "GET", o: "/planet", s: [{ lit: "planet" }]
      t: { req: "\`reqdata\`", res: "\`body\`" } } ] }
    load: { name: "load", points: [ {
      g: { params: [
        { k: "param", n: "id", or: "id", r: true, t: "\`$STRING\`", ex: "p01" }
      ] }
      m: "GET", o: "/planet/{id}", s: [{ lit: "planet" }, { var: "id" }]
      t: { req: "\`reqdata\`", res: "\`body\`" } } ] }
    create: { name: "create", points: [ {
      g: { body: [ { k: "body", n: "title", r: true, t: "\`$STRING\`" } ] }
      m: "POST", o: "/planet", s: [{ lit: "planet" }]
      t: { req: "\`reqdata\`", res: "\`body\`" } } ] }
    update: { name: "update", points: [ {
      g: {
        params: [ { k: "param", n: "id", or: "id", r: true, t: "\`$STRING\`", ex: "p01" } ]
        body: [ { k: "body", n: "title", r: false, t: "\`$STRING\`" } ]
      }
      m: "PATCH", o: "/planet/{id}", s: [{ lit: "planet" }, { var: "id" }]
      t: { req: "\`reqdata\`", res: "\`body\`" } } ] }
    remove: { name: "remove", points: [ {
      g: { params: [
        { k: "param", n: "id", or: "id", r: true, t: "\`$STRING\`", ex: "p01" }
      ] }
      m: "DELETE", o: "/planet/{id}", s: [{ lit: "planet" }, { var: "id" }]
      t: { req: "\`reqdata\`", res: "\`body\`" } } ] }
  }
}

main: kit: flow: BasicPlanetFlow: {
  entity: "planet", kind: "basic", name: "BasicPlanetFlow"
  step: [
    { o: "create", i: { ref: "planet_ref01" } }
    { o: "list" }
    { o: "update", i: {
        ref: "planet_ref01", srcdatavar: "planet_ref01_data",
        suffix: "_up0", textfield: "title" } }
    { o: "load", i: {
        ref: "planet_ref01", srcdatavar: "planet_ref01_data", suffix: "_dt0" } }
    { o: "remove", i: { ref: "planet_ref01", suffix: "_rm0" } }
  ]
}
`


// A second entity whose name leads with a digit — what apidef produces for a
// resource like `/3ds-sessions`.
const DIGIT_ENTITY = `
main: kit: entity: '3ds_session': {
  alias: field: {}
  name: "3ds_session"
  id: { field: "id", name: "id" }
  field: {
    id: { name: "id", kind: "field", type: "\`$STRING\`", required: true }
  }
  fields: { "id": { h: 'Id', n: "id", r: true, t: "\`$STRING\`" } }
  op: {
    list: { name: "list", points: [ {
      g: {}, m: "GET", o: "/3ds-session", s: [{ lit: "3ds-session" }]
      t: { req: "\`reqdata\`", res: "\`body\`" } } ] }
    load: { name: "load", points: [ {
      g: { params: [
        { k: "param", n: "id", or: "id", r: true, t: "\`$STRING\`", ex: "s01" }
      ] }
      m: "GET", o: "/3ds-session/{id}", s: [{ lit: "3ds-session" }, { var: "id" }]
      t: { req: "\`reqdata\`", res: "\`body\`" } } ] }
  }
}

main: kit: flow: Basic3dsSessionFlow: {
  entity: "3ds_session", kind: "basic", name: "Basic3dsSessionFlow"
  step: [
    { o: "list" }
    { o: "load", i: {
        ref: "3ds_session_ref01", srcdatavar: "3ds_session_ref01_data", suffix: "_dt0" } }
  ]
}
`


// AN ENTITY WITH CUSTOM ACTIONS, mirroring github-sdk's real `pull`.
//
// `update` carries the canonical PATCH plus a `merge` ACTION point — apidef's
// shape for GitHub's `PUT /repos/{owner}/{repo}/pulls/{n}/merge`, the case
// this whole mechanism exists for. `create` carries a second action, so
// `save$` has to route by the op that owns the action rather than assuming
// `update`: `upload_image` on an entity carrying an id is still a create.
const ACTION_ENTITY = `
main: kit: entity: pull: {
  alias: field: {}
  name: "pull"
  id: { field: "id", name: "id" }
  field: {
    id:    { name: "id",    kind: "field", type: "\`$STRING\`", required: true }
    title: { name: "title", kind: "field", type: "\`$STRING\`", required: true }
  }
  fields: {
    "id": { h: 'Id', n: "id",    r: true, t: "\`$STRING\`" }
    "title": { h: 'Title', n: "title", r: true, t: "\`$STRING\`" }
  }
  op: {
    list: { name: "list", points: [ {
      g: {}, m: "GET", o: "/pull", s: [{ lit: "pull" }]
      t: { req: "\`reqdata\`", res: "\`body\`" } } ] }
    load: { name: "load", points: [ {
      g: { params: [
        { k: "param", n: "id", or: "id", r: true, t: "\`$STRING\`", ex: "p01" }
      ] }
      m: "GET", o: "/pull/{id}", s: [{ lit: "pull" }, { var: "id" }]
      t: { req: "\`reqdata\`", res: "\`body\`" } } ] }
    create: {
      name: "create"
      points: [
        {
          g: { body: [ { k: "body", n: "title", r: true, t: "\`$STRING\`" } ] }
          m: "POST", o: "/pull", s: [{ lit: "pull" }]
          t: { req: "\`reqdata\`", res: "\`body\`" }
        }
        {
          g: {
            params: [ { k: "param", n: "id", or: "id", r: true, t: "\`$STRING\`", ex: "p01" } ]
            body: [ { k: "body", n: "image", r: false, t: "\`$STRING\`" } ]
          }
          m: "POST", o: "/pull/{id}/image"
          s: [{ lit: "pull" }, { var: "id" }, { lit: "image" }]
          q: { '$action': "upload_image", exist: [ "id" ] }
          t: { req: "\`reqdata\`", res: "\`body\`" }
        }
      ]
    }
    update: {
      name: "update"
      points: [
        {
          g: {
            params: [ { k: "param", n: "id", or: "id", r: true, t: "\`$STRING\`", ex: "p01" } ]
            body: [ { k: "body", n: "title", r: false, t: "\`$STRING\`" } ]
          }
          m: "PATCH", o: "/pull/{id}", s: [{ lit: "pull" }, { var: "id" }]
          t: { req: "\`reqdata\`", res: "\`body\`" }
        }
        {
          g: {
            params: [ { k: "param", n: "id", or: "id", r: true, t: "\`$STRING\`", ex: "p01" } ]
            body: [ { k: "body", n: "commit_title", r: false, t: "\`$STRING\`" } ]
          }
          m: "PUT", o: "/pull/{id}/merge"
          s: [{ lit: "pull" }, { var: "id" }, { lit: "merge" }]
          q: { '$action': "merge", exist: [ "id" ] }
          t: { req: "\`reqdata\`", res: "\`body\`" }
        }
      ]
    }
    remove: { name: "remove", points: [ {
      g: { params: [
        { k: "param", n: "id", or: "id", r: true, t: "\`$STRING\`", ex: "p01" }
      ] }
      m: "DELETE", o: "/pull/{id}", s: [{ lit: "pull" }, { var: "id" }]
      t: { req: "\`reqdata\`", res: "\`body\`" } } ] }
  }
}

main: kit: flow: BasicPullFlow: {
  entity: "pull", kind: "basic", name: "BasicPullFlow"
  step: [
    { o: "create", i: { ref: "pull_ref01" } }
    { o: "list" }
    { o: "update", i: {
        ref: "pull_ref01", srcdatavar: "pull_ref01_data",
        suffix: "_up0", textfield: "title" } }
    { o: "load", i: {
        ref: "pull_ref01", srcdatavar: "pull_ref01_data", suffix: "_dt0" } }
    { o: "remove", i: { ref: "pull_ref01", suffix: "_rm0" } }
  ]
}
`


// AN ENTITY WHOSE ONLY WRITE OP IS AN ACTION. Its `update` has a single
// point and that point is an action route — the entity has no plain update
// at all. It must still generate a `save$`: dropping the entity, or the cmd,
// leaves the action unreachable, which is the state this change is fixing.
const ACTION_ONLY_ENTITY = `
main: kit: entity: badge: {
  alias: field: {}
  name: "badge"
  id: { field: "id", name: "id" }
  field: {
    id: { name: "id", kind: "field", type: "\`$STRING\`", required: true }
  }
  fields: { "id": { h: 'Id', n: "id", r: true, t: "\`$STRING\`" } }
  op: {
    list: { name: "list", points: [ {
      g: {}, m: "GET", o: "/badge", s: [{ lit: "badge" }]
      t: { req: "\`reqdata\`", res: "\`body\`" } } ] }
    update: { name: "update", points: [ {
      g: {
        params: [ { k: "param", n: "id", or: "id", r: true, t: "\`$STRING\`", ex: "b01" } ]
        body: [ { k: "body", n: "reason", r: false, t: "\`$STRING\`" } ]
      }
      m: "POST", o: "/badge/{id}/award"
      s: [{ lit: "badge" }, { var: "id" }, { lit: "award" }]
      q: { '$action': "award", exist: [ "id" ] }
      t: { req: "\`reqdata\`", res: "\`body\`" } } ] }
  }
}

main: kit: flow: BasicBadgeFlow: {
  entity: "badge", kind: "basic", name: "BasicBadgeFlow"
  step: [ { o: "list" } ]
}
`


// AN ENTITY WHOSE ACTION ROUTE IS SHALLOWER THAN ITS CANONICAL ONE.
//
// Zoom's shape: the canonical update is `/user/{user_id}/meeting/{id}` and
// needs the parent, while the `status` action hangs off `/meeting/{id}` and
// does not. The guards are computed from the CANONICAL points (opParams drops
// action points), so a guard emitted ahead of the action branch demands a key
// the action's own route has no segment for.
//
// `remove` carries an action too, whose response is the action's own — an
// archive record, not the deleted meeting.
const PARENT_ACTION_ENTITY = `
main: kit: entity: meeting: {
  alias: field: {}
  name: "meeting"
  id: { field: "id", name: "id" }
  field: {
    id:    { name: "id",    kind: "field", type: "\`$STRING\`", required: true }
    topic: { name: "topic", kind: "field", type: "\`$STRING\`", required: true }
  }
  fields: {
    "id": { h: 'Id', n: "id",    r: true, t: "\`$STRING\`" }
    "topic": { h: 'Topic', n: "topic", r: true, t: "\`$STRING\`" }
  }
  op: {
    list: { name: "list", points: [ {
      g: { params: [
        { k: "param", n: "user_id", or: "user_id", r: true, t: "\`$STRING\`", ex: "u01" }
      ] }
      m: "GET", o: "/user/{user_id}/meeting"
      s: [{ lit: "user" }, { var: "user_id" }, { lit: "meeting" }]
      t: { req: "\`reqdata\`", res: "\`body\`" } } ] }
    load: { name: "load", points: [ {
      g: { params: [
        { k: "param", n: "user_id", or: "user_id", r: true, t: "\`$STRING\`", ex: "u01" }
        { k: "param", n: "id", or: "id", r: true, t: "\`$STRING\`", ex: "m01" }
      ] }
      m: "GET", o: "/user/{user_id}/meeting/{id}"
      s: [{ lit: "user" }, { var: "user_id" }, { lit: "meeting" }, { var: "id" }]
      t: { req: "\`reqdata\`", res: "\`body\`" } } ] }
    update: {
      name: "update"
      points: [
        {
          g: {
            params: [
              { k: "param", n: "user_id", or: "user_id", r: true, t: "\`$STRING\`", ex: "u01" }
              { k: "param", n: "id", or: "id", r: true, t: "\`$STRING\`", ex: "m01" }
            ]
            body: [ { k: "body", n: "topic", r: false, t: "\`$STRING\`" } ]
          }
          m: "PATCH", o: "/user/{user_id}/meeting/{id}"
          s: [{ lit: "user" }, { var: "user_id" }, { lit: "meeting" }, { var: "id" }]
          t: { req: "\`reqdata\`", res: "\`body\`" }
        }
        {
          g: {
            params: [ { k: "param", n: "id", or: "id", r: true, t: "\`$STRING\`", ex: "m01" } ]
            body: [ { k: "body", n: "state", r: false, t: "\`$STRING\`" } ]
          }
          m: "PUT", o: "/meeting/{id}/status"
          s: [{ lit: "meeting" }, { var: "id" }, { lit: "status" }]
          q: { '$action': "status", exist: [ "id" ] }
          t: { req: "\`reqdata\`", res: "\`body\`" }
        }
      ]
    }
    remove: {
      name: "remove"
      points: [
        {
          g: { params: [
            { k: "param", n: "user_id", or: "user_id", r: true, t: "\`$STRING\`", ex: "u01" }
            { k: "param", n: "id", or: "id", r: true, t: "\`$STRING\`", ex: "m01" }
          ] }
          m: "DELETE", o: "/user/{user_id}/meeting/{id}"
          s: [{ lit: "user" }, { var: "user_id" }, { lit: "meeting" }, { var: "id" }]
          t: { req: "\`reqdata\`", res: "\`body\`" }
        }
        {
          g: { params: [
            { k: "param", n: "id", or: "id", r: true, t: "\`$STRING\`", ex: "m01" }
          ] }
          m: "POST", o: "/meeting/{id}/archive"
          s: [{ lit: "meeting" }, { var: "id" }, { lit: "archive" }]
          q: { '$action': "archive", exist: [ "id" ] }
          t: { req: "\`reqdata\`", res: "\`body\`" }
        }
      ]
    }
  }
}

main: kit: flow: BasicMeetingFlow: {
  entity: "meeting", kind: "basic", name: "BasicMeetingFlow"
  step: [ { o: "list" } ]
}
`


// AN ENTITY WITH A SAVE ACTION, A MUTABLE FIELD AND NO `load` CMD, whose only
// update point is the action. Nothing here can perform a plain id-bearing
// save, and nothing can load a record to mutate — so a generated test that
// does both fails in a package whose supported action works perfectly.
const NO_LOAD_ENTITY = `
main: kit: entity: alert: {
  alias: field: {}
  name: "alert"
  id: { field: "id", name: "id" }
  field: {
    id:   { name: "id",   kind: "field", type: "\`$STRING\`", required: true }
    note: { name: "note", kind: "field", type: "\`$STRING\`", required: true }
  }
  fields: {
    "id": { h: 'Id', n: "id",   r: true, t: "\`$STRING\`" }
    "note": { h: 'Note', n: "note", r: true, t: "\`$STRING\`" }
  }
  op: {
    list: { name: "list", points: [ {
      g: {}, m: "GET", o: "/alert", s: [{ lit: "alert" }]
      t: { req: "\`reqdata\`", res: "\`body\`" } } ] }
    update: { name: "update", points: [ {
      g: {
        params: [ { k: "param", n: "id", or: "id", r: true, t: "\`$STRING\`", ex: "a01" } ]
        body: [ { k: "body", n: "note", r: false, t: "\`$STRING\`" } ]
      }
      m: "POST", o: "/alert/{id}/ack"
      s: [{ lit: "alert" }, { var: "id" }, { lit: "ack" }]
      q: { '$action': "ack", exist: [ "id" ] }
      t: { req: "\`reqdata\`", res: "\`body\`" } } ] }
  }
}

main: kit: flow: BasicAlertFlow: {
  entity: "alert", kind: "basic", name: "BasicAlertFlow"
  step: [ { o: "list" } ]
}
`


// AN ENTITY THE API KEYS BY `username`, NOT `id` — github's user, in
// miniature. Its response carries an `id` of its own, unrelated to the key,
// and an `owner` OBJECT under a name a path parameter could also take.
const ACCOUNT_ENTITY = `
main: kit: entity: account: {
  alias: field: {}
  name: "account"
  id: { field: "id", name: "id" }
  field: {
    id:       { name: "id",       kind: "field", type: "\`$NUMBER\`" }
    username: { name: "username", kind: "field", type: "\`$STRING\`", required: true }
    owner:    { name: "owner",    kind: "field", type: "\`$OBJECT\`" }
    bio:      { name: "bio",      kind: "field", type: "\`$STRING\`" }
  }
  fields: {
    "id":       { h: 'Id', n: "id",       r: false, t: "\`$NUMBER\`" }
    "username": { h: 'Username', n: "username", r: true,  t: "\`$STRING\`" }
    "owner":    { h: 'Owner', n: "owner",    r: false, t: "\`$OBJECT\`" }
    "bio":      { h: 'Bio', n: "bio",      r: false, t: "\`$STRING\`" }
  }
  op: {
    list: { name: "list", points: [ {
      g: {}, m: "GET", o: "/account", s: [{ lit: "account" }]
      t: { req: "\`reqdata\`", res: "\`body\`" } } ] }
    load: { name: "load", points: [ {
      g: { params: [
        { k: "param", n: "username", or: "username", r: true, t: "\`$STRING\`", ex: "u01" }
      ] }
      m: "GET", o: "/account/{username}", s: [{ lit: "account" }, { var: "username" }]
      t: { req: "\`reqdata\`", res: "\`body\`" } } ] }
    create: { name: "create", points: [ {
      g: { body: [
        { k: "body", n: "username", r: true, t: "\`$STRING\`" }
        { k: "body", n: "bio", r: false, t: "\`$STRING\`" }
      ] }
      m: "POST", o: "/account", s: [{ lit: "account" }]
      t: { req: "\`reqdata\`", res: "\`body\`" } } ] }
    update: { name: "update", points: [ {
      g: {
        params: [ { k: "param", n: "username", or: "username", r: true, t: "\`$STRING\`", ex: "u01" } ]
        body: [ { k: "body", n: "bio", r: false, t: "\`$STRING\`" } ]
      }
      m: "PATCH", o: "/account/{username}", s: [{ lit: "account" }, { var: "username" }]
      t: { req: "\`reqdata\`", res: "\`body\`" } } ] }
    remove: { name: "remove", points: [ {
      g: { params: [
        { k: "param", n: "username", or: "username", r: true, t: "\`$STRING\`", ex: "u01" }
      ] }
      m: "DELETE", o: "/account/{username}", s: [{ lit: "account" }, { var: "username" }]
      t: { req: "\`reqdata\`", res: "\`body\`" } } ] }
  }
}

main: kit: flow: BasicAccountFlow: {
  entity: "account", kind: "basic", name: "BasicAccountFlow"
  step: [ { o: "list" } ]
}
`


// A COMPOSITE KEY, as apidef derives for github's repo: two path parameters
// address one record, and the response carries them elsewhere — the owner
// inside an object, the repo under \`name\`.
const REPO_ENTITY = `
main: kit: entity: repo: {
  alias: field: {}
  name: "repo"
  id: { field: "id", name: "id", parts: ["owner", "repo"], sep: "/", from: { owner: "owner.login", repo: "name" } }
  field: {
    id:          { name: "id",          kind: "field", type: "\`$STRING\`" }
    name:        { name: "name",        kind: "field", type: "\`$STRING\`", required: true }
    owner:       { name: "owner",       kind: "field", type: "\`$OBJECT\`" }
    description: { name: "description", kind: "field", type: "\`$STRING\`" }
  }
  fields: {
    "id":          { h: 'Id', n: "id",          r: false, t: "\`$STRING\`" }
    "name":        { h: 'Name', n: "name",        r: true,  t: "\`$STRING\`" }
    "owner":       { h: 'Owner', n: "owner",       r: false, t: "\`$OBJECT\`" }
    "description": { h: 'Description', n: "description", r: false, t: "\`$STRING\`" }
  }
  op: {
    list: { name: "list", points: [ {
      g: {}, m: "GET", o: "/repos", s: [{ lit: "repos" }]
      t: { req: "\`reqdata\`", res: "\`body\`" } } ] }
    load: { name: "load", points: [ {
      g: { params: [
        { k: "param", n: "owner", or: "owner", r: true, t: "\`$STRING\`", ex: "o01" }
        { k: "param", n: "repo", or: "repo", r: true, t: "\`$STRING\`", ex: "r01" }
      ] }
      m: "GET", o: "/repos/{owner}/{repo}", s: [{ lit: "repos" }, { var: "owner" }, { var: "repo" }]
      t: { req: "\`reqdata\`", res: "\`body\`" } } ] }
    create: { name: "create", points: [ {
      g: { body: [
        { k: "body", n: "name", r: true, t: "\`$STRING\`" }
        { k: "body", n: "description", r: false, t: "\`$STRING\`" }
      ] }
      m: "POST", o: "/user/repos", s: [{ lit: "user" }, { lit: "repos" }]
      t: { req: "\`reqdata\`", res: "\`body\`" } } ] }
    update: { name: "update", points: [ {
      g: {
        params: [
          { k: "param", n: "owner", or: "owner", r: true, t: "\`$STRING\`", ex: "o01" }
          { k: "param", n: "repo", or: "repo", r: true, t: "\`$STRING\`", ex: "r01" }
        ]
        body: [ { k: "body", n: "description", r: false, t: "\`$STRING\`" } ]
      }
      m: "PATCH", o: "/repos/{owner}/{repo}", s: [{ lit: "repos" }, { var: "owner" }, { var: "repo" }]
      t: { req: "\`reqdata\`", res: "\`body\`" } } ] }
    remove: { name: "remove", points: [ {
      g: { params: [
        { k: "param", n: "owner", or: "owner", r: true, t: "\`$STRING\`", ex: "o01" }
        { k: "param", n: "repo", or: "repo", r: true, t: "\`$STRING\`", ex: "r01" }
      ] }
      m: "DELETE", o: "/repos/{owner}/{repo}", s: [{ lit: "repos" }, { var: "owner" }, { var: "repo" }]
      t: { req: "\`reqdata\`", res: "\`body\`" } } ] }
  }
}

main: kit: flow: BasicRepoFlow: {
  entity: "repo", kind: "basic", name: "BasicRepoFlow"
  step: [ { o: "list" } ]
}
`


// A PARENT PARAMETER THAT IS NOT A JAVASCRIPT IDENTIFIER. Entity names are
// canonized; parameter names are not, so a hyphen reaches the model. The
// entity also has create and remove but NO update, so a round-trip that
// saved a loaded record again would create twice.
const LEDGER_ENTITY = `
main: kit: entity: ledger: {
  alias: field: {}
  name: "ledger"
  id: { field: "id", name: "id" }
  field: {
    id:   { name: "id",   kind: "field", type: "\`$STRING\`", required: true }
    memo: { name: "memo", kind: "field", type: "\`$STRING\`", required: true }
  }
  fields: {
    "id":   { h: 'Id', n: "id",   r: true, t: "\`$STRING\`" }
    "memo": { h: 'Memo', n: "memo", r: true, t: "\`$STRING\`" }
  }
  op: {
    list: { name: "list", points: [ {
      g: { params: [
        { k: "param", n: "account-id", or: "account-id", r: true, t: "\`$STRING\`", ex: "a01" }
      ] }
      m: "GET", o: "/account/{account-id}/ledger"
      s: [{ lit: "account" }, { var: "account-id" }, { lit: "ledger" }]
      t: { req: "\`reqdata\`", res: "\`body\`" } } ] }
    load: { name: "load", points: [ {
      g: { params: [
        { k: "param", n: "account-id", or: "account-id", r: true, t: "\`$STRING\`", ex: "a01" }
        { k: "param", n: "id", or: "id", r: true, t: "\`$STRING\`", ex: "l01" }
      ] }
      m: "GET", o: "/account/{account-id}/ledger/{id}"
      s: [{ lit: "account" }, { var: "account-id" }, { lit: "ledger" }, { var: "id" }]
      t: { req: "\`reqdata\`", res: "\`body\`" } } ] }
    create: { name: "create", points: [ {
      g: {
        params: [ { k: "param", n: "account-id", or: "account-id", r: true, t: "\`$STRING\`", ex: "a01" } ]
        body: [ { k: "body", n: "memo", r: true, t: "\`$STRING\`" } ]
      }
      m: "POST", o: "/account/{account-id}/ledger"
      s: [{ lit: "account" }, { var: "account-id" }, { lit: "ledger" }]
      t: { req: "\`reqdata\`", res: "\`body\`" } } ] }
    remove: { name: "remove", points: [ {
      g: { params: [
        { k: "param", n: "account-id", or: "account-id", r: true, t: "\`$STRING\`", ex: "a01" }
        { k: "param", n: "id", or: "id", r: true, t: "\`$STRING\`", ex: "l01" }
      ] }
      m: "DELETE", o: "/account/{account-id}/ledger/{id}"
      s: [{ lit: "account" }, { var: "account-id" }, { lit: "ledger" }, { var: "id" }]
      t: { req: "\`reqdata\`", res: "\`body\`" } } ] }
  }
}

main: kit: flow: BasicLedgerFlow: {
  entity: "ledger", kind: "basic", name: "BasicLedgerFlow"
  step: [ { o: "list" } ]
}
`


// UPDATE AND REMOVE, BUT NO CREATE: a round-trip has nothing of its own to
// write, so none can be generated.
const SETTING_ENTITY = `
main: kit: entity: setting: {
  alias: field: {}
  name: "setting"
  id: { field: "id", name: "id" }
  field: {
    id:    { name: "id",    kind: "field", type: "\`$STRING\`", required: true }
    value: { name: "value", kind: "field", type: "\`$STRING\`", required: true }
  }
  fields: {
    "id":    { h: 'Id', n: "id",    r: true, t: "\`$STRING\`" }
    "value": { h: 'Value', n: "value", r: true, t: "\`$STRING\`" }
  }
  op: {
    load: { name: "load", points: [ {
      g: { params: [
        { k: "param", n: "id", or: "id", r: true, t: "\`$STRING\`", ex: "s01" }
      ] }
      m: "GET", o: "/setting/{id}", s: [{ lit: "setting" }, { var: "id" }]
      t: { req: "\`reqdata\`", res: "\`body\`" } } ] }
    update: { name: "update", points: [ {
      g: {
        params: [ { k: "param", n: "id", or: "id", r: true, t: "\`$STRING\`", ex: "s01" } ]
        body: [ { k: "body", n: "value", r: false, t: "\`$STRING\`" } ]
      }
      m: "PUT", o: "/setting/{id}", s: [{ lit: "setting" }, { var: "id" }]
      t: { req: "\`reqdata\`", res: "\`body\`" } } ] }
    remove: { name: "remove", points: [ {
      g: { params: [
        { k: "param", n: "id", or: "id", r: true, t: "\`$STRING\`", ex: "s01" }
      ] }
      m: "DELETE", o: "/setting/{id}", s: [{ lit: "setting" }, { var: "id" }]
      t: { req: "\`reqdata\`", res: "\`body\`" } } ] }
  }
}

main: kit: flow: BasicSettingFlow: {
  entity: "setting", kind: "basic", name: "BasicSettingFlow"
  step: [ { o: "load", i: {
    ref: "setting_ref01", srcdatavar: "setting_ref01_data", suffix: "_dt0" } } ]
}
`


// CREATE NEEDS A PARENT THE UPDATE DOES NOT: a project is created inside an
// org and addressed by its own id from then on. The guard for \`org\` belongs
// to the create branch alone.
const PROJECT_ENTITY = `
main: kit: entity: project: {
  alias: field: {}
  name: "project"
  id: { field: "id", name: "id" }
  field: {
    id:    { name: "id",    kind: "field", type: "\`$STRING\`", required: true }
    title: { name: "title", kind: "field", type: "\`$STRING\`", required: true }
  }
  fields: {
    "id":    { h: 'Id', n: "id",    r: true, t: "\`$STRING\`" }
    "title": { h: 'Title', n: "title", r: true, t: "\`$STRING\`" }
  }
  op: {
    load: { name: "load", points: [ {
      g: { params: [
        { k: "param", n: "id", or: "id", r: true, t: "\`$STRING\`", ex: "p01" }
      ] }
      m: "GET", o: "/project/{id}", s: [{ lit: "project" }, { var: "id" }]
      t: { req: "\`reqdata\`", res: "\`body\`" } } ] }
    create: { name: "create", points: [ {
      g: {
        params: [ { k: "param", n: "org", or: "org", r: true, t: "\`$STRING\`", ex: "o01" } ]
        body: [ { k: "body", n: "title", r: true, t: "\`$STRING\`" } ]
      }
      m: "POST", o: "/org/{org}/project", s: [{ lit: "org" }, { var: "org" }, { lit: "project" }]
      t: { req: "\`reqdata\`", res: "\`body\`" } } ] }
    update: { name: "update", points: [ {
      g: {
        params: [ { k: "param", n: "id", or: "id", r: true, t: "\`$STRING\`", ex: "p01" } ]
        body: [ { k: "body", n: "title", r: false, t: "\`$STRING\`" } ]
      }
      m: "PATCH", o: "/project/{id}", s: [{ lit: "project" }, { var: "id" }]
      t: { req: "\`reqdata\`", res: "\`body\`" } } ] }
    remove: { name: "remove", points: [ {
      g: { params: [
        { k: "param", n: "id", or: "id", r: true, t: "\`$STRING\`", ex: "p01" }
      ] }
      m: "DELETE", o: "/project/{id}", s: [{ lit: "project" }, { var: "id" }]
      t: { req: "\`reqdata\`", res: "\`body\`" } } ] }
  }
}

main: kit: flow: BasicProjectFlow: {
  entity: "project", kind: "basic", name: "BasicProjectFlow"
  step: [ { o: "load", i: {
    ref: "project_ref01", srcdatavar: "project_ref01_data", suffix: "_dt0" } } ]
}
`


// A COMPOSITE KEY WITH AN ACTION ON A READ CMD. Two path parameters address
// one record and a third route — `/latest` — is folded into `load` as an
// action, so the action has to be handed the same two parameters the canonical
// read is, rather than the joined id under the terminal parameter's name.
const MIRROR_ENTITY = `
main: kit: entity: mirror: {
  alias: field: {}
  name: "mirror"
  id: { field: "id", name: "id", parts: ["owner", "slug"], sep: "/", from: { owner: "owner", slug: "slug" } }
  field: {
    id:    { name: "id",    kind: "field", type: "\`$STRING\`" }
    owner: { name: "owner", kind: "field", type: "\`$STRING\`", required: true }
    slug:  { name: "slug",  kind: "field", type: "\`$STRING\`", required: true }
    note:  { name: "note",  kind: "field", type: "\`$STRING\`" }
  }
  fields: {
    "id":    { h: 'Id', n: "id",    r: false, t: "\`$STRING\`" }
    "owner": { h: 'Owner', n: "owner", r: true,  t: "\`$STRING\`" }
    "slug":  { h: 'Slug', n: "slug",  r: true,  t: "\`$STRING\`" }
    "note":  { h: 'Note', n: "note",  r: false, t: "\`$STRING\`" }
  }
  op: {
    list: { name: "list", points: [ {
      g: {}, m: "GET", o: "/mirror", s: [{ lit: "mirror" }]
      t: { req: "\`reqdata\`", res: "\`body\`" } } ] }
    load: {
      name: "load"
      points: [
        {
          g: { params: [
            { k: "param", n: "owner", or: "owner", r: true, t: "\`$STRING\`", ex: "o01" }
            { k: "param", n: "slug", or: "slug", r: true, t: "\`$STRING\`", ex: "s01" }
          ] }
          m: "GET", o: "/mirror/{owner}/{slug}"
          s: [{ lit: "mirror" }, { var: "owner" }, { var: "slug" }]
          t: { req: "\`reqdata\`", res: "\`body\`" }
        }
        {
          g: { params: [
            { k: "param", n: "owner", or: "owner", r: true, t: "\`$STRING\`", ex: "o01" }
            { k: "param", n: "slug", or: "slug", r: true, t: "\`$STRING\`", ex: "s01" }
          ] }
          m: "GET", o: "/mirror/{owner}/{slug}/latest"
          s: [{ lit: "mirror" }, { var: "owner" }, { var: "slug" }, { lit: "latest" }]
          q: { '$action': "latest", exist: [ "owner", "slug" ] }
          t: { req: "\`reqdata\`", res: "\`body\`" }
        }
      ]
    }
  }
}

main: kit: flow: BasicMirrorFlow: {
  entity: "mirror", kind: "basic", name: "BasicMirrorFlow"
  step: [ { o: "list" } ]
}
`


// A KEY NAMED LIKE THE PROVIDER'S OWN BOOKKEEPING. The provider parks an
// unrelated API `id` under `<provider>_id`, so in a provider called `demo` the
// name `demo_id` is taken — and this entity, nested under `/demo/{demo_id}/`
// and keyed by `slug`, already has a required parent key of exactly that name.
// Named `emblem` rather than `badge` only so it does not collide with the
// action-only fixture above.
const EMBLEM_ENTITY = `
main: kit: entity: emblem: {
  alias: field: {}
  name: "emblem"
  id: { field: "id", name: "id" }
  field: {
    demo_id: { name: "demo_id", kind: "field", type: "\`$STRING\`", required: true }
    slug:    { name: "slug",    kind: "field", type: "\`$STRING\`", required: true }
    label:   { name: "label",   kind: "field", type: "\`$STRING\`", required: true }
  }
  fields: {
    "demo_id": { h: 'Demo', n: "demo_id", r: true, t: "\`$STRING\`" }
    "slug":    { h: 'Slug', n: "slug",    r: true, t: "\`$STRING\`" }
    "label":   { h: 'Label', n: "label",  r: true, t: "\`$STRING\`" }
  }
  op: {
    list: { name: "list", points: [ {
      g: { params: [
        { k: "param", n: "demo_id", or: "demo_id", r: true, t: "\`$STRING\`", ex: "d01" }
      ] }
      m: "GET", o: "/demo/{demo_id}/emblem"
      s: [{ lit: "demo" }, { var: "demo_id" }, { lit: "emblem" }]
      t: { req: "\`reqdata\`", res: "\`body\`" } } ] }
    load: { name: "load", points: [ {
      g: { params: [
        { k: "param", n: "demo_id", or: "demo_id", r: true, t: "\`$STRING\`", ex: "d01" }
        { k: "param", n: "slug", or: "slug", r: true, t: "\`$STRING\`", ex: "s01" }
      ] }
      m: "GET", o: "/demo/{demo_id}/emblem/{slug}"
      s: [{ lit: "demo" }, { var: "demo_id" }, { lit: "emblem" }, { var: "slug" }]
      t: { req: "\`reqdata\`", res: "\`body\`" } } ] }
    create: { name: "create", points: [ {
      g: {
        params: [ { k: "param", n: "demo_id", or: "demo_id", r: true, t: "\`$STRING\`", ex: "d01" } ]
        body: [
          { k: "body", n: "slug", r: true, t: "\`$STRING\`" }
          { k: "body", n: "label", r: true, t: "\`$STRING\`" }
        ]
      }
      m: "POST", o: "/demo/{demo_id}/emblem"
      s: [{ lit: "demo" }, { var: "demo_id" }, { lit: "emblem" }]
      t: { req: "\`reqdata\`", res: "\`body\`" } } ] }
    update: { name: "update", points: [ {
      g: {
        params: [
          { k: "param", n: "demo_id", or: "demo_id", r: true, t: "\`$STRING\`", ex: "d01" }
          { k: "param", n: "slug", or: "slug", r: true, t: "\`$STRING\`", ex: "s01" }
        ]
        body: [ { k: "body", n: "label", r: false, t: "\`$STRING\`" } ]
      }
      m: "PATCH", o: "/demo/{demo_id}/emblem/{slug}"
      s: [{ lit: "demo" }, { var: "demo_id" }, { lit: "emblem" }, { var: "slug" }]
      t: { req: "\`reqdata\`", res: "\`body\`" } } ] }
    remove: { name: "remove", points: [ {
      g: { params: [
        { k: "param", n: "demo_id", or: "demo_id", r: true, t: "\`$STRING\`", ex: "d01" }
        { k: "param", n: "slug", or: "slug", r: true, t: "\`$STRING\`", ex: "s01" }
      ] }
      m: "DELETE", o: "/demo/{demo_id}/emblem/{slug}"
      s: [{ lit: "demo" }, { var: "demo_id" }, { lit: "emblem" }, { var: "slug" }]
      t: { req: "\`reqdata\`", res: "\`body\`" } } ] }
  }
}

main: kit: flow: BasicEmblemFlow: {
  entity: "emblem", kind: "basic", name: "BasicEmblemFlow"
  step: [ { o: "list" } ]
}
`


// The generated TypeScript SDK, compiled and loaded, so a provider can be
// driven against the SDK's own offline mock transport rather than a stand-in.
// The SDK has no runtime dependencies; only the type roots are borrowed.
function compileSdk(files) {
  const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'infrapack-sdk-'))
  for (const [p, content] of Object.entries(files)) {
    if (p.startsWith('ts/src/')) {
      const dest = Path.join(dir, p.slice('ts/'.length))
      Fs.mkdirSync(Path.dirname(dest), { recursive: true })
      Fs.writeFileSync(dest, content)
    }
  }
  execFileSync(process.execPath, [
    Path.join(PKG, 'node_modules', 'typescript', 'bin', 'tsc'),
    '-p', Path.join(dir, 'src', 'tsconfig.json'),
    '--typeRoots', Path.join(PKG, 'node_modules', '@types'),
    '--noCheck', '--sourceMap', 'false',
  ], { cwd: PKG, stdio: 'inherit' })
  return { dir, module: require(Path.join(dir, 'dist', 'DemoSDK.js')) }
}


// Generated providers exist only during the test; compile them via npm too.
function compileProvider(src) {
  const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'infrapack-provider-'))
  try {
    const input = Path.join(dir, 'provider.cts')
    Fs.writeFileSync(input, src)
    execFileSync(process.execPath, [process.env.npm_execpath,
      'run', 'build:provider-test', '--', '--outDir', dir, input,
    ], { cwd: PKG, stdio: 'inherit' })
    return Fs.readFileSync(Path.join(dir, 'provider.cjs'), 'utf8')
  }
  finally {
    Fs.rmSync(dir, { recursive: true, force: true })
  }
}


// Load a GENERATED provider and hand back the entity cmd map it builds.
//
// The provider is a plain module: it requires its own package.json and the
// SDK, calls `this.export('provider/entityBuilder')`, and hands that builder
// the map of `entity.<name>.cmd.<cmd>.action` functions. Shimming those three
// things is enough to call one of those functions directly, with a recording
// SDK in `this.shared.sdk` — no Seneca, no SDK, no server, and the code under
// test is the emitted source rather than a paraphrase of it.
function loadProvider(files, name, sdkModule) {
  const path = Object.keys(files).find((p) => p.endsWith(`src/${name}.ts`))
  ok(null != path, 'no provider source generated:\n  ' +
    Object.keys(files).join('\n  '))

  const js = compileProvider(String(files[path]))

  const stub = { version: '0.0.0' }
  const req = (p) => p.endsWith('package.json') ? stub :
    null != sdkModule ? sdkModule : new Proxy({}, {
      get: () => class Stub { },
    })

  const mod = { exports: {} }
  new Function('exports', 'require', 'module', js)(mod.exports, req, mod)

  const plugin = mod.exports.default || mod.exports

  let entity = null
  const seneca = {
    export: () => (_self, spec) => { entity = spec.entity },
    message: () => { },
    prepare: () => { },
    shared: {},
  }

  plugin.call(seneca, { sdk: {} })
  ok(null != entity, 'the provider registered no entity map')

  return entity
}


// A recording stand-in for the SDK: every call is captured as
// [accessor, op, argument], and nothing else happens. `respond` shapes the
// answer, for a test about what the provider does with a response.
function recordingSdk(calls, respond) {
  return new Proxy({}, {
    get: (_t, acc) => () => new Proxy({}, {
      get: (_t2, op) => async (arg) => {
        calls.push([String(acc), String(op), arg])
        const data = null != respond ? respond(String(acc), String(op), arg) : { id: 'r0' }
        // `list` resolves to a list of SDK entities, everything else to one.
        return 'list' === String(op) ?
          [{ data: () => data }] : { data: () => data }
      },
    }),
  })
}


// Drive one generated cmd action.
function drive(entity, entname, cmd, msg, calls, respond) {
  const self = { shared: { sdk: recordingSdk(calls, respond) } }
  return entity[entname].cmd[cmd].action.call(self, (d) => d, msg)
}


// The `msg` seneca-entity hands a save: the entity, and `data$(false)` as the
// record's own fields. `action$` is deliberately NOT in there — seneca-entity
// excludes every trailing-`$` field from data$(false), which is why the
// provider reads it off the message and the entity instead.
function saveMsg(data, extra) {
  return { q: {}, ent: { data$: () => ({ ...data }) }, ...(extra || {}) }
}


function consumerModel(sdk, extra, api = API) {
  const src = [
    '@"@voxgig/apidef/model/apidef.aon"',
    '@"@voxgig/sdkgen/model/sdkgen.aon"',
    '@"target/target-index.aon"',
    '@"feature/feature-index.aon"',
    "name: 'demo'",
    api,
    extra || '',
  ].join('\n')

  const path = Path.join(sdk, 'model', 'generate-test.aon')
  Fs.writeFileSync(path, src)

  const errs = []
  const model = new Aontu().generate(src, { path, errs })
  strictEqual(errs.length, 0,
    'model did not compile: ' + errs.map((e) => e.msg).join(' | '))

  return model
}


describe('seneca-provider target, from its package', () => {

  let consumer

  // IT NEEDS `ts`. This is a consumer target: Main throws without the target
  // it wraps, so the staged consumer installs the bundled `ts` alongside this
  // package. That is the dependency direction the migration made explicit —
  // package -> bundled, which is the safe one — and there is no manifest
  // field that states it, so this `before` block is where it is visible.
  before(async () => {
    consumer = stageConsumer({ recordLog: true })
    await consumer.add('target', consumer.bundledRef('target', 'ts'))
    await consumer.addPackage(PKG)
    const config = Path.join(consumer.root, 'tsconfig.json')
    const outdir = Path.join(consumer.sdk, 'dist', 'cmp')
    Fs.copyFileSync(Path.join(PKG, 'tsconfig.json'), config)
    execFileSync(process.execPath, [process.env.npm_execpath,
      'run', 'build', '--', '--project', config, '--outDir', outdir,
    ], { cwd: PKG, stdio: 'inherit' })
    Fs.cpSync(Path.join(consumer.sdk, 'src', 'cmp'), outdir, {
      recursive: true,
      filter: (path) => !path.endsWith('.ts') && Path.basename(path) !== 'fragment',
    })
  })

  after(() => {
    if (null != consumer) consumer.cleanup()
  })


  // DOES THE INSTALLED TEST KIT SUPPORT OUT-OF-TREE GENERATION?
  //
  // `generateInto`'s `outside` option — declaring the destinations an
  // `output: path` target writes to — is newer than the published sdkgen this
  // package depends on. Without it the kit treats any path outside the
  // consumer root as a bug and throws, which is the right default and exactly
  // what an out-of-tree target trips.
  //
  // Probed rather than version-compared: a result carrying an `outside` map is
  // a kit that has the feature, whatever it calls itself. The two tests below
  // SKIP when it is absent and start running the moment sdkgen ships it — a
  // visible skip, never a silent pass, which is this project's own rule for a
  // capability the environment lacks.
  let outsideSupported = false

  before(async () => {
    const probe = await generateInto(consumer, { model: consumerModel(consumer.sdk) })
    outsideSupported = undefined !== probe.outside
  })


  test('package add installs the target', () => {
    const files = consumer.files()

    ok(files.includes('model/target/seneca-provider.aon'), 'no target model')
    ok(files.some((f) => f.startsWith('src/cmp/seneca-provider/')),
      'no components')
    ok(files.some((f) => f.startsWith('tm/seneca-provider/')), 'no templates')
  })


  // The placeholder scan sdkgen's `generate.test.ts` runs over the bundled
  // consumer targets. It is that suite's only content guard, and this target
  // leaving means it has to be run here instead — a Copy or Fragment added
  // without `...ctx$.stdrep` would otherwise ship a package naming itself
  // "ProjectName" at runtime with every suite green.
  test('it generates a provider, with no placeholder left in it', async () => {
    const { files, leaks } = await generateInto(consumer,
      { model: consumerModel(consumer.sdk) })

    const mine = Object.keys(files).filter((p) => p.startsWith('seneca-provider/'))
    ok(0 < mine.length,
      'nothing generated:\n  ' + Object.keys(files).join('\n  '))

    deepStrictEqual(leaks.filter((l) => l.startsWith('seneca-provider/')), [],
      'a placeholder survived into the generated provider')
  })


  // THE PROVIDER'S .gitignore IS GENERATED, NOT TEMPLATED — and it has to be.
  //
  // It used to come from `tm/seneca-provider/.gitignore`, which meant it
  // reached only people working from a checkout: npm never publishes a file
  // by that name, whatever `files` says, so everyone who installed from the
  // registry generated a provider repo with no ignore file at all.
  //
  // `.jostraca/` is the line that matters most: jostraca drops its meta log
  // and a full duplicate of the last generated output into the provider repo
  // on every run, so without it the first regeneration leaves hundreds of
  // untracked files behind.
  test('the gitignore is generated, not copied', async () => {
    const { files } = await generateInto(consumer,
      { model: consumerModel(consumer.sdk) })

    const ignore = files['seneca-provider/.gitignore']
    ok(null != ignore, 'no .gitignore generated:\n  ' +
      Object.keys(files).filter((p) => p.startsWith('seneca-provider/'))
        .join('\n  '))

    const lines = String(ignore).split('\n').map((l) => l.trim())
      .filter((l) => '' !== l && !l.startsWith('#'))

    for (const needed of ['node_modules/', '.jostraca/', '*.tsbuildinfo']) {
      ok(lines.includes(needed),
        'the provider .gitignore stopped ignoring ' + needed)
    }
  })


  // OUT OF TREE, which is this target's defining mode.
  //
  // The provider is not a folder of the SDK repo: it is a separate npm
  // package with its own repo, reached through `output: path`. sdkgen's
  // `external.test.ts` owns the MECHANISM — placement, partition, refusal —
  // for every target; what belongs here is that THIS target is generated
  // correctly through it, because that is the only mode a real project uses
  // it in.
  const OUT = '../acme-provider'

  test('it generates into its own repo, not into the SDK repo', async (t) => {
    if (!outsideSupported) {
      return t.skip('the installed @voxgig/sdkgen test kit has no `outside` '
        + 'support, so out-of-tree generation cannot be expressed here')
    }

    const { files, outside, leaks } = await generateInto(consumer, {
      model: consumerModel(consumer.sdk,
        "main: kit: target: 'seneca-provider': output: path: '" + OUT + "'"),
      outside: [OUT],
    })

    const provider = outside[OUT]

    // The destination IS the package: its manifest sits at the root, not
    // under a `seneca-provider/` subfolder.
    ok(null != provider['package.json'],
      'no package.json at the output root — generated:\n  ' +
      Object.keys(provider).join('\n  '))

    // ...and nothing of it stayed behind in the SDK repo.
    const strays = Object.keys(files).filter((p) => p.startsWith('seneca-provider/'))
    deepStrictEqual(strays, [],
      'the provider ALSO generated into the SDK repo')

    // The `ts` SDK still generates in-tree — the external partition must not
    // take the rest of the project with it.
    ok(Object.keys(files).some((p) => p.startsWith('ts/')),
      'the SDK stopped generating when the provider went out of tree')

    // SCOPED TO THE PROVIDER. The staged consumer also generates `ts`, whose
    // `src/feature/test/AGENTS.md` carries a known-benign `ProjectName`
    // mention that sdkgen pins in its own suite; asserting the whole list
    // empty here would be this package making a claim about another target.
    deepStrictEqual(leaks.filter((l) => l.startsWith(OUT + '/')), [],
      'a placeholder survived into the generated provider')
  })


  // EVERY ACTION IN A GENERATED WORKFLOW IS PINNED TO A SHA.
  //
  // An organisation can REQUIRE it (`sha_pinning_required`), and a workflow
  // naming a tag then fails to START: no jobs, no logs, just
  // `startup_failure` on every push. The senecajs org has that policy on, so
  // the generated build workflow never ran once in the repository it was
  // generated for — weeks of red marks that said nothing about the code.
  test('generated workflows pin every action to a SHA', async (t) => {
    if (!outsideSupported) {
      return t.skip('the installed @voxgig/sdkgen test kit has no `outside` '
        + 'support, so out-of-tree generation cannot be expressed here')
    }

    const { outside } = await generateInto(consumer, {
      model: consumerModel(consumer.sdk,
        "main: kit: target: 'seneca-provider': output: path: '" + OUT + "'"),
      outside: [OUT],
    })

    const workflows = Object.keys(outside[OUT])
      .filter((p) => p.startsWith('.github/workflows/'))

    ok(0 < workflows.length, 'no workflows were generated')

    for (const wf of workflows) {
      for (const line of outside[OUT][wf].split('\n')) {
        const m = /^\s*(?:-\s+)?uses:\s*(\S+)/.exec(line)
        if (null == m) {
          continue
        }
        ok(/@[0-9a-f]{40}$/.test(m[1]),
          wf + ' names an action by tag, which cannot start under a '
          + 'sha-pinning policy: ' + m[1])
      }
    }
  })


  // THE PUBLISH CREDENTIAL NEVER SHARES A JOB WITH PROJECT CODE.
  //
  // Trusted publishing mints a credential for any job granted
  // `id-token: write`, and a dependency lifecycle script can ask the runner
  // for it. A job that both installs dependencies and holds that permission
  // can therefore be made to publish as this package before its own gates
  // finish — so the install lives in a job with no id-token, and the
  // credential in a job that installs nothing.
  test('the publish job installs nothing and runs no project code', async (t) => {
    if (!outsideSupported) {
      return t.skip('the installed @voxgig/sdkgen test kit has no `outside` '
        + 'support, so out-of-tree generation cannot be expressed here')
    }

    const { outside } = await generateInto(consumer, {
      model: consumerModel(consumer.sdk,
        "main: kit: target: 'seneca-provider': output: path: '" + OUT + "'"),
      outside: [OUT],
    })

    const wf = outside[OUT]['.github/workflows/publish.yml']
    ok(null != wf, 'no publish workflow was generated')

    // Split the file at each top-level job key, so each job's steps are
    // attributed to the job that actually holds them.
    const jobs = {}
    let current = null
    for (const line of wf.split('\n')) {
      const m = /^  ([a-z][a-z0-9_-]*):\s*$/.exec(line)
      if (null != m) {
        current = m[1]
        jobs[current] = []
        continue
      }
      if (null != current) {
        jobs[current].push(line)
      }
    }

    const credentialed = Object.keys(jobs)
      .filter((j) => jobs[j].some((l) => /id-token:\s*write/.test(l)))

    ok(0 < credentialed.length,
      'no job requests id-token: write — trusted publishing cannot work')

    for (const job of credentialed) {
      const body = jobs[job].join('\n')

      // `npm install -g npm@latest` is npm itself, not a project dependency:
      // no package.json is consulted for it.
      const installs = /run:\s*npm (install|ci)(?!\s+-g)/.test(body)
      ok(!installs,
        'job "' + job + '" holds the publish credential AND installs '
        + 'project dependencies')

      ok(!/npm (run build|test)\b/.test(body),
        'job "' + job + '" holds the publish credential AND runs project code')
    }
  })


  // HOW THE PROVIDER DEPENDS ON THE SDK IT WRAPS.
  //
  // The default is the published package, pinned. That is wrong whenever the
  // SDK is not on a registry: the dependency 404s and the provider cannot be
  // installed, built, tested or released at all. @seneca/github-provider sat
  // in exactly that state, so the git-tag form is not a convenience.
  describe('the sdk dependency', () => {

    const manifestDep = async (t, overlay) => {
      if (!outsideSupported) {
        return t.skip('the installed @voxgig/sdkgen test kit has no `outside` '
          + 'support, so out-of-tree generation cannot be expressed here')
      }

      const { outside } = await generateInto(consumer, {
        model: consumerModel(consumer.sdk,
          "main: kit: target: 'seneca-provider': output: path: '" + OUT + "'\n"
          + overlay),
        outside: [OUT],
      })

      const pkg = JSON.parse(outside[OUT]['package.json'])
      const sdkpkg = Object.keys(pkg.dependencies)
        .find((n) => !n.startsWith('@seneca/'))

      return { pkg, sdkpkg, spec: pkg.dependencies[sdkpkg] }
    }


    test('defaults to the published package, pinned', async (t) => {
      const got = await manifestDep(t, '')
      if (null == got) return

      ok(/^\^\d+\.\d+\.\d+/.test(got.spec),
        'default dependency is not a pinned version: ' + got.spec)
    })


    test('a git kind points at the tag, in the SDK\'s own repo', async (t) => {
      const got = await manifestDep(t,
        "main: kit: target: 'seneca-provider': sdk: dep: {\n"
        + "  kind: 'git'\n"
        + "  ref: 'v9.9.9'\n"
        + "}")
      if (null == got) return

      ok(got.spec.startsWith('github:'),
        'not a github dependency: ' + got.spec)

      ok(got.spec.endsWith('#v9.9.9'),
        'the ref did not reach the dependency: ' + got.spec)

      // NO `::path:` SUBDIRECTORY, EVER. npm's spec parser accepts it and
      // reports a gitSubdir, so it reads as supported — and the INSTALLER
      // ignores it, cloning the repo and opening package.json at the root.
      // That was measured on linux, macOS and Windows: ENOENT on all three.
      // An SDK in a subdirectory uses `kind: 'release'` instead.
      ok(!got.spec.includes('::path:'),
        'the dependency carries a subdirectory npm will ignore: ' + got.spec)
    })


    // THE FORM THAT WORKS FOR THIS TOOLCHAIN'S OWN LAYOUT. sdkgen generates
    // the SDK into `ts/`, which no git dependency can reach; a release asset
    // is `npm pack` output attached to the tag, and npm installs an https
    // tarball without looking at the repository layout at all.
    test('a release kind points at the tag\'s asset', async (t) => {
      const got = await manifestDep(t,
        "main: kit: target: 'seneca-provider': sdk: dep: {\n"
        + "  kind: 'release'\n"
        + "  ref: 'v9.9.9'\n"
        + "}")
      if (null == got) return

      ok(got.spec.startsWith('https://github.com/'),
        'not an https tarball: ' + got.spec)
      ok(got.spec.includes('/releases/download/v9.9.9/'),
        'the ref did not reach the asset path: ' + got.spec)
      ok(got.spec.endsWith('.tgz'),
        'not a tarball: ' + got.spec)
    })


    // NPM RESOLVES A GIT DEPENDENCY AGAINST THE REPOSITORY ROOT, and sdkgen
    // generates the SDK into `ts/`. A project whose SDK package is therefore
    // unreachable by `github:owner/repo#ref` states the whole value instead,
    // and it must survive verbatim — composing it would defeat the point.
    test('an explicit spec is emitted verbatim', async (t) => {
      const url = 'https://github.com/acme/sdk/releases/download/v1/sdk-1.tgz'
      const got = await manifestDep(t,
        "main: kit: target: 'seneca-provider': sdk: dep: spec: '" + url + "'")
      if (null == got) return

      strictEqual(got.spec, url)
    })


    // A git dependency with no ref follows the default branch, so an install
    // today and an install tomorrow can differ. Refusing is the whole reason
    // the ref is not optional.
    test('a git kind with no ref is refused, by name', async (t) => {
      if (!outsideSupported) {
        return t.skip('the installed @voxgig/sdkgen test kit has no `outside` '
          + 'support, so out-of-tree generation cannot be expressed here')
      }

      let err = null
      try {
        await generateInto(consumer, {
          model: consumerModel(consumer.sdk,
            "main: kit: target: 'seneca-provider': output: path: '" + OUT + "'\n"
            + "main: kit: target: 'seneca-provider': sdk: dep: kind: 'git'"),
          outside: [OUT],
        })
      }
      catch (e) {
        err = e
      }

      ok(null != err, 'a git dependency with no ref generated anyway')
      ok(/ref/.test(String(err.message)),
        'the refusal does not name the missing ref: ' + err.message)
    })

  })


  // THE SDK SOURCE IS NAMED BY A PIN, NOT BY A PATH ON SOMEONE'S DISK.
  //
  // `output: sdkrel` is the walk back from this repo to the SDK repo through
  // the filesystem, and it used to be committed here — into the docs, the
  // live-test instructions and the develop-locally recipe. That made
  // generated content depend on one machine's directory layout:
  // voxgig-solardemo-sdk committed '../../voxgig-sdk/voxgig-solardemo-sdk',
  // where `voxgig-sdk` is a workspace directory on one laptop and no part of
  // any model. A second developer with both repos under a differently named
  // parent regenerated a diff in tracked files and read instructions that
  // were wrong on one of the two machines.
  //
  // It also made the repo ungenerable from anywhere else: the same model
  // produces a different provider depending on where the SDK happens to sit,
  // so two layouts could never both satisfy `check-generate`.
  //
  // sdkgen's `external.test.ts` still owns the MECHANISM — derivation, the
  // warning, a declared value replacing both. What lives here is that the
  // value no longer reaches generated content at all.
  describe('the SDK pin', () => {

    // The inversion of the test this replaces. Declared as loudly as
    // possible — an explicit `output: sdkrel` — and still absent from every
    // generated file.
    test('a declared `output: sdkrel` reaches NO generated file', async (t) => {
      if (!outsideSupported) {
        return t.skip('the installed @voxgig/sdkgen test kit has no `outside` '
          + 'support, so out-of-tree generation cannot be expressed here')
      }

      const { outside } = await generateInto(consumer, {
        model: consumerModel(consumer.sdk,
          "main: kit: target: 'seneca-provider': output: path: '" + OUT + "'\n" +
          "main: kit: target: 'seneca-provider': output: sdkrel: '../../acme-sdk'"),
        outside: [OUT],
      })

      const leaked = Object.entries(outside[OUT])
        .filter(([, content]) => String(content).includes('../../acme-sdk'))
        .map(([p]) => p)

      deepStrictEqual(leaked, [],
        'a filesystem walk back to the SDK was committed into generated files')
    })


    test('the pin names the SDK repository and its release tag', async (t) => {
      if (!outsideSupported) {
        return t.skip('no `outside` support in the installed test kit')
      }

      const { outside } = await generateInto(consumer, {
        model: consumerModel(consumer.sdk,
          "main: kit: target: 'seneca-provider': output: path: '" + OUT + "'"),
        outside: [OUT],
      })

      const raw = outside[OUT]['sdk-pin.json']
      ok(null != raw, 'no sdk-pin.json: ' + Object.keys(outside[OUT]).join(', '))

      const pin = JSON.parse(raw)
      ok(/^https?:\/\//.test(pin.repo), 'the pin has no repository: ' + pin.repo)

      // `v<version>` is what the SDK's publish workflow cuts for its primary
      // npm target, so the pin cannot drift from the dependency version.
      strictEqual(pin.tag, 'v' + pin.version,
        'the pinned tag is not the release tag for the pinned version')
    })


    // The pin is the committed fact; the checkout is derived from it and
    // disposable. Committing it would vendor the whole SDK into a repo that
    // already depends on its published package.
    test('the fetched checkout is gitignored', async (t) => {
      if (!outsideSupported) {
        return t.skip('no `outside` support in the installed test kit')
      }

      const { outside } = await generateInto(consumer, {
        model: consumerModel(consumer.sdk,
          "main: kit: target: 'seneca-provider': output: path: '" + OUT + "'"),
        outside: [OUT],
      })

      const pin = JSON.parse(outside[OUT]['sdk-pin.json'])
      const ignore = String(outside[OUT]['.gitignore'] || '')

      ok(ignore.split('\n').some((l) => l.trim() === '.sdksrc/'),
        'the fetched SDK checkout is not gitignored:\n' + ignore.slice(-400))
      ok(pin.dir.startsWith('.sdksrc/'),
        'the pin points outside the ignored folder: ' + pin.dir)
    })


    // Regeneration has to be possible from the fetched checkout, which means
    // the Makefile has to pass the destination at RUN TIME — the SDK's own
    // model cannot describe being cloned in here.
    test('the Makefile regenerates through the generate-time override',
      async (t) => {
        if (!outsideSupported) {
          return t.skip('no `outside` support in the installed test kit')
        }

        const { outside } = await generateInto(consumer, {
          model: consumerModel(consumer.sdk,
            "main: kit: target: 'seneca-provider': output: path: '" + OUT + "'"),
          outside: [OUT],
        })

        const mk = String(outside[OUT].Makefile || '')

        ok(/^regen:/m.test(mk), 'no regen target:\n' + mk.slice(-500))
        ok(mk.includes('SDKGEN_EXTERNAL'),
          'regen does not pass the destination at generate time')
        ok(mk.includes('"enclosing":true'),
          'regen does not ask for the enclosing layout, which is refused by default')
      })

  })


  // AN ENTITY NAME THAT IS NOT A JAVASCRIPT IDENTIFIER.
  //
  // apidef canonizes an entity name to `[A-Za-z_0-9]`, so hyphens and dots
  // never reach the model — but a LEADING DIGIT does, and real resources
  // produce one: `3ds-sessions` canonizes to `3ds_session`, `2fa-tokens` to
  // `2fa_token`. Emitted bare, that is a syntax error everywhere the name is
  // used as an identifier rather than as a string.
  //
  // THIS TEST ASSERTS DIFFERENT THINGS AGAINST DIFFERENT SDKGENS, on purpose,
  // and probes for which one it has rather than comparing versions — the same
  // idiom as `outsideSupported` above.
  //
  // sdkgen used to leave the name alone, and could not declare the accessor
  // for it either: the `ts` target emitted `class 3dsSessionEntity`,
  // `import { 3dsSessionEntity }` and `3dsSession(entopts?)`, all syntax
  // errors. So this target escaped the constructs it owns — the entity map
  // key, the `entity.<name>.cmd.<op>` assignments, the SEED keys — and
  // deliberately left its `sdk.<Name>()` CALL unescaped, because escaping it
  // in isolation would have turned a loud parse failure into a runtime "not a
  // function" against a method the SDK never declared.
  //
  // sdkgen now guards the name in the model before generation (voxgig/sdkgen
  // #124), so `3ds_session` arrives here as `n3ds_session` and the accessor
  // as `N3dsSession`. Every construct is then a legal identifier without this
  // target escaping anything, the escapes become no-ops, and the whole file
  // parses — which is the stronger claim, and the one the old comment here
  // said to make once the fix landed.
  test('an entity whose name starts with a digit generates a file that parses',
    async () => {
      // No `output: path` in this model, so the provider generates IN-TREE.
      // Reading it out of `outside` because the KIT supports that option
      // conflated two different things and silently found nothing.
      const { files } = await generateInto(consumer, {
        model: consumerModel(consumer.sdk, DIGIT_ENTITY),
      })

      const provider = Object.entries(files)
        .find(([p]) => /src\/demo-provider\.ts$/.test(p))
      ok(provider, 'no provider source generated:\n  ' +
        Object.keys(files).join('\n  '))

      const src = String(provider[1])
      const suite = Object.entries(files)
        .find(([p]) => /test\/.*\.test\.js$/.test(p))

      // The probe: a guarding sdkgen renamed the entity before any component
      // saw it, so the guarded name is what reaches the output.
      const guarded = src.includes('n3ds_session')

      if (guarded) {
        // The whole file has to PARSE. That is the point of the upstream fix,
        // and a parse check cannot be satisfied by escaping one construct and
        // missing another.
        new Script(compileProvider(src))

        // The accessor must be the name the SDK actually declares.
        // `MainEntity_ts` declares the method as `${entity.Name}()`, and
        // `acc` is `ent.Name`, so these agree by construction — assert it
        // anyway, because a mismatch fails at runtime rather than at build.
        ok(/sdk\.N3dsSession\(\)/.test(src),
          'the SDK accessor is not the guarded PascalCase Name')
        ok(!/sdk\.3dsSession\(\)/.test(src),
          'an unguarded accessor survived')

        if (suite) {
          new Script(String(suite[1]))
        }
        return
      }

      // Pre-guard sdkgen: this target can only guarantee its own constructs.
      // The file does NOT parse as a whole, and asserting that it does would
      // be this package making a claim about another target.
      ok(src.includes(`'3ds_session': {`) || src.includes(`"3ds_session": {`),
        'the entity map key is not quoted')
      for (const op of ['list', 'load', 'save', 'remove']) {
        const bare = 'entity.3ds_session.cmd.' + op
        ok(!src.includes(bare),
          'a bare `' + bare + '` survived — that is a syntax error')
      }
      ok(/entity\[["']3ds_session["']\]\.cmd\.list\.action/.test(src),
        'the list action is not assigned through a bracketed access')

      if (suite) {
        ok(!/^\s+3ds_session\d?: /m.test(String(suite[1])),
          'a bare digit-leading key survived in the generated test SEED map')
      }
    })


  // THE `action$` DIRECTIVE.
  //
  // apidef folds a non-CRUD verb into an ordinary op as an extra point marked
  // `select.$action`. The `ts` SDK reaches one with `$action` in the call's
  // argument; before this, the provider had no way to name one at all, so a
  // generated GitHub plugin could not merge a pull request.
  //
  // Every test here DRIVES THE GENERATED SOURCE (see loadProvider): the
  // assertions are about what the emitted handler does when called, not about
  // what the component's source text looks like.
  describe('actions', () => {

    let entity

    before(async () => {
      const { files } = await generateInto(consumer, {
        model: consumerModel(consumer.sdk, ACTION_ENTITY + ACTION_ONLY_ENTITY),
      })
      entity = loadProvider(files, 'demo-provider')
    })


    // The case from github-sdk: `merge` is a point of `update`, and save$
    // must hand the SDK `$action` so it selects that point.
    test('save$ with action$ passes $action to the SDK', async () => {
      const calls = []
      await drive(entity, 'pull', 'save',
        saveMsg({ id: 'p1', commit_title: 'Merge #42' },
          { action$: 'merge' }), calls)

      deepStrictEqual(calls, [['Pull', 'update',
        { id: 'p1', commit_title: 'Merge #42', $action: 'merge' }]])
    })


    // THE SILENT-DROP TEST, and the most important one here.
    //
    // A save with no `action$` must still take the canonical route. Passing
    // action$ and getting an ordinary save is the worst outcome — it succeeds
    // and does something else — but so is the reverse: an action branch that
    // ran unconditionally would make every plain update an action call.
    // Neither is visible without asserting the exact argument.
    test('save$ WITHOUT action$ binds the canonical point, untouched', async () => {
      const calls = []
      await drive(entity, 'pull', 'save',
        saveMsg({ id: 'p1', title: 'New title' }), calls)

      deepStrictEqual(calls, [['Pull', 'update', { id: 'p1', title: 'New title' }]])

      // No `$action` key at all, not merely an undefined one: the SDK
      // dispatches on its presence.
      ok(!('$action' in calls[0][2]), '$action reached a call that named none')
    })


    // ROUTING BY OP, not by cmd. `upload_image` belongs to `create`, and the
    // entity carries an id — Seneca's own rule would make that an update, and
    // sending the action there asks the SDK for an action `update` does not
    // have.
    test('an action on create routes to create, not update', async () => {
      const calls = []
      await drive(entity, 'pull', 'save',
        saveMsg({ id: 'p1', image: 'x' }, { action$: 'upload_image' }), calls)

      strictEqual(calls[0][1], 'create')
    })


    // An unknown name is REFUSED, and refused before anything is called: the
    // alternative is an ordinary save that reports success.
    test('an unknown action$ throws and makes no SDK call', async () => {
      const calls = []
      let err = null

      try {
        await drive(entity, 'pull', 'save',
          saveMsg({ id: 'p1' }, { action$: 'rebase' }), calls)
      }
      catch (e) { err = e }

      ok(null != err, 'an unknown action$ was accepted')
      ok(/action\$ "rebase" is not an action/.test(err.message), err.message)
      ok(/pull save/.test(err.message),
        'the error names neither the entity nor the cmd: ' + err.message)
      ok(/merge/.test(err.message),
        'the error does not name the valid actions: ' + err.message)
      deepStrictEqual(calls, [], 'the SDK was called anyway')
    })


    // The same refusal on an entity that has NO actions, which is the case
    // most likely to be typed at by mistake.
    test('action$ on a cmd with no actions names the empty set', async () => {
      const calls = []
      let err = null

      try {
        await drive(entity, 'planet', 'save',
          saveMsg({ id: 'p1' }, { action$: 'merge' }), calls)
      }
      catch (e) { err = e }

      ok(null != err, 'action$ was ignored on an entity with no actions')
      ok(/planet save/.test(err.message), err.message)
      ok(/\(none\)/.test(err.message), err.message)
      deepStrictEqual(calls, [])
    })


    // THE READ SIDE. Actions are not confined to write ops, and on a read cmd
    // `action$` arrives as a key of the QUERY — which cleanq strips, so it has
    // to be read before that happens.
    test('list$ carries action$ from the query, and strips it as a match field',
      async () => {
        const calls = []
        await drive(entity, 'pull', 'list',
          { q: { action$: 'nosuch' }, ent: {} }, calls)
          .then(() => { throw new Error('an unknown action$ was accepted') },
            (e) => ok(/action\$ "nosuch" is not an action/.test(e.message),
              e.message))

        // And with no action$, the query reaches the SDK with no directive in
        // it — the behaviour cleanq already had, unchanged.
        calls.length = 0
        await drive(entity, 'pull', 'list',
          { q: { title: 'x', sort$: 'title' }, ent: {} }, calls)

        deepStrictEqual(calls, [['Pull', 'list', { title: 'x' }]])
      })


    // AN ENTITY WHOSE OP HAS ONLY ACTION POINTS must still generate. Its
    // `update` is a single `award` route and nothing else, so an entity
    // assembly that treated an action-only op as no op at all would drop the
    // cmd — and with it the only way to reach the endpoint.
    test('an entity whose op has only action points still generates', async () => {
      ok(null != entity.badge, 'the action-only entity vanished')
      ok(null != entity.badge.cmd.save, 'its save$ vanished')

      const calls = []
      await drive(entity, 'badge', 'save',
        saveMsg({ id: 'b1', reason: 'why' }, { action$: 'award' }), calls)

      deepStrictEqual(calls, [['Badge', 'update',
        { id: 'b1', reason: 'why', $action: 'award' }]])
    })


    // THE THREE SPELLINGS seneca-entity actually delivers, and the one it
    // does not. `make$({ action$ })` reaches nothing — make$ copies only keys
    // without a `$`, plus the four directives it knows by name — so the
    // provider reads the message and the entity as well as the query.
    test('action$ is read from the query, the message and the entity', async () => {
      for (const msg of [
        saveMsg({ id: 'p1' }, { action$: 'merge' }),                    // directive$
        saveMsg({ id: 'p1' }, { ent: { data$: () => ({ id: 'p1' }), action$: 'merge' } }),
        saveMsg({ id: 'p1' }, { q: { action$: 'merge' } }),
      ]) {
        const calls = []
        await drive(entity, 'pull', 'save', msg, calls)
        strictEqual(calls[0][2].$action, 'merge')
      }
    })
  })


  // REVIEW FINDINGS on the first cut of this mechanism. Each is a way the
  // action route can still be lost or mis-served after `action$` arrives.
  describe('actions: review findings', () => {

    let entity
    let files

    before(async () => {
      const out = await generateInto(consumer, {
        model: consumerModel(consumer.sdk,
          PARENT_ACTION_ENTITY + NO_LOAD_ENTITY),
      })
      files = out.files
      entity = loadProvider(files, 'demo-provider')
    })


    // GUARD ORDERING. The parent guards are computed from the CANONICAL
    // points — opParams drops action points — so running them ahead of the
    // action branch demands a key the action's own route has no segment for.
    // `status` hangs off `/meeting/{id}`, which needs no user_id, but the
    // canonical `/user/{user_id}/meeting/{id}` does.
    test('an action shallower than its canonical route is not blocked by the canonical guard',
      async () => {
        const calls = []
        await drive(entity, 'meeting', 'save',
          saveMsg({ id: 'm1', state: 'ended' }, { action$: 'status' }), calls)

        deepStrictEqual(calls, [['Meeting', 'update',
          { id: 'm1', state: 'ended', $action: 'status' }]])
      })


    // The same ordering on a read cmd.
    test('a read action is not blocked by the canonical guard either', async () => {
      const calls = []
      await drive(entity, 'meeting', 'remove',
        { q: { id: 'm1', action$: 'archive' }, ent: {} }, calls)

      strictEqual(calls.length, 1, 'the action call never happened')
      strictEqual(calls[0][1], 'remove')
    })


    // ...and the guard still fires on a call that named no action, which is
    // the behaviour it exists for.
    test('a call naming no action still gets its parent guard', async () => {
      const calls = []
      let err = null

      try {
        await drive(entity, 'meeting', 'save', saveMsg({ id: 'm1' }), calls)
      }
      catch (e) { err = e }

      ok(null != err, 'the parent guard stopped firing')
      ok(/user_id is required/.test(err.message), err.message)
      deepStrictEqual(calls, [])
    })


    // A REMOVE ACTION'S RESPONSE. `/meeting/{id}/archive` answers with the
    // archive record; the canonical DELETE answers with nothing, and applying
    // the canonical behaviour to the action throws its response away.
    test('a remove action returns its own response', async () => {
      const calls = []
      const res = await drive(entity, 'meeting', 'remove',
        { q: { id: 'm1', action$: 'archive' }, ent: {} }, calls)

      ok(null != res, 'the action response was discarded')
      deepStrictEqual(res, { id: 'r0' })
    })


    // ...while a plain remove still answers null, unchanged.
    test('a plain remove still answers null', async () => {
      const calls = []
      const res = await drive(entity, 'meeting', 'remove',
        { q: { id: 'm1', user_id: 'u1' }, ent: {} }, calls)

      strictEqual(res, null)
      strictEqual(calls[0][1], 'remove')
    })


    // INHERITED NAMES. The action map is an ordinary object, so `map[name]`
    // resolves `toString`, `constructor` and `__proto__` from Object's
    // prototype — non-null, so the refusal never fires and the inherited
    // function is handed to the SDK as an op name. This is the silent-drop
    // failure mode wearing a different hat: the caller named something the
    // entity does not have and did not get told.
    test('an inherited property name is refused, not treated as an action',
      async () => {
        for (const name of ['toString', 'constructor', '__proto__',
          'hasOwnProperty', 'valueOf']) {
          const calls = []
          let err = null

          try {
            await drive(entity, 'meeting', 'save',
              saveMsg({ id: 'm1' }, { action$: name }), calls)
          }
          catch (e) { err = e }

          ok(null != err, name + ' was accepted as an action')
          ok(/is not an action of this operation/.test(err.message),
            name + ': ' + err.message)
          deepStrictEqual(calls, [], name + ' reached the SDK')
        }
      })


    // The same on a cmd that has no actions at all, where the map is empty
    // and every name in it is therefore inherited.
    test('an inherited name is refused on a cmd with no actions', async () => {
      const calls = []
      let err = null

      try {
        await drive(entity, 'meeting', 'list',
          { q: { user_id: 'u1', action$: 'constructor' }, ent: {} }, calls)
      }
      catch (e) { err = e }

      ok(null != err, 'constructor was accepted on an actionless cmd')
      ok(/\(none\)/.test(err.message), err.message)
      deepStrictEqual(calls, [])
    })


    // THE PLAIN-SAVE TEST IS GENERATED, NOT UNIVERSAL. `alert` has a save
    // action, a mutable field, and no `load` cmd — nothing can fetch a record
    // to mutate, and its only update point is the action, so there is no
    // plain id-bearing save to make. Emitting the test anyway ships a red
    // suite to a package whose action works.
    test('no plain-save test is generated for an entity that cannot perform one',
      () => {
        const path = Object.keys(files)
          .find((p) => /test\/demo-provider\.test\.js$/.test(p))
        ok(null != path, 'no generated suite:\n  ' +
          Object.keys(files).join('\n  '))

        const suite = String(files[path])

        ok(!suite.includes("it('alert-save-without-action'"),
          'a plain-save test was generated for an entity with no load cmd ' +
          'and no canonical update')

        // It has no load cmd at all, so nothing generated may call load$ on it.
        ok(!/entity\('provider\/demo\/alert'\)[\s\S]{0,200}?\.load\$/.test(suite),
          'the generated suite calls load$ on an entity with no load cmd')

        // Its action coverage is still generated — the gate must not take the
        // action tests with it.
        ok(suite.includes("it('alert-action-unknown-save'"),
          'the action tests went with it')
        ok(suite.includes("it('alert-action-ack'"),
          'the positive action test went with it')

        // And the entity that CAN perform one still gets it.
        ok(suite.includes("it('meeting-save-without-action'"),
          'the plain-save test was dropped for an entity that can perform one')
      })
  })


  // THE RECORD KEY, when the API does not call it `id`. Seneca's entity id
  // has to be what the API addresses the record by, whatever the response
  // happens to carry under `id`, and a write has to address that record.
  describe('record keys', () => {

    let entity
    let files
    let sdk

    before(async () => {
      const out = await generateInto(consumer, {
        model: consumerModel(consumer.sdk,
          ACCOUNT_ENTITY + REPO_ENTITY + LEDGER_ENTITY + SETTING_ENTITY +
          PROJECT_ENTITY + PARENT_ACTION_ENTITY + EMBLEM_ENTITY +
          MIRROR_ENTITY),
      })
      files = out.files
      sdk = compileSdk(files)
      entity = loadProvider(files, 'demo-provider', sdk.module)
    })

    after(() => {
      if (null != sdk) Fs.rmSync(sdk.dir, { recursive: true, force: true })
    })


    // github's user answers `GET /users/{username}` with `login` and a
    // numeric `id`, and no `username` at all. The key the request used is
    // the only source of the entity's id.
    test('a load carries the request key across, over an unrelated id', async () => {
      const calls = []
      const got = await drive(entity, 'account', 'load',
        { q: { id: 'voxgig' }, ent: {} }, calls,
        () => ({ id: 123456789, login: 'voxgig' }))

      deepStrictEqual(calls, [['Account', 'load', { username: 'voxgig' }]])
      strictEqual(got.id, 'voxgig')
      strictEqual(got.demo_id, 123456789)
    })


    // The write body carries the key under the API's own name. Seneca's `id`
    // is not a field of this API's account, and the parked API id is not
    // writable; neither may travel.
    test('a save addresses the record by the API key and sends neither id', async () => {
      const calls = []
      await drive(entity, 'account', 'save',
        saveMsg({ id: 'voxgig', bio: 'hello', demo_id: 123456789 }), calls)

      strictEqual(calls.length, 1)
      strictEqual(calls[0][1], 'update')
      deepStrictEqual(calls[0][2], { username: 'voxgig', bio: 'hello' })
    })


    // The whole cycle against the SDK's own mock, on a record whose API id
    // and key differ, as they do for every github user.
    test('load-modify-save on an account keyed by username changes that record',
      async () => {
        const client = sdk.module.DemoSDK.test({ entity: { account: {} } })
        await client.Account().create({
          id: 123456789, username: 'voxgig', owner: { login: 'voxgig' }, bio: 'first',
        })

        const self = { shared: { sdk: client } }
        const entize = (d) => d
        const load = () => entity.account.cmd.load.action
          .call(self, entize, { q: { id: 'voxgig' }, ent: {} })

        const loaded = await load()
        strictEqual(loaded.id, 'voxgig')
        strictEqual(loaded.demo_id, 123456789)

        loaded.bio = 'second'
        const saved = await entity.account.cmd.save.action
          .call(self, entize, { q: {}, ent: { data$: () => ({ ...loaded }) } })

        strictEqual(saved.id, 'voxgig')
        strictEqual(saved.bio, 'second')
        deepStrictEqual(saved.owner, { login: 'voxgig' })

        const again = await load()
        strictEqual(again.bio, 'second')
        strictEqual(again.demo_id, 123456789)

        const all = await entity.account.cmd.list.action
          .call(self, entize, { q: {}, ent: {} })
        strictEqual(all.length, 1, 'the save created a second record')
      })


    // A composite key: the parts go in the match, the body stays as loaded,
    // and the save is an UPDATE of the record that was loaded.
    test('load-modify-save on a composite repo updates in place', async () => {
      const client = sdk.module.DemoSDK.test({ entity: { repo: {} } })
      await client.Repo().create({
        id: 'r-api-id', name: 'sdkgen', owner: { login: 'voxgig' }, description: 'first',
      })

      const self = { shared: { sdk: client } }
      const entize = (d) => d
      const load = () => entity.repo.cmd.load.action
        .call(self, entize, { q: { id: 'voxgig/sdkgen' }, ent: {} })

      const loaded = await load()
      strictEqual(loaded.id, 'voxgig/sdkgen')

      loaded.description = 'second'
      const saved = await entity.repo.cmd.save.action
        .call(self, entize, { q: {}, ent: { data$: () => ({ ...loaded }) } })

      strictEqual(saved.id, 'voxgig/sdkgen')
      strictEqual(saved.description, 'second')
      deepStrictEqual(saved.owner, { login: 'voxgig' })

      strictEqual((await load()).description, 'second')

      const all = await entity.repo.cmd.list.action
        .call(self, entize, { q: {}, ent: {} })
      strictEqual(all.length, 1, 'the save created a second record')
    })


    // A response can carry an OBJECT under a path parameter's name. Sent as
    // a URL segment that is `[object Object]`, which may resolve to a real
    // resource; refused instead.
    test('an object where a path parameter belongs is refused', async () => {
      const calls = []
      let err = null

      try {
        await drive(entity, 'meeting', 'save',
          saveMsg({ id: 'm1', user_id: { login: 'u1' }, topic: 't' }), calls)
      }
      catch (e) { err = e }

      ok(null != err, 'an object was accepted as a path parameter')
      ok(/user_id must be a single value/.test(err.message), err.message)
      deepStrictEqual(calls, [])
    })


    // Each save branch guards the keys of ITS route. A project is created
    // inside an org and updated by its own id, so an update without `org`
    // is fine and a create without it is not.
    test('a save guards the parent keys of the branch it takes', async () => {
      const calls = []
      await drive(entity, 'project', 'save',
        saveMsg({ id: 'p1', title: 'renamed' }), calls)
      deepStrictEqual(calls, [['Project', 'update', { id: 'p1', title: 'renamed' }]])

      let err = null
      try {
        await drive(entity, 'project', 'save', saveMsg({ title: 'new' }), [])
      }
      catch (e) { err = e }
      ok(null != err, 'a create without its parent key went out')
      ok(/org is required/.test(err.message), err.message)
    })


    // The generated suite has to PARSE with a hyphenated parameter, wherever
    // the name lands: an object key, a regex, a local variable.
    test('a parameter name that is not an identifier still yields a suite that parses',
      () => {
        const suite = String(files[Object.keys(files)
          .find((p) => /test\/demo-provider\.test\.js$/.test(p))])

        new Script(suite)
        ok(suite.includes("'account-id': 'account-id0'"),
          'the hyphenated parent key is not quoted in a query')
        ok(!/[^'"]account-id: /.test(suite),
          'a bare hyphenated key survived')
      })


    // The key block runs ahead of the action branch, so an action test on a
    // composite entity has to address it by its whole id or be refused for
    // the id's shape before the action name is even looked at.
    test('the action tests address a composite entity by its whole id', () => {
      const suite = String(files[Object.keys(files)
        .find((p) => /test\/demo-provider\.test\.js$/.test(p))])

      const start = suite.indexOf("it('repo-action-unknown-save'")
      ok(0 <= start, 'no unknown-action test for the composite entity')
      const body = suite.slice(start, suite.indexOf("\n  it('", start + 1))
      ok(body.includes("id: 'owner0/repo0'"),
        'the composite entity is addressed by a bare name:\n' + body)
    })


    // No round-trip without a create route, and no update leg without an
    // update route: either would be a suite that fails on a working provider.
    test('the round-trip is generated only for the ops the entity has', () => {
      const suite = String(files[Object.keys(files)
        .find((p) => /test\/demo-provider\.test\.js$/.test(p))])

      ok(!suite.includes("it('setting-crud'"),
        'a round-trip was generated for an entity with no create route')
      ok(suite.includes('NO setting create/update/remove round-trip'),
        'the missing round-trip is not explained in the file')

      const start = suite.indexOf("it('ledger-crud'")
      ok(0 <= start, 'no round-trip for an entity with create and remove')
      const body = suite.slice(start, suite.indexOf("\n  it('", start + 1))
      strictEqual((body.match(/\.save\$\(\)/g) || []).length, 1,
        'the round-trip saves a loaded record on an entity with no update')
    })


    // Seneca's key is `id`, on every entity. The docs address a record the
    // way the provider does, and never print a null id field.
    test('the docs address a username-keyed record by id', () => {
      const doc = (name) => String(files[Object.keys(files)
        .find((p) => p.endsWith('/doc/' + name))])

      for (const name of ['how-to.md', 'reference.md', 'tutorial.md']) {
        const text = doc(name)
        ok(!text.includes('undefined'), name + ' prints undefined')
        ok(!/load\$\(\{[^}]*username:/.test(text),
          name + ' queries a Seneca entity by the API key')
        ok(!/remove\$\(\{[^}]*username:/.test(text),
          name + ' removes a Seneca entity by the API key')
      }

      ok(doc('how-to.md').includes("load$('account0')"),
        'the how-to does not read one account by id')
      ok(doc('reference.md').includes('`username` | string | API key'),
        'the reference does not name the API key')
      ok(!doc('reference.md').includes('do not address it'),
        'the reference still says the short form does not work')
    })


    // A CLIENT-SUPPLIED KEY TRAVELS ON THE CREATE.
    //
    // Keeping the key out of the body is right for an API-assigned `id`: the
    // API chooses it and a supplied one is ignored. It is wrong for a key the
    // create request declares required — `account` is keyed by a `username`
    // nobody else can invent — and taking it out left an empty create in every
    // generated example and in the round-trip test, so the suite asserted an
    // id the mock could only have made up and a real server would have been
    // sent `POST /account {}`.
    test('a create carries the key the API requires', () => {
      const suite = String(files[Object.keys(files)
        .find((p) => /test\/demo-provider\.test\.js$/.test(p))])

      const start = suite.indexOf("it('account-crud'")
      ok(0 <= start, 'no round-trip for the username-keyed entity')
      const body = suite.slice(start, suite.indexOf("\n  it('", start + 1))

      ok(/make\$\(\{ username: '[^']+' \}\)/.test(body),
        'the generated create sends no username:\n' + body)

      const howto = String(files[Object.keys(files)
        .find((p) => p.endsWith('/doc/how-to.md'))])
      const created = howto.slice(howto.indexOf('## Create a record'))
      ok(/make\$\(\{ username: '[^']+' \}\)/.test(
        created.slice(0, created.indexOf('##', 3))),
        'the how-to teaches a create with an empty body:\n' +
        created.slice(0, 400))
    })


    // AN ACTION ON A READ CMD ADDRESSES THE RECORD TOO.
    //
    // The write path splits a composite id into the path parameters the API
    // names. The read path did not: it moved the whole joined id under the
    // terminal parameter's name, so `/mirror/{owner}/{mirror}/latest` was asked
    // for a mirror called `owner0/mirror0` with no owner at all.
    test('a read action splits a composite id into the API\'s own keys',
      async () => {
        const calls = []
        await drive(entity, 'mirror', 'load',
          { q: { id: 'owner0/mirror0', action$: 'latest' }, ent: {} }, calls)

        strictEqual(calls.length, 1, 'the action never reached the SDK')
        deepStrictEqual(calls[0][2],
          { owner: 'owner0', slug: 'mirror0', $action: 'latest' })
      })


    // ...and the same translation on a SINGLE renamed key, which is the shape
    // the old code got right: `username`, not `id`, and not both.
    test('a read action carries a renamed key under the API\'s name', async () => {
      const calls = []
      await drive(entity, 'meeting', 'remove',
        { q: { id: 'm1', action$: 'archive' }, ent: {} }, calls)

      strictEqual(calls[0][1], 'remove')
      deepStrictEqual(calls[0][2], { id: 'm1', $action: 'archive' })
    })


    // An id that is not all of the parts cannot build the action's URL either,
    // so it is refused rather than sent — as the canonical read is.
    test('a read action refuses an incomplete composite id', async () => {
      const calls = []
      let err = null

      try {
        await drive(entity, 'mirror', 'load',
          { q: { id: 'incomplete', action$: 'latest' }, ent: {} }, calls)
      }
      catch (e) { err = e }

      ok(null != err, 'an incomplete id was sent to the action route')
      ok(/id must be 'owner\/slug'/.test(err.message), err.message)
      deepStrictEqual(calls, [], 'the SDK was called anyway')
    })


    // THE PARKED ID'S NAME CAN BE TAKEN.
    //
    // An unrelated API `id` is parked under `<provider>_id` so it is not lost,
    // and dropped from a write because the API's schema has no such field. In
    // a provider called `demo` that name is `demo_id` — which is exactly what
    // this API calls `emblem`'s required parent key, so the delete ran ahead of
    // the guard and every save was refused for a key the caller had supplied.
    test('a save keeps a parent key that is named like the parked id', async () => {
      const calls = []
      await drive(entity, 'emblem', 'save',
        saveMsg({ id: 'slug0', demo_id: 'demo0', label: 'first' }), calls)

      strictEqual(calls.length, 1, 'the save never reached the SDK')
      strictEqual(calls[0][1], 'update')
      deepStrictEqual(calls[0][2],
        { demo_id: 'demo0', slug: 'slug0', label: 'first' })
    })


    // The other half: parking must not INVENT one either. A response that does
    // not repeat the parent key would otherwise come back carrying the API's
    // own id under it — a parent id pointing at nothing.
    test('a read does not park an unrelated id over a real key', async () => {
      const calls = []
      const got = await drive(entity, 'emblem', 'load',
        { q: { demo_id: 'demo0', id: 'slug0' }, ent: {} }, calls,
        () => ({ id: 987654321, slug: 'slug0', label: 'first' }))

      strictEqual(got.id, 'slug0')
      strictEqual(got.demo_id, undefined,
        'the API id was parked over the parent key: ' + got.demo_id)
    })


    // ...AND AN API-ASSIGNED `id` STILL DOES NOT. The fix above must not turn
    // into "send whatever the key is called": `planet` is keyed by an `id` the
    // API assigns, and a create that supplies one is at best ignored.
    test('a create omits an id the API assigns', () => {
      const suite = String(files[Object.keys(files)
        .find((p) => /test\/demo-provider\.test\.js$/.test(p))])

      const start = suite.indexOf("it('planet-crud'")
      ok(0 <= start, 'no round-trip for the id-keyed entity')
      const body = suite.slice(start, suite.indexOf("\n  it('", start + 1))

      const make = /make\$\(\{([^}]*)\}\)/.exec(body)
      ok(null != make, 'no create in the round-trip:\n' + body)
      ok(!/\bid:/.test(make[1]),
        'the create of an id-keyed entity sends an id: ' + make[0])
      ok(make[1].includes('title:'),
        'the create stopped sending the entity\'s own fields: ' + make[0])
    })


    test('the generated provider declares the host framework for its own suite', () => {
      const pkg = JSON.parse(files[Object.keys(files)
        .find((p) => /seneca-provider\/package\.json$/.test(p))])

      for (const dep of ['seneca', 'seneca-entity', 'seneca-promisify',
        '@seneca/provider', '@seneca/env']) {
        ok(null != pkg.devDependencies[dep], dep + ' is not a dev dependency')
        ok(null != pkg.peerDependencies[dep], dep + ' is not a peer dependency')
      }

      for (const wf of Object.keys(files).filter((p) => /\.github\/workflows\//.test(p))) {
        ok(!files[wf].includes('--no-save'),
          wf + ' still installs the host framework by hand')
      }
    })


    // An API that declares no authentication gets docs that say so, not a
    // bearer header the SDK would strip.
    test('the docs of an unauthenticated API claim no bearer header', () => {
      for (const p of Object.keys(files).filter((f) => /seneca-provider\/doc\//.test(f))) {
        ok(!/bearer/i.test(files[p]), p + ' claims a bearer header')
      }
      const howto = String(files[Object.keys(files).find((p) => p.endsWith('/doc/how-to.md'))])
      ok(howto.includes('declares no authentication'),
        'the how-to does not say the API declares no authentication')
    })
  })


  // Docs and tests driven by the model's authentication scheme and parent
  // keys, each on its own small generation.
  describe('model-driven docs', () => {

    test('basic auth docs name the secret and the scheme', async () => {
      const api = API.replace("auth: false",
        "auth: true, security: { type: 'http', in: 'header', name: 'Authorization', prefix: 'Basic' }")
      const { files } = await generateInto(consumer, {
        model: consumerModel(consumer.sdk, '', api),
      })

      const ref = String(files[Object.keys(files).find((p) => p.endsWith('/doc/reference.md'))])
      const howto = String(files[Object.keys(files).find((p) => p.endsWith('/doc/how-to.md'))])

      ok(ref.includes('authorization: Basic'), 'the reference does not name the scheme')
      ok(ref.includes('`secret`'), 'the reference does not name the second key')
      ok(howto.includes("secret: { value: '$DEMO_SECRET' }"),
        'the how-to does not configure the secret')
      ok(!/bearer/i.test(ref + howto), 'a bearer header is claimed for basic auth')
    })


    test('a bearer API is documented with its own header', async () => {
      const api = API.replace("auth: false",
        "auth: true, security: { type: 'http', in: 'header', name: 'Authorization', prefix: 'Bearer' }")
      const { files } = await generateInto(consumer, {
        model: consumerModel(consumer.sdk, '', api),
      })

      const ref = String(files[Object.keys(files).find((p) => p.endsWith('/doc/reference.md'))])
      ok(ref.includes('`authorization: Bearer <apikey>`'), 'the bearer header is not named')
      ok(!ref.includes('`secret`'), 'a secret is claimed for a bearer scheme')
    })


    // A parent key naming no entity seeds as `user0`, in the seed AND in the
    // query that reads it back. A tutorial whose query does not match its
    // own seed teaches a lookup that answers null.
    test('the tutorial and how-to query a parent key the way they seed it', async () => {
      const { files } = await generateInto(consumer, {
        model: consumerModel(consumer.sdk, PARENT_ACTION_ENTITY),
      })

      for (const name of ['tutorial.md', 'how-to.md']) {
        const text = String(files[Object.keys(files).find((p) => p.endsWith('/doc/' + name))])
        ok(text.includes("user_id: 'user0'"), name + ' does not query user0')
        ok(!text.includes("user_id: '0'"), name + ' queries a parent seeded as 0')
        ok(!/"user_id":"0"/.test(text), name + ' seeds a parent as 0')
      }
    })


    // The live missing-record read of a NESTED subject cannot be a bare id:
    // the parent guard refuses it before any request. With no way to obtain
    // a parent id live, the test is not emitted rather than emitted red.
    test('a live missing-record read is not emitted for a nested subject it cannot address',
      async () => {
        const nested = await generateInto(consumer, {
          model: consumerModel(consumer.sdk,
            "main: kit: test: live: base: 'http://localhost:9999'\n" +
            'main: kit: entity: planet: active: false\n' +
            PARENT_ACTION_ENTITY),
        })
        const suite = String(nested.files[Object.keys(nested.files)
          .find((p) => /test\/demo-provider\.test\.js$/.test(p))])

        ok(suite.includes("describe('live'"), 'no live suite was generated')
        ok(!suite.includes("load$('nosuchmeeting')"),
          'a nested subject is read live without its parent key')
        ok(!suite.includes('meeting-load-missing', suite.indexOf("describe('live'")),
          'a live missing-record read was emitted with no parent id to give it')

        const flat = await generateInto(consumer, {
          model: consumerModel(consumer.sdk,
            "main: kit: test: live: base: 'http://localhost:9999'\n"),
        })
        const fsuite = String(flat.files[Object.keys(flat.files)
          .find((p) => /test\/demo-provider\.test\.js$/.test(p))])
        ok(fsuite.includes("load$('nosuchplanet')"),
          'a flat subject lost its live missing-record read')
      })
  })


  // `cmdActions` — which SDK op serves each action of one cmd.
  describe('cmdActions', () => {

    const { cmdActions } = loadComponent('Main_seneca-provider.ts', {
      './Extras_seneca-provider': {
        Tests: () => { }, Scripts: () => { }, Workflow: () => { },
        Readme: () => { }, Docs: () => { },
      },
      './Gitignore_seneca-provider': { Gitignore: () => { } },
    })

    const ENT = {
      name: 'pull',
      fields: {},
      op: {
        create: {
          name: 'create',
          points: [
            { o: '/pull' },
            { o: '/pull/{id}/image', q: { $action: 'upload_image' } },
          ],
        },
        update: {
          name: 'update',
          points: [
            { o: '/pull/{id}' },
            { o: '/pull/{id}/merge', q: { $action: 'merge' } },
          ],
        },
      },
    }

    // `save` spans two ops, so its map is the union — and each name has to
    // carry the op it came from, or save$ sends `upload_image` to update.
    test('save maps each action to the op that owns it', () => {
      deepStrictEqual(cmdActions(ENT, 'save'),
        { upload_image: 'create', merge: 'update' })
    })

    test('a cmd whose ops have no action points maps nothing', () => {
      deepStrictEqual(cmdActions(ENT, 'list'), {})
      deepStrictEqual(cmdActions(ENT, 'remove'), {})
    })

    // THE CONSTRUCTION HALF of the inherited-property finding. `out[name]`
    // on a plain object finds `Object.prototype.toString` for an action
    // literally named `toString`, reads it as "already claimed", and drops
    // the action — so a modelled endpoint becomes unreachable and nothing
    // says so. apidef takes an action name from a route segment, and
    // `/pull/{id}/toString` is a legal route.
    test('an action carrying an inherited property name is kept', () => {
      const ent = {
        name: 'pull',
        fields: {},
        op: {
          update: {
            name: 'update',
            points: [
              { o: '/pull/{id}' },
              { o: '/pull/{id}/toString', q: { $action: 'toString' } },
              { o: '/pull/{id}/valueOf', q: { $action: 'valueOf' } },
            ],
          },
        },
      }

      const map = cmdActions(ent, 'save')

      strictEqual(map.toString, 'update')
      strictEqual(map.valueOf, 'update')
    })


    // An op the model marks inactive generates no SDK method, so an action
    // folded into it is not reachable and must not be advertised as if it
    // were — the same rule parentKeys follows for guards.
    test('an inactive op contributes no action', () => {
      const ent = {
        ...ENT,
        op: { ...ENT.op, update: { ...ENT.op.update, active: false } },
      }

      deepStrictEqual(cmdActions(ent, 'save'), { upload_image: 'create' })
    })
  })


  // `recordKey` — which param names the record itself.
  describe('recordKey', () => {

    const { recordKey } = loadComponent('Main_seneca-provider.ts', {
      // Local siblings unrelated to recordKey — stubbed out entirely.
      './Extras_seneca-provider': {
        Tests: () => { }, Scripts: () => { }, Workflow: () => { },
        Readme: () => { }, Docs: () => { },
      },
      './Gitignore_seneca-provider': { Gitignore: () => { } },
    })

    // Airtable's real shape. opParams() alphabetizes for output stability
    // (base_id, record_id, table_id) — table_id sorts last, so the old
    // "last required param" heuristic picked it as the record's own key
    // instead of record_id, and every downstream mapping was backwards.
    test('a 3-param route picks the terminal path param, not the alphabetically last one', () => {
      const ent = {
        name: 'record',
        fields: {},
        op: {
          load: {
            points: [{
              s: [{ var: 'base_id' }, { var: 'table_id' }, { var: 'record_id' }],
              g: {
                params: {
                  base_id: { n: 'base_id', r: true },
                  table_id: { n: 'table_id', r: true },
                  record_id: { n: 'record_id', r: true },
                },
              },
            }],
          },
        },
      }

      strictEqual(recordKey(ent), 'record_id')
    })

    // The common case: a single path param, already named plainly — matched
    // by entityIdField before the points-based fallback ever runs.
    test('a single-param route with a field named id uses entityIdField', () => {
      const ent = {
        name: 'board',
        fields: { id: { n: 'id' } },
        op: {
          load: {
            points: [{
              s: [{ lit: 'boards' }, { var: 'id' }],
              g: { params: { id: { n: 'id', r: true } } },
            }],
          },
        },
      }

      strictEqual(recordKey(ent), 'id')
    })

    // A load route ending in a literal names a facet of the record, so its
    // parameter is only a last resort: the remove route's terminal parameter
    // is the key, as it is for the SDK's mock transport.
    test('a literal-terminal load route defers to an op that ends in a parameter', () => {
      const ent = {
        name: 'registry',
        fields: {},
        op: {
          load: {
            points: [{
              s: [{ lit: 'orgs' }, { var: 'org' }, { lit: 'registry' }, { lit: 'public-key' }],
              g: { params: { org: { n: 'org', r: true } } },
            }],
          },
          remove: {
            points: [{
              s: [{ lit: 'orgs' }, { var: 'org' }, { lit: 'registry' }, { var: 'registry_id' }],
              g: { params: { org: { n: 'org', r: true }, registry_id: { n: 'registry_id', r: true } } },
            }],
          },
        },
      }

      strictEqual(recordKey(ent), 'registry_id')

      delete ent.op.remove
      strictEqual(recordKey(ent), 'org')
    })
  })


  // `rkOnCreate` — whether a create has to SEND the key it is addressed by.
  describe('rkOnCreate', () => {

    const { rkOnCreate } = loadComponent('Main_seneca-provider.ts', {
      './Extras_seneca-provider': {
        Tests: () => { }, Scripts: () => { }, Workflow: () => { },
        Readme: () => { }, Docs: () => { },
      },
      './Gitignore_seneca-provider': { Gitignore: () => { } },
    })

    const account = (r) => ({
      name: 'account',
      fields: { username: { n: 'username', r }, bio: { n: 'bio', r: false } },
      op: {
        load: {
          points: [{
            s: [{ lit: 'account' }, { var: 'username' }],
            g: { params: { username: { n: 'username', r: true } } },
          }],
        },
        create: { points: [{ s: [{ lit: 'account' }], g: {} }] },
      },
    })

    test('a key the create request requires is sent', () => {
      strictEqual(rkOnCreate(account(true)), true)
    })

    // Optional in the create request means the API can fill it in, so the
    // create is not empty without it.
    test('a key the create request makes optional is not', () => {
      strictEqual(rkOnCreate(account(false)), false)
    })

    test('an id the API assigns is not', () => {
      strictEqual(rkOnCreate({
        name: 'planet',
        fields: { id: { n: 'id', r: true }, title: { n: 'title', r: true } },
        op: {
          load: {
            points: [{
              s: [{ lit: 'planet' }, { var: 'id' }],
              g: { params: { id: { n: 'id', r: true } } },
            }],
          },
          create: { points: [{ s: [{ lit: 'planet' }], g: {} }] },
        },
      }), false)
    })

    test('an entity with no create route has no create to send it on', () => {
      const ent = account(true)
      delete ent.op.create
      strictEqual(rkOnCreate(ent), false)
    })
  })


  // `seedRecord` — what the generated mock seeds for a parent key.
describe('seedRecord', () => {

    const { seedRecord } = loadComponent('Extras_seneca-provider.ts')

    // GitHub's real shape: `owner` is both a required PARENT PATH PARAM (the
    // {owner} URL segment) and an unrelated response FIELD (the repo's owner
    // object) — no entity in the model is literally named `owner`, so
    // parentEntity resolves to ''. The old `${f.parentEntity}0` formula
    // seeded '0'; the query built elsewhere (parentPairs/parentSeed) filtered
    // for 'owner0' — seed and query disagreed.
    test('a parent key colliding with an unrelated same-named field seeds via parentSeed, not a bare index', () => {
      const e = {
        name: 'repo',
        idf: 'id',
        parents: ['owner'],
        fields: [
          { name: 'id', kind: 'string', parentEntity: '' },
          { name: 'owner', kind: 'object', parentEntity: '' },
        ],
      }

      strictEqual(seedRecord(e, 0).owner, 'owner0')
    })

    // Zoom's real shape: `user_id` guards `list`/`create` but has NO matching
    // response field at all — Main forces it into `e.fields` as a synthetic
    // required field (kind: 'string', parentEntity: '') so the mock can
    // filter by it. Same formula, same bug: seeded '0' instead of 'user0', so
    // a list$({user_id: 'user0'}) query matched nothing.
    test('a parent key with no real matching field (Main\'s forced-in field) seeds via parentSeed too', () => {
      const e = {
        name: 'meeting',
        idf: 'id',
        parents: ['user_id'],
        fields: [
          { name: 'id', kind: 'string', parentEntity: '' },
          { name: 'user_id', kind: 'string', parentEntity: '' },
        ],
      }

      strictEqual(seedRecord(e, 0).user_id, 'user0')
    })

    // The working case, unchanged: a parent key that DOES resolve to a real
    // entity in the model seeds that entity's id, exactly as before.
    test('a parent key resolving to a real entity still seeds that entity\'s id', () => {
      const e = {
        name: 'table',
        idf: 'id',
        parents: ['base_id'],
        fields: [
          { name: 'id', kind: 'string', parentEntity: '' },
          { name: 'base_id', kind: 'string', parentEntity: 'base' },
        ],
      }

      strictEqual(seedRecord(e, 0).base_id, 'base0')
    })
  })
})
