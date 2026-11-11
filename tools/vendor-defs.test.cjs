'use strict'

const { test, describe } = require('node:test')
const { strictEqual, deepStrictEqual, ok } = require('node:assert')

const Fs = require('node:fs')
const Os = require('node:os')
const Path = require('node:path')

const { compareVersions, pickLatest, check, sha256, MANIFEST } = require('./vendor-defs.cjs')


describe('vendor-defs', () => {

  test('versions compare by number, not by text', () => {
    strictEqual(compareVersions('1.10.0', '1.9.0'), 1)
    strictEqual(compareVersions('1.0.0', '1.0.0'), 0)
    strictEqual(compareVersions('v2', 'v10'), -1)
    strictEqual(compareVersions('2026.08', '2026.04'), 1)
    strictEqual(compareVersions('1.0', '1.0.1'), -1)
  })


  test('the latest version of an API is picked, never a debug file or another API', () => {
    const names = [
      'solar-1.0.0-openapi-3.0.0.yaml',
      'solar-1.0.0-openapi-3.0.0.yaml.full.json',
      'solar-1.2.0-openapi-3.0.0.yaml',
      'solar-1.10.0-openapi-3.1.0.yaml',
      'solar-1.10.0-openapi-3.1.0.yaml.full.json',
      'solarflare-9.0.0-openapi-3.0.0.yaml',
      'solar-flare-9.0.0-openapi-3.0.0.yaml',
      'solar-2026.08-graphql.graphql',
      'potentials.txt',
    ]

    deepStrictEqual(pickLatest(names, 'solar'),
      { name: 'solar-1.10.0-openapi-3.1.0.yaml', version: '1.10.0', format: '3.1.0' })
  })


  test('a newer format version of the same API version wins', () => {
    const names = ['taxonomy-1.0.0-openapi-3.0.0.yaml', 'taxonomy-1.0.0-openapi-3.1.0.yaml']
    strictEqual(pickLatest(names, 'taxonomy').name, 'taxonomy-1.0.0-openapi-3.1.0.yaml')
  })


  test('Swagger and JSON definitions qualify; an API with none answers null', () => {
    strictEqual(pickLatest(['petstore-1.0.7-swagger-2.0.json'], 'petstore').name,
      'petstore-1.0.7-swagger-2.0.json')
    strictEqual(pickLatest(['solar-1.0.0-openapi-3.0.0.yaml'], 'taxonomy'), null)
  })


  describe('check', () => {

    function stage(files, defs) {
      const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'vendor-defs-test-'))
      for (const [name, text] of Object.entries(files)) {
        Fs.writeFileSync(Path.join(dir, name), text)
      }
      Fs.writeFileSync(Path.join(dir, MANIFEST), JSON.stringify({
        source: 'https://github.com/voxgig/apidef-validate',
        ref: 'main',
        apis: [...new Set(defs.map((d) => d.api))],
        defs,
      }))
      return dir
    }

    test('vendored files that hash as recorded pass', () => {
      const dir = stage({ 'a-1.0.0-openapi-3.0.0.yaml': 'a: 1\n' },
        [{ api: 'a', file: 'a-1.0.0-openapi-3.0.0.yaml', sha256: sha256('a: 1\n') }])
      try {
        deepStrictEqual(check(dir), [])
      }
      finally {
        Fs.rmSync(dir, { recursive: true, force: true })
      }
    })

    test('an edited file and a missing file are both reported', () => {
      const dir = stage({ 'a-1.0.0-openapi-3.0.0.yaml': 'a: 2\n' }, [
        { api: 'a', file: 'a-1.0.0-openapi-3.0.0.yaml', sha256: sha256('a: 1\n') },
        { api: 'b', file: 'b-1.0.0-openapi-3.0.0.yaml', sha256: sha256('b: 1\n') },
      ])
      try {
        const found = check(dir)
        strictEqual(found.length, 2, found.join('\n'))
        ok(/a-1\.0\.0.*changed since it was vendored/.test(found[0]), found[0])
        ok(/b-1\.0\.0.*missing/.test(found[1]), found[1])
      }
      finally {
        Fs.rmSync(dir, { recursive: true, force: true })
      }
    })
  })
})
