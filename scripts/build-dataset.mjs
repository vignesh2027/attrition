// Builds data/semconv.ndjson from the releases fetched by fetch-semconv.mjs.
//
// The newest release is the source of truth for every attribute document.
// Every older release is read only to work out history: which release first
// defined an attribute and which release first deprecated it.
//
// Each deprecated attribute gets a verdict computed here, in plain code, from
// the structured fields the spec ships (reason, renamed_to, note). The agent
// never invents a verdict; it reads this one.
import {readFileSync, readdirSync, statSync, mkdirSync, writeFileSync} from 'node:fs'
import {join, relative} from 'node:path'
import YAML from 'yaml'

const CACHE = join(process.cwd(), '.cache', 'semconv')
const OUT = join(process.cwd(), 'data')
const REPO_URL = 'https://github.com/open-telemetry/semantic-conventions'

const versionKey = (tag) => tag.slice(1).split('.').map(Number)
const byVersion = (a, b) => {
  const [x, y] = [versionKey(a), versionKey(b)]
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]
  return 0
}
const releases = readdirSync(CACHE).filter((d) => /^v\d+\.\d+\.\d+$/.test(d)).sort(byVersion)
const latest = releases.at(-1)

function yamlFiles(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...yamlFiles(p))
    else if (/\.ya?ml$/.test(name)) out.push(p)
  }
  return out
}

// Older releases wrote `deprecated: "Replaced by ..."`; newer ones use an object.
function normalizeDeprecation(dep) {
  if (dep == null || dep === false) return null
  if (typeof dep === 'string') return {reason: null, renamedTo: null, note: dep.trim()}
  return {
    reason: dep.reason ?? null,
    renamedTo: dep.renamed_to ?? null,
    note: typeof dep.note === 'string' ? dep.note.trim().replace(/\s+/g, ' ') : null,
  }
}

// Reads one release and returns Map<attributeKey, {attr, group, file}>.
function readRelease(tag) {
  const root = join(CACHE, tag, 'model')
  const attrs = new Map()
  for (const file of yamlFiles(root)) {
    let doc
    try {
      doc = YAML.parse(readFileSync(file, 'utf8'))
    } catch {
      continue
    }
    // file_format definition/2 (v1.44.0+) lists registry attributes at the top
    // level with `key` instead of `id`, and no enclosing group.
    for (const attr of doc?.attributes ?? []) {
      const key = attr?.key ?? attr?.id
      if (!key) continue
      attrs.set(key, {attr: {...attr, id: key}, group: {}, isRegistry: true, file: relative(join(CACHE, tag), file)})
    }
    for (const group of doc?.groups ?? []) {
      for (const attr of group.attributes ?? []) {
        if (!attr?.id) continue
        const key = group.prefix ? `${group.prefix}.${attr.id}` : attr.id
        const isRegistry = String(group.id ?? '').startsWith('registry.')
        const prev = attrs.get(key)
        // Prefer the registry definition over a semantic-convention group that redefines it.
        if (!prev || (isRegistry && !prev.isRegistry)) {
          attrs.set(key, {attr, group, isRegistry, file: relative(join(CACHE, tag), file)})
        }
      }
    }
  }
  return attrs
}

// ---------------------------------------------------------------------------
// History across releases
// ---------------------------------------------------------------------------
const history = new Map() // key -> {introducedIn, deprecatedIn}
const releaseStats = []
for (const tag of releases) {
  const attrs = readRelease(tag)
  let deprecated = 0
  for (const [key, {attr}] of attrs) {
    const h = history.get(key) ?? {introducedIn: tag, deprecatedIn: null}
    const dep = normalizeDeprecation(attr.deprecated) || attr.stability === 'deprecated'
    if (dep) {
      deprecated++
      if (!h.deprecatedIn) h.deprecatedIn = tag
    }
    history.set(key, h)
  }
  releaseStats.push({tag, attributes: attrs.size, deprecated})
}

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------
const TICKED = /`([a-z][a-z0-9_]*(?:\.[a-z0-9_<>-]+)+)`/g
const SPAN_KIND = /`([a-z][a-z0-9_.]+)`\s+on\s+(client|server|producer|consumer|internal)\s+spans/gi

function classify(dep, knownKeys) {
  const note = dep.note ?? ''
  const mentioned = [...note.matchAll(TICKED)].map((m) => m[1])
  const known = (k) => knownKeys.has(k)

  if (dep.reason === 'renamed' && dep.renamedTo) {
    return {verdict: 'RENAMED', replacements: [{key: dep.renamedTo, when: 'always'}]}
  }
  const bySpanKind = [...note.matchAll(SPAN_KIND)].map((m) => ({key: m[1], when: `${m[2].toLowerCase()} spans`}))
  if (bySpanKind.length >= 2) return {verdict: 'SPAN_KIND_DEPENDENT', replacements: bySpanKind}

  const movedRepo = note.match(/Moved to the \[([^\]]+)\]\(([^)]+)\)/)
  if (movedRepo) {
    return {verdict: 'MOVED_OUT', replacements: [], movedTo: {label: movedRepo[1], url: movedRepo[2]}}
  }
  if (/\bvalue should be included in\b|\brepresentation of .* in `/i.test(note) && mentioned.length >= 1) {
    return {verdict: 'MERGED_INTO', replacements: [{key: mentioned[0], when: 'combine the value'}]}
  }
  if (/\b(EventName field|span status)\b/.test(note)) {
    return {verdict: 'USE_SIGNAL_FIELD', replacements: []}
  }
  if (dep.reason === 'obsoleted' || /\b(removed|no replacement)\b/i.test(note)) {
    return {verdict: 'REMOVED', replacements: mentioned.filter(known).map((key) => ({key, when: 'related'}))}
  }
  if (/\bsplit\b/i.test(note) && mentioned.length >= 2) {
    return {verdict: 'SPLIT', replacements: mentioned.map((key) => ({key, when: 'together'}))}
  }
  if (/\b(only if|unless|when)\b/i.test(note) && mentioned.length >= 1) {
    return {verdict: 'CONDITIONAL', replacements: mentioned.map((key) => ({key, when: 'condition in note'}))}
  }
  if (/\b(replaced by|use|renamed to)\b/i.test(note) && mentioned.length >= 2 && /\band\b/.test(note)) {
    return {verdict: 'SPLIT', replacements: mentioned.map((key) => ({key, when: 'together'}))}
  }
  if (/\b(replaced by|use|renamed to)\b/i.test(note) && mentioned.length >= 1) {
    return {verdict: 'REPLACED', replacements: [{key: mentioned[0], when: 'always'}]}
  }
  return {verdict: 'NEEDS_REVIEW', replacements: []}
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------
const toId = (key) => `attr-${key.replace(/\./g, '--')}`
const nsId = (ns) => `ns-${ns}`

const current = readRelease(latest)
const keys = new Set(current.keys())
const ids = new Map()
for (const key of keys) {
  const id = toId(key)
  if (ids.has(id)) throw new Error(`id collision: ${key} and ${ids.get(id)}`)
  ids.set(id, key)
}

function lineOf(file, key, attrId) {
  const text = readFileSync(join(CACHE, latest, file), 'utf8').split('\n')
  const i = text.findIndex((l) => [`- id: ${attrId}`, `- id: ${key}`, `- key: ${key}`].includes(l.trim()))
  return i >= 0 ? i + 1 : null
}

const docs = []
const namespaces = new Map()
const verdictCounts = {}

for (const [key, {attr, file}] of current) {
  const ns = key.split('.')[0]
  namespaces.set(ns, (namespaces.get(ns) ?? 0) + 1)
  const dep = normalizeDeprecation(attr.deprecated)
  const line = lineOf(file, key, attr.id)
  const h = history.get(key)

  const typeName = typeof attr.type === 'string' ? attr.type : 'enum'
  const members = Array.isArray(attr.type?.members ?? attr.members)
    ? (attr.type?.members ?? attr.members).map((m, i) => ({
        _key: `m${i}`,
        id: String(m.id),
        value: String(m.value),
        brief: m.brief ? String(m.brief).trim() : undefined,
        stability: m.stability,
        deprecated: normalizeDeprecation(m.deprecated)?.note ?? undefined,
      }))
    : undefined

  const doc = {
    _id: toId(key),
    _type: 'attribute',
    key,
    namespace: {_type: 'reference', _ref: nsId(ns)},
    type: typeName,
    brief: attr.brief ? String(attr.brief).trim().replace(/\s+/g, ' ') : undefined,
    note: attr.note ? String(attr.note).trim() : undefined,
    stability: attr.stability ?? 'unspecified',
    examples: attr.examples == null ? undefined : [].concat(attr.examples).map((e) => JSON.stringify(e)),
    members,
    status: dep ? 'deprecated' : 'current',
    introducedIn: h?.introducedIn,
    source: {
      _type: 'sourceRef',
      file,
      line,
      url: `${REPO_URL}/blob/${latest}/${file}${line ? `#L${line}` : ''}`,
      release: latest,
    },
  }

  if (dep) {
    const {verdict, replacements, movedTo} = classify(dep, keys)
    verdictCounts[verdict] = (verdictCounts[verdict] ?? 0) + 1
    doc.deprecation = {
      _type: 'deprecation',
      verdict,
      reason: dep.reason ?? 'unspecified',
      note: dep.note ?? undefined,
      deprecatedIn: h?.deprecatedIn,
      movedTo: movedTo ? {_type: 'externalLink', ...movedTo} : undefined,
      replacements: replacements.map((r, i) => ({
        _key: `r${i}`,
        _type: 'replacement',
        key: r.key,
        when: r.when,
        attribute: keys.has(r.key) ? {_type: 'reference', _ref: toId(r.key), _weak: true} : undefined,
      })),
    }
  }
  docs.push(doc)
}

// Follow rename chains so an agent can jump straight to the attribute to use today.
const byKey = new Map(docs.map((d) => [d.key, d]))
let chains = 0
for (const d of docs) {
  const reps = d.deprecation?.replacements
  if (!reps || reps.length !== 1 || reps[0].when !== 'always') continue
  const path = [d.key]
  let next = byKey.get(reps[0].key)
  while (next && next.deprecation?.replacements?.length === 1 && next.deprecation.replacements[0].when === 'always') {
    if (path.includes(next.key)) break
    path.push(next.key)
    next = byKey.get(next.deprecation.replacements[0].key)
  }
  if (next && path.length > 1) {
    path.push(next.key)
    d.deprecation.finalReplacement = {_type: 'reference', _ref: toId(next.key), _weak: true}
    d.deprecation.renameChain = path
    chains++
  }
}

for (const [ns, count] of namespaces) {
  docs.push({_id: nsId(ns), _type: 'namespace', name: ns, attributeCount: count})
}
docs.push({
  _id: 'spec-release-latest',
  _type: 'specRelease',
  tag: latest,
  repository: REPO_URL,
  releasesScanned: releaseStats.map(({tag, attributes, deprecated}, i) => ({_key: `v${i}`, tag, attributes, deprecated})),
})

mkdirSync(OUT, {recursive: true})
writeFileSync(join(OUT, 'semconv.ndjson'), docs.map((d) => JSON.stringify(d)).join('\n') + '\n')
const deprecated = docs.filter((d) => d.status === 'deprecated').length
writeFileSync(
  join(OUT, 'summary.json'),
  JSON.stringify({latest, releases: releases.length, attributes: current.size, deprecated, verdictCounts, renameChains: chains, namespaces: namespaces.size}, null, 2) + '\n',
)
console.log({latest, releases: releases.length, attributes: current.size, deprecated, verdictCounts, renameChains: chains, namespaces: namespaces.size, documents: docs.length})
