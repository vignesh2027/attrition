// Turns extracted usages into findings, using only what the Sanity dataset says.
// The verdict is read from the document; the replacement for span-kind
// dependent attributes is chosen from the span kind found in the code, and
// left open when the code does not state one.
import 'server-only'
import {groq, groqString, kbRead, kbSearch, type TraceEntry} from './context'
import {guidanceFor, optInHint, type Guidance} from './guidance'
import {buildIndex, extract, type KeyIndex, type Kind, type SpanKind, type Usage} from './extract'
import {buildPatch, type Edit} from './patch'

export type Verdict =
  | 'RENAMED'
  | 'REPLACED'
  | 'SPAN_KIND_DEPENDENT'
  | 'SPLIT'
  | 'CONDITIONAL'
  | 'MERGED_INTO'
  | 'USE_SIGNAL_FIELD'
  | 'MOVED_OUT'
  | 'REMOVED'
  | 'DROPPED'
  | 'VALUE_RENAMED'
  | 'VALUE_REMOVED'
  | 'NEEDS_REVIEW'

type AttributeDoc = {
  _id: string
  _type: Kind
  key: string
  status: 'current' | 'deprecated' | 'dropped'
  stability: string
  brief?: string
  introducedIn?: string
  lastSeenIn?: string
  unit?: string
  specErratum?: string
  deprecatedMembers?: Array<{value: string; deprecated: string; replacementValue?: string}>
  source: {url: string; release: string}
  deprecation?: {
    unitChange?: {from: string; to: string}
    verdict: Verdict
    reason: string
    note?: string
    deprecatedIn?: string
    valueChanges?: boolean
    movedTo?: {label: string; url: string}
    replacements?: Array<{key: string; when: string; stability?: string}>
  }
}

export type Finding = {
  key: string
  kind: Kind
  // Present when the finding is a deprecated enum value of the attribute.
  value?: string
  status: 'current' | 'deprecated' | 'dropped'
  unit?: string
  unitChange?: {from: string; to: string}
  lastSeenIn?: string
  specErratum?: string
  verdict: Verdict | 'CURRENT'
  lines: number[]
  forms: Usage['form'][]
  replacement: string | null
  replacementReason: string
  replacements: Array<{key: string; when: string; stability?: string}>
  needsDecision: boolean
  deprecatedIn?: string
  deprecatedInPinned: boolean | null
  note?: string
  movedTo?: {label: string; url: string}
  stability: string
  sourceUrl: string
  documentId: string
  spanKind: SpanKind | null
  spanKindLine: number | null
  guidance?: Guidance | null
}

export type ScanResult = {
  language: string
  pinnedVersion: {version: string; line: number; text: string} | null
  specRelease: string
  findings: Finding[]
  unknown: Array<{key: string; line: number; namespace: string}>
  migrationGuides: Array<{entry: string; optIn: string | null}>
  summary: {usages: number; attributes: number; deprecated: number; autoFixable: number; needDecision: number}
  patch: string | null
  edits: Edit[]
  trace: TraceEntry[]
}

let cachedIndex: {index: KeyIndex; at: number} | null = null

async function keyIndex(trace: TraceEntry[]) {
  if (cachedIndex && Date.now() - cachedIndex.at < 10 * 60_000) {
    trace.push({tool: 'groq_query', query: '(key index, cached)', ms: 0})
    return cachedIndex.index
  }
  const keys = await groq<Array<{kind: Kind; key: string; members?: string[]; deprecatedValues?: string[]}>>(
    '*[_type in ["attribute", "metric", "event"]]{"kind": _type, key, "members": members[].value, "deprecatedValues": members[defined(deprecated)].value}',
    trace,
  )
  cachedIndex = {index: buildIndex(keys), at: Date.now()}
  return cachedIndex.index
}

// Attribute, metric and event names mentioned in plain prose, for example a chat question.
export async function analyzeKeys(text: string, trace: TraceEntry[]): Promise<string[]> {
  const index = await keyIndex(trace)
  const found = new Set<string>()
  for (const m of text.matchAll(/[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+/g)) {
    const k = m[0].replace(/\.$/, '')
    if (index.byKey.has(k) || index.metrics.has(k) || index.events.has(k)) found.add(k)
  }
  return [...found].slice(0, 12)
}

const cmpVersion = (a: string, b: string) => {
  const pa = a.replace(/^v/, '').split('.').map(Number)
  const pb = b.replace(/^v/, '').split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0)
  return 0
}

function chooseReplacement(doc: AttributeDoc, spanKind: SpanKind | null) {
  const dep = doc.deprecation!
  const reps = dep.replacements ?? []
  switch (dep.verdict) {
    case 'RENAMED':
    case 'REPLACED':
      // An event whose content now travels on a span attribute: this is a
      // change of signal, not a string swap, so it never goes in the patch.
      if (reps[0] && reps[0].when !== 'always') {
        return {
          replacement: reps[0].key,
          reason: `Stop emitting this ${doc._type}. The spec now records it ${reps[0].when.replace(/^as an? /, 'as a ')}: ${reps[0].key}.`,
          decide: true,
        }
      }
      if (dep.unitChange) {
        return {
          replacement: reps[0]?.key ?? null,
          reason: `The name changes and so does the unit, from ${dep.unitChange.from} to ${dep.unitChange.to}. Recorded values must be converted, not just renamed.`,
          decide: true,
        }
      }
      if (dep.valueChanges) {
        return {replacement: reps[0]?.key ?? null, reason: `The key changes and so does the value format: ${dep.note ?? 'see the spec note'}`, decide: true}
      }
      return {replacement: reps[0]?.key ?? null, reason: 'The spec names one replacement.', decide: false}
    case 'SPAN_KIND_DEPENDENT': {
      if (!spanKind) {
        return {replacement: null, reason: 'The replacement depends on the span kind, and this code does not state one.', decide: true}
      }
      const hit = reps.find((r) => r.when.startsWith(spanKind))
      return hit
        ? {replacement: hit.key, reason: `This usage sits on a ${spanKind} span, so the spec says ${hit.key}.`, decide: false}
        : {replacement: null, reason: `The spec gives no replacement for ${spanKind} spans.`, decide: true}
    }
    case 'MERGED_INTO':
      return {replacement: reps[0]?.key ?? null, reason: 'Fold this value into the named attribute; it is not a plain rename.', decide: true}
    case 'SPLIT':
      return {replacement: null, reason: `Set all of: ${reps.map((r) => r.key).join(', ')}.`, decide: true}
    case 'CONDITIONAL':
      return {replacement: null, reason: dep.note ?? 'The note states a condition.', decide: true}
    case 'REMOVED':
      return {replacement: null, reason: 'Removed from the spec with no replacement. Delete it.', decide: true}
    case 'MOVED_OUT':
      return {replacement: null, reason: `Moved to ${dep.movedTo?.label ?? 'another repository'}. Not removed.`, decide: true}
    case 'USE_SIGNAL_FIELD':
      return {replacement: null, reason: dep.note ?? 'Use a field of the signal instead.', decide: true}
    case 'DROPPED':
      return {
        replacement: null,
        reason: `Last defined in ${doc.lastSeenIn}, then removed from the spec with no deprecation entry. The registry names no replacement.`,
        decide: true,
      }
    default:
      return {replacement: null, reason: 'Needs human review.', decide: true}
  }
}

export async function scan(code: string): Promise<ScanResult> {
  const trace: TraceEntry[] = []
  const index = await keyIndex(trace)
  const {usages, unknown, pinnedVersion, language} = extract(code, index)

  const keys = [...new Set(usages.map((u) => u.key))]
  const {release, attrs: docs} = await groq<{release: string | null; attrs: AttributeDoc[]}>(
    `{
      "release": *[_type == "specRelease"][0].tag,
      "attrs": *[_type in ["attribute", "metric", "event"] && key in [${keys.map(groqString).join(', ')}]]{
        _id, _type, key, status, stability, brief, introducedIn, lastSeenIn, unit, specErratum,
        "source": source{url, release},
        "deprecatedMembers": members[defined(deprecated)]{value, deprecated, replacementValue},
        deprecation{verdict, reason, note, deprecatedIn, valueChanges, unitChange{from, to}, movedTo{label, url},
          "replacements": replacements[]{key, when, "stability": coalesce(attribute->stability, metric->stability)}}
      }
    }`,
    trace,
  )
  const byKey = new Map(docs.map((d) => [`${d._type}:${d.key}`, d]))

  // Group usages by name, kind and span kind, so one key used on both client
  // and server spans produces two findings with two different answers.
  const groups = new Map<string, Usage[]>()
  for (const u of usages) {
    const doc = byKey.get(`${u.kind}:${u.key}`)
    const kindMatters = doc?.deprecation?.verdict === 'SPAN_KIND_DEPENDENT'
    const g = `${u.kind}|${u.key}|${u.value ?? ''}|${kindMatters ? u.spanKind : ''}|${u.form === 'comment' ? 'comment' : 'code'}`
    groups.set(g, [...(groups.get(g) ?? []), u])
  }

  const findings: Finding[] = []
  const pending: Array<{finding: Finding; edit: Edit}> = []
  for (const group of groups.values()) {
    const first = group[0]
    const doc = byKey.get(`${first.kind}:${first.key}`)
    if (!doc) continue
    const base = {
      key: doc.key,
      kind: doc._type,
      unit: doc.unit,
      lastSeenIn: doc.lastSeenIn,
      specErratum: doc.specErratum,
      status: doc.status,
      lines: group.map((u) => u.line),
      forms: [...new Set(group.map((u) => u.form))],
      stability: doc.stability,
      sourceUrl: doc.source.url,
      documentId: doc._id,
      spanKind: first.spanKind,
      spanKindLine: first.spanKindLine,
    }
    // A deprecated enum value on an attribute whose key may be perfectly current.
    if (first.value) {
      const member = doc.deprecatedMembers?.find((m) => m.value === first.value)
      if (!member) continue
      const finding: Finding = {
        ...base,
        value: first.value,
        status: 'deprecated',
        verdict: member.replacementValue ? 'VALUE_RENAMED' : 'VALUE_REMOVED',
        replacement: member.replacementValue ?? null,
        replacementReason: member.replacementValue
          ? `The value "${first.value}" of ${doc.key} was renamed to "${member.replacementValue}".`
          : `The value "${first.value}" of ${doc.key} is deprecated: ${member.deprecated}`,
        replacements: [],
        needsDecision: !member.replacementValue,
        note: member.deprecated,
        deprecatedInPinned: null,
      }
      findings.push(finding)
      if (member.replacementValue) {
        for (const u of group) {
          if (u.form === 'string') pending.push({finding, edit: {line: u.line, from: u.text, to: `${u.text[0]}${member.replacementValue}${u.text[0]}`}})
        }
      }
      continue
    }
    if (doc.status === 'current' || !doc.deprecation) {
      findings.push({
        ...base,
        verdict: 'CURRENT',
        replacement: null,
        replacementReason: 'Current in the spec.',
        replacements: [],
        needsDecision: false,
        deprecatedInPinned: null,
      })
      continue
    }
    const dep = doc.deprecation
    const choice = chooseReplacement(doc, first.spanKind)
    const finding: Finding = {
      ...base,
      unitChange: dep.unitChange,
      verdict: dep.verdict,
      replacement: choice.replacement,
      replacementReason: choice.reason,
      replacements: dep.replacements ?? [],
      needsDecision: choice.decide,
      deprecatedIn: dep.deprecatedIn,
      deprecatedInPinned: pinnedVersion && dep.deprecatedIn ? cmpVersion(dep.deprecatedIn, pinnedVersion.version) <= 0 : null,
      note: dep.verdict === 'DROPPED' ? undefined : dep.note,
      movedTo: dep.movedTo,
    }
    findings.push(finding)
    if (choice.replacement) {
      for (const u of group) {
        if (u.form === 'string') pending.push({finding, edit: {line: u.line, from: `${u.text[0]}${u.key}${u.text[0]}`, to: `${u.text[0]}${choice.replacement}${u.text[0]}`}})
      }
    }
  }

  // Knowledge Base: ask it about each retired name (knowledge_base_search),
  // read the entries it points to (knowledge_base_read), and keep the guide
  // row that talks about that name. Entry paths change between builds, so
  // none are hard-coded.
  const migrationGuides: ScanResult['migrationGuides'] = []
  const retired = findings.filter((f) => f.status !== 'current' && !f.value)
  // One search per namespace finds its migration guide; dropped names, which
  // only a guide can answer, also get a search of their own.
  const GUIDE_WORD: Record<string, string> = {db: 'database', net: 'http', url: 'http'}
  const nsOf = (key: string) => key.split('.')[0]
  const namespaces = [...new Set(retired.map((f) => nsOf(f.key)))].slice(0, 4)
  const dropped = [...new Set(retired.filter((f) => f.verdict === 'DROPPED').map((f) => f.key))].slice(0, 4)
  try {
    const [nsHits, keyHits] = await Promise.all([
      Promise.all(namespaces.map(async (ns) => [ns, (await kbSearch(`${GUIDE_WORD[ns] ?? ns} migration`, trace, 3)).map((h) => h.path)] as const)),
      Promise.all(dropped.map(async (k) => [k, (await kbSearch(k, trace, 2)).map((h) => h.path)] as const)),
    ])
    const guidesFor = new Map(nsHits.map(([ns, paths]) => [ns, paths.filter((p) => p.includes('migration'))]))
    const extraFor = new Map(keyHits)
    const candidates = (f: Finding) => [...new Set([...(guidesFor.get(nsOf(f.key)) ?? []), ...(extraFor.get(f.key) ?? [])])]
    const entries = [...new Set(retired.flatMap(candidates))].slice(0, 6)
    const texts = new Map(
      await Promise.all(entries.map(async (e) => [e, (await kbRead([e], trace).catch(() => null)) ?? ''] as const)),
    )
    for (const [entry, text] of texts) {
      const optIn = optInHint(text)
      if (optIn && entry.includes('migration')) migrationGuides.push({entry, optIn})
    }
    for (const f of retired) {
      let g: Guidance | null = null
      for (const entry of candidates(f)) {
        g = texts.has(entry) ? guidanceFor(f.key, entry, texts.get(entry)!) : null
        if (g) break
      }
      if (!g) continue
      // The guide files some renames under one span kind only. Say so when
      // this usage sits on the other kind, where the registry answer differs.
      const kinds = [...new Set((g.section ?? '').toLowerCase().match(/\b(client|server)\b/g) ?? [])]
      const kind = kinds.length === 1 ? kinds[0] : undefined
      if (f.kind === 'attribute' && kind && f.spanKind && kind !== f.spanKind) g.appliesToOtherSpanKind = true
      // A name the registry dropped silently: the guide is the only source of a replacement.
      if (f.verdict === 'DROPPED' && g.change.includes('→')) {
        const guided = g.change.split('→')[1].trim()
        f.replacement = guided
        f.replacementReason = `The registry has no record of this name after ${f.lastSeenIn}. The migration guide maps it to ${guided}${g.comment ? `. ${g.comment}` : ''}.`
      }
      if ((f.verdict === 'RENAMED' || f.verdict === 'REPLACED') && /^(removed|integrated)\b/i.test(g.comment ?? '')) {
        g.disagreesWithRegistry = true
        f.needsDecision = true
        f.replacementReason = `The registry says renamed to ${f.replacement}, but the migration guide says: "${g.comment}". Check the value before swapping the key.`
      }
      f.guidance = g
    }
  } catch {
    // The Knowledge Base is an enrichment. A failure here never hides a verdict.
  }

  // Only unambiguous renames reach the patch; anything that needs a person stays out.
  const safeEdits = pending.filter((p) => !p.finding.needsDecision && p.finding.replacement).map((p) => p.edit)

  findings.sort((a, b) => Number(a.status === 'current') - Number(b.status === 'current') || a.lines[0] - b.lines[0])
  const deprecated = findings.filter((f) => f.status !== 'current')
  return {
    language,
    pinnedVersion,
    specRelease: release ?? 'unknown',
    findings,
    unknown,
    migrationGuides,
    summary: {
      usages: usages.length,
      attributes: findings.length,
      deprecated: deprecated.length,
      autoFixable: deprecated.filter((f) => f.replacement && !f.needsDecision).length,
      needDecision: deprecated.filter((f) => f.needsDecision).length,
    },
    patch: safeEdits.length ? buildPatch(code, safeEdits) : null,
    edits: safeEdits,
    trace,
  }
}
