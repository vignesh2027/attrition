// Builds data/semconv.ndjson from the releases fetched by fetch-semconv.mjs.
//
// Three kinds of names are covered: attributes, metrics and events. The newest
// release is the source of truth for every document. Every older release is
// read to work out history: which release first defined a name, which release
// first deprecated it, and which names left the spec with no deprecation entry
// at all (verdict DROPPED, with the last release that still had them).
//
// Each deprecated name gets a verdict computed here, in plain code, from
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

// Reads one release and returns {attrs, metrics, events}, each a Map from name
// to {attr|def, file}.
function readRelease(tag) {
  const root = join(CACHE, tag, 'model')
  const attrs = new Map()
  const metrics = new Map()
  const events = new Map()
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
    const file_ = relative(join(CACHE, tag), file)
    for (const m of doc?.metrics ?? []) {
      if (m?.name) metrics.set(m.name, {def: m, file: file_})
    }
    for (const group of doc?.groups ?? []) {
      if (group.type === 'metric' && group.metric_name) metrics.set(group.metric_name, {def: group, file: file_})
      // Old releases gave some event groups only an id, never a wire name; those are skipped.
      if (group.type === 'event' && group.name) events.set(group.name, {def: group, file: file_})
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
  return {attrs, metrics, events}
}

// ---------------------------------------------------------------------------
// History across releases
// ---------------------------------------------------------------------------
// kind -> name -> {introducedIn, deprecatedIn, lastSeenIn, last: {def, file}}
const history = {attribute: new Map(), metric: new Map(), event: new Map()}
const releaseStats = []
for (const tag of releases) {
  const {attrs, metrics, events} = readRelease(tag)
  let deprecated = 0
  for (const [kind, map] of [['attribute', attrs], ['metric', metrics], ['event', events]]) {
    for (const [key, entry] of map) {
      const def = entry.attr ?? entry.def
      const h = history[kind].get(key) ?? {introducedIn: tag, deprecatedIn: null}
      const dep = normalizeDeprecation(def.deprecated) || def.stability === 'deprecated'
      if (dep) {
        if (kind === 'attribute') deprecated++
        if (!h.deprecatedIn) h.deprecatedIn = tag
      }
      h.lastSeenIn = tag
      h.last = {def, file: entry.file}
      history[kind].set(key, h)
    }
  }
  releaseStats.push({tag, attributes: attrs.size, metrics: metrics.size, events: events.size, deprecated})
}

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------
const TICKED = /`([a-z][a-z0-9_]*(?:\.[a-z0-9_<>-]+)+)`/g
const SPAN_KIND = /`([a-z][a-z0-9_.]+)`\s+on\s+(?:the\s+)?(client|server|producer|consumer|internal)\s+spans/gi

function classify(dep, knownKeys) {
  const note = dep.note ?? ''
  const mentioned = [...note.matchAll(TICKED)].map((m) => m[1])
  const known = (k) => knownKeys.has(k)

  if (dep.reason === 'renamed' && dep.renamedTo) {
    return {verdict: 'RENAMED', replacements: [{key: dep.renamedTo, when: 'always'}]}
  }
  const bySpanKind = [...note.matchAll(SPAN_KIND)].map((m) => ({key: m[1], when: `${m[2].toLowerCase()} spans`}))
  if (bySpanKind.length >= 2 || (bySpanKind.length === 1 && /no replacement for (client|server|producer|consumer) spans/i.test(note))) {
    return {verdict: 'SPAN_KIND_DEPENDENT', replacements: bySpanKind}
  }
  if (/\bone of\b.*\bdepending on\b/i.test(note) && mentioned.length >= 2) {
    return {verdict: 'CONDITIONAL', replacements: mentioned.map((key) => ({key, when: 'depends on usage'}))}
  }

  const movedRepo = note.match(/Moved to the \[([^\]]+)\]\(([^)]+)\)/)
  if (movedRepo) {
    return {verdict: 'MOVED_OUT', replacements: [], movedTo: {label: movedRepo[1], url: movedRepo[2]}}
  }
  if (/\bvalue should be included in\b|\brepresentation of .* in `/i.test(note) && mentioned.length >= 1) {
    return {verdict: 'MERGED_INTO', replacements: [{key: mentioned[0], when: 'combine the value'}]}
  }
  // GenAI chat events: the content now travels on an attribute instead.
  const onAttribute = note.match(/reported on `([a-z][a-z0-9_.]+)` attribute on spans/i)
  if (onAttribute) {
    return {verdict: 'REPLACED', replacements: [{key: onAttribute[1], when: 'as a span attribute'}]}
  }
  if (/\b(EventName field|span status)\b/.test(note)) {
    return {verdict: 'USE_SIGNAL_FIELD', replacements: []}
  }
  if (/\bsplit\b/i.test(note) && mentioned.length >= 2) {
    return {verdict: 'SPLIT', replacements: mentioned.map((key) => ({key, when: 'together'}))}
  }
  if (dep.reason === 'obsoleted' || /\b(removed|no replacement)\b/i.test(note)) {
    return {verdict: 'REMOVED', replacements: mentioned.filter(known).map((key) => ({key, when: 'related'}))}
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

const latestRelease = readRelease(latest)
const current = latestRelease.attrs
const keys = new Set(current.keys())
const ids = new Map()
for (const key of keys) {
  const id = toId(key)
  if (ids.has(id)) throw new Error(`id collision: ${key} and ${ids.get(id)}`)
  ids.set(id, key)
}

function lineOf(file, key, attrId, tag = latest) {
  const text = readFileSync(join(CACHE, tag, file), 'utf8').split('\n')
  const wanted = [`- id: ${attrId}`, `- id: ${key}`, `- key: ${key}`, `metric_name: ${key}`, `- name: ${key}`, `name: ${key}`]
  const i = text.findIndex((l) => wanted.includes(l.trim()))
  return i >= 0 ? i + 1 : null
}

const sourceRef = (file, line, tag = latest) => ({
  _type: 'sourceRef',
  file,
  line,
  url: `${REPO_URL}/blob/${tag}/${file}${line ? `#L${line}` : ''}`,
  release: tag,
})

// A deprecated enum value: keep a readable note even when the spec only gives
// a reason and a renamed_to.
function memberNote(raw) {
  const d = normalizeDeprecation(raw)
  if (!d) return undefined
  if (d.note) return d.note
  if (d.renamedTo) return `Renamed to \`${d.renamedTo}\`.`
  return d.reason === 'obsoleted' ? 'Removed, no replacement at this time.' : 'Deprecated.'
}

const docs = []
const namespaces = new Map()
const verdictCounts = {}

for (const [key, {attr, file}] of current) {
  const ns = key.split('.')[0]
  namespaces.set(ns, (namespaces.get(ns) ?? 0) + 1)
  const dep = normalizeDeprecation(attr.deprecated)
  const line = lineOf(file, key, attr.id)
  const h = history.attribute.get(key)

  const typeName = typeof attr.type === 'string' ? attr.type : 'enum'
  const members = Array.isArray(attr.type?.members ?? attr.members)
    ? (attr.type?.members ?? attr.members).map((m, i) => ({
        _key: `m${i}`,
        id: String(m.id),
        value: String(m.value),
        brief: m.brief ? String(m.brief).trim() : undefined,
        stability: m.stability,
        deprecated: memberNote(m.deprecated),
        replacementValue: normalizeDeprecation(m.deprecated)?.renamedTo ?? undefined,
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
      // The key changes and so does the shape of the value: a type, a unit or a
      // string representation. A plain key swap would be wrong.
      valueChanges: /(\brepresentation\b|\bwith unit\b|\((string|int|double)\))/i.test(dep.note ?? '') || undefined,
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

// ---------------------------------------------------------------------------
// Attributes that left the spec with no deprecation entry
// ---------------------------------------------------------------------------
// Only dotted keys count: old releases defined a few bare ids such as `type`
// inside groups, which were never wire names.
let dropped = 0
for (const [key, h] of history.attribute) {
  if (keys.has(key) || !key.includes('.')) continue
  const ns = key.split('.')[0]
  if (!namespaces.has(ns)) continue
  const line = lineOf(h.last.file, key, h.last.def.id, h.lastSeenIn)
  docs.push({
    _id: toId(key),
    _type: 'attribute',
    key,
    namespace: {_type: 'reference', _ref: nsId(ns)},
    type: typeof h.last.def.type === 'string' ? h.last.def.type : 'enum',
    brief: h.last.def.brief ? String(h.last.def.brief).trim().replace(/\s+/g, ' ') : undefined,
    stability: h.last.def.stability ?? 'unspecified',
    status: 'dropped',
    introducedIn: h.introducedIn,
    lastSeenIn: h.lastSeenIn,
    source: sourceRef(h.last.file, line, h.lastSeenIn),
    deprecation: {
      _type: 'deprecation',
      verdict: 'DROPPED',
      reason: 'unspecified',
      note: `Defined up to ${h.lastSeenIn}, then removed from the spec with no deprecation entry.`,
      deprecatedIn: releases[releases.indexOf(h.lastSeenIn) + 1],
      replacements: [],
    },
  })
  verdictCounts.DROPPED = (verdictCounts.DROPPED ?? 0) + 1
  dropped++
}

// ---------------------------------------------------------------------------
// Metrics and events
// ---------------------------------------------------------------------------
// Same verdict rules as attributes. A renamed metric whose replacement uses a
// different unit is flagged from the two documents' units, not from prose.
//
// Known errata in the upstream spec, found by that unit comparison. These
// deprecated entries were copied from a network metric: their brief says
// "The number of packets transferred" and their unit is {packet}, while the
// metric they were renamed to measures memory in bytes. The values never
// changed, so no unit change is reported for them.
const SPEC_ERRATA = {
  'system.linux.memory.available':
    'Upstream copy-paste error in v1.44.0: this deprecated entry carries the brief and unit of a network packet counter. It measures memory in bytes, like its replacement.',
  'system.linux.memory.slab.usage':
    'Upstream copy-paste error in v1.44.0: this deprecated entry carries the brief and unit of a network packet counter. It measures memory in bytes, like its replacement.',
}
const sameUnit = (a, b) => a.replace(/[{}]/g, '') === b.replace(/[{}]/g, '')
const signalCounts = {}
function signalDocs(kind, prefix) {
  const latestMap = kind === 'metric' ? latestRelease.metrics : latestRelease.events
  const names = new Set(latestMap.keys())
  const id = (name) => `${prefix}-${name.replace(/\./g, '--')}`
  const out = []
  const counts = {total: 0, deprecated: 0, dropped: 0, verdicts: {}}
  for (const [name, h] of history[kind]) {
    const inLatest = latestMap.get(name)
    const def = inLatest ? inLatest.def : h.last.def
    const file = inLatest ? inLatest.file : h.last.file
    const tag = inLatest ? latest : h.lastSeenIn
    const line = lineOf(file, name, def.id, tag)
    const doc = {
      _id: id(name),
      _type: kind,
      key: name,
      namespace: name.split('.')[0],
      brief: def.brief ? String(def.brief).trim().replace(/\s+/g, ' ') : undefined,
      stability: def.stability ?? 'unspecified',
      introducedIn: h.introducedIn,
      source: sourceRef(file, line, tag),
    }
    if (kind === 'metric') {
      doc.instrument = def.instrument
      doc.unit = def.unit == null ? undefined : String(def.unit)
    }
    const dep = inLatest ? normalizeDeprecation(def.deprecated) : null
    if (!inLatest) {
      doc.status = 'dropped'
      doc.lastSeenIn = h.lastSeenIn
      doc.deprecation = {
        _type: 'deprecation',
        verdict: 'DROPPED',
        reason: 'unspecified',
        note: `Defined up to ${h.lastSeenIn}, then removed from the spec with no deprecation entry.`,
        deprecatedIn: releases[releases.indexOf(h.lastSeenIn) + 1],
        replacements: [],
      }
      counts.dropped++
    } else if (dep) {
      const {verdict, replacements, movedTo} = classify(dep, names)
      doc.status = 'deprecated'
      doc.deprecation = {
        _type: 'deprecation',
        verdict,
        reason: dep.reason ?? 'unspecified',
        // Some obsoleted entries carry their advice in the brief instead of a note.
        note: dep.note ?? (/\b(use|derive)\b/i.test(def.brief ?? '') ? String(def.brief).trim() : undefined),
        deprecatedIn: h.deprecatedIn,
        movedTo: movedTo ? {_type: 'externalLink', ...movedTo} : undefined,
        replacements: replacements.map((r, i) => ({_key: `r${i}`, _type: 'replacement', key: r.key, when: r.when})),
      }
      counts.deprecated++
    } else {
      doc.status = 'current'
    }
    if (doc.deprecation) counts.verdicts[doc.deprecation.verdict] = (counts.verdicts[doc.deprecation.verdict] ?? 0) + 1
    counts.total++
    out.push(doc)
  }
  // Unit changes: compare each renamed metric with its replacement document.
  if (kind === 'metric') {
    const byName = new Map(out.map((d) => [d.key, d]))
    for (const d of out) {
      const rep = d.deprecation?.replacements?.[0]
      const target = rep && byName.get(rep.key)
      if (target) rep.metric = {_type: 'reference', _ref: target._id, _weak: true}
      if (SPEC_ERRATA[d.key]) {
        d.specErratum = SPEC_ERRATA[d.key]
      } else if (target && d.unit && target.unit && !sameUnit(d.unit, target.unit)) {
        d.deprecation.valueChanges = true
        d.deprecation.unitChange = {_type: 'unitChange', from: d.unit, to: target.unit}
      } else if (/\bwith unit\b/i.test(d.deprecation?.note ?? '')) {
        d.deprecation.valueChanges = true
      }
    }
  }
  signalCounts[kind] = counts
  return out
}
docs.push(...signalDocs('metric', 'metric'), ...signalDocs('event', 'event'))

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
const deprecated = docs.filter((d) => d._type === 'attribute' && d.status === 'deprecated').length
const summary = {
  latest,
  releases: releases.length,
  documents: docs.length,
  attributes: current.size,
  deprecated,
  droppedAttributes: dropped,
  verdictCounts,
  metrics: signalCounts.metric,
  events: signalCounts.event,
  deprecatedEnumValues: docs.reduce((n, d) => n + (d.members ?? []).filter((m) => m.deprecated).length, 0),
  renameChains: chains,
  namespaces: namespaces.size,
}
writeFileSync(join(OUT, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
console.log(JSON.stringify(summary, null, 1))
