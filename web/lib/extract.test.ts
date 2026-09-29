import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {buildIndex, extract} from './extract.ts'
import {buildPatch} from './patch.ts'

const keys = JSON.parse(readFileSync(new URL('./fixtures-keys.json', import.meta.url), 'utf8'))
const index = buildIndex(keys)
const sample = (name: string) => readFileSync(new URL(`../samples/${name}`, import.meta.url), 'utf8')

const summary = (code: string) =>
  extract(code, index).usages.map((u) => `${u.line}:${u.key}:${u.form}:${u.spanKind ?? '-'}`)

test('Bug Smash hook: finds the four real attribute keys and ignores redis.shard', () => {
  const got = summary(sample('bugsmash-redishook.go'))
  const keysFound = [...new Set(got.map((s) => s.split(':')[1]))].sort()
  assert.deepEqual(keysFound, ['db.operation', 'db.system', 'server.address', 'server.port'])
  // Every usage in ProcessHook sits under trace.SpanKindClient.
  assert.ok(got.filter((s) => s.startsWith('4')).every((s) => s.endsWith(':client')))
})

test('Node checkout: resolves SEMATTRS constants and assigns server vs client span kinds', () => {
  const got = extract(sample('node-checkout.ts'), index).usages
  const peer = got.filter((u) => u.key === 'net.peer.name')
  assert.equal(peer.length, 2)
  assert.deepEqual(peer.map((u) => u.spanKind).sort(), ['client', 'server'])
  assert.ok(got.some((u) => u.key === 'http.method' && u.form === 'constant'))
  assert.ok(got.some((u) => u.key === 'http.method' && u.form === 'string'))
})

test('Python: resolves SpanAttributes constants and gen_ai string keys', () => {
  const keysFound = new Set(extract(sample('python-orders.py'), index).usages.map((u) => u.key))
  for (const k of ['db.system', 'db.statement', 'db.sql.table', 'db.name', 'gen_ai.request.model', 'code.function']) {
    assert.ok(keysFound.has(k), `missing ${k}`)
  }
})

test('Go enum constants map back to their attribute', () => {
  const got = extract('package x\nfunc f() {\n\t_ = semconv.DBSystemRedis\n\t_ = semconv.HTTPRequestMethodKey\n}\n', index).usages
  assert.deepEqual(
    got.map((u) => [u.key, u.form]),
    [
      ['db.system', 'enum-constant'],
      ['http.request.method', 'constant'],
    ],
  )
})

test('pinned semconv version is read from a Go import path', () => {
  const r = extract('import semconv "go.opentelemetry.io/otel/semconv/v1.26.0"\n', index)
  assert.equal(r.pinnedVersion?.version, 'v1.26.0')
})

test('patch only touches the changed literal', () => {
  const code = 'a\nattribute.String("db.system", "redis")\nb\n'
  const p = buildPatch(code, [{line: 2, from: '"db.system"', to: '"db.system.name"'}])
  assert.match(p, /-attribute\.String\("db\.system", "redis"\)/)
  assert.match(p, /\+attribute\.String\("db\.system\.name", "redis"\)/)
})

test('usages inside comments are marked, not treated as code', () => {
  const got = extract('// use semconv.DBSystemSqlite here\nx := attribute.String("db.system", "a") // was "db.name"\n', index).usages
  assert.deepEqual(
    got.map((u) => [u.line, u.key, u.form]),
    [
      [1, 'db.system', 'comment'],
      [2, 'db.system', 'string'],
      [2, 'db.name', 'comment'],
    ],
  )
})
