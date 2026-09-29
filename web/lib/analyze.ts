// Turns extracted usages into findings, using only what the Sanity dataset says.
// The verdict is read from the document; the replacement for span-kind
// dependent attributes is chosen from the span kind found in the code, and
// left open when the code does not state one.
import 'server-only'
import {groq, groqString, kbRead, type TraceEntry} from './context'
import {GUIDE_FOR_NAMESPACE, guidanceFor, optInHint, type Guidance} from './guidance'
import {buildIndex, extract, type KeyIndex, type SpanKind, type Usage} from './extract'
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
  | 'NEEDS_REVIEW'

type AttributeDoc = {
  _id: string
  key: string
  status: 'current' | 'deprecated'
  stability: string
  brief?: string
  introducedIn?: string
  source: {url: string; release: string}
  deprecation?: {
    verdict: Verdict
    reason: string
    note?: string
    deprecatedIn?: string
    movedTo?: {label: string; url: string}
    replacements?: Array<{key: string; when: string; stability?: string}>
  }
}

export type Finding = {
  key: string
  status: 'current' | 'deprecated'
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
  const keys = await groq<Array<{key: string; members?: string[]}>>(
    '*[_type == "attribute"]{key, "members": members[].value}',
    trace,
  )
  cachedIndex = {index: buildIndex(keys), at: Date.now()}
  return cachedIndex.index
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
      "attrs": *[_type == "attribute" && key in [${keys.map(groqString).join(', ')}]]{
        _id, key, status, stability, brief, introducedIn,
        "source": source{url, release},
        deprecation{verdict, reason, note, deprecatedIn, movedTo{label, url},
          "replacements": replacements[]{key, when, "stability": attribute->stability}}
      }
    }`,
    trace,
  )
  const byKey = new Map(docs.map((d) => [d.key, d]))

  // Group usages by key and span kind, so one key used on both client and
  // server spans produces two findings with two different answers.
  const groups = new Map<string, Usage[]>()
  for (const u of usages) {
    const doc = byKey.get(u.key)
    const kindMatters = doc?.deprecation?.verdict === 'SPAN_KIND_DEPENDENT'
    const g = `${u.key}|${kindMatters ? u.spanKind : ''}|${u.form === 'comment' ? 'comment' : 'code'}`
    groups.set(g, [...(groups.get(g) ?? []), u])
  }

  const findings: Finding[] = []
  const edits: Edit[] = []
  for (const group of groups.values()) {
    const first = group[0]
    const doc = byKey.get(first.key)
    if (!doc) continue
    const base = {
      key: doc.key,
      status: doc.status,
      lines: group.map((u) => u.line),
      forms: [...new Set(group.map((u) => u.form))],
      stability: doc.stability,
      sourceUrl: doc.source.url,
      documentId: doc._id,
      spanKind: first.spanKind,
      spanKindLine: first.spanKindLine,
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
    findings.push({
      ...base,
      verdict: dep.verdict,
      replacement: choice.replacement,
      replacementReason: choice.reason,
      replacements: dep.replacements ?? [],
      needsDecision: choice.decide,
      deprecatedIn: dep.deprecatedIn,
      deprecatedInPinned: pinnedVersion && dep.deprecatedIn ? cmpVersion(dep.deprecatedIn, pinnedVersion.version) <= 0 : null,
      note: dep.note,
      movedTo: dep.movedTo,
    })
    if (choice.replacement && !choice.decide) {
      for (const u of group) if (u.form === 'string') edits.push({line: u.line, from: `${u.text[0]}${u.key}${u.text[0]}`, to: `${u.text[0]}${choice.replacement}${u.text[0]}`})
    }
  }

  // Knowledge Base: add what the official migration guide says about each key.
  const migrationGuides: ScanResult['migrationGuides'] = []
  const entries = [...new Set(findings.filter((f) => f.status === 'deprecated').map((f) => GUIDE_FOR_NAMESPACE[f.key.split('.')[0]]).filter(Boolean))]
  await Promise.all(
    entries.map(async (entry) => {
      try {
        const text = await kbRead([entry], trace)
        if (!text) return
        migrationGuides.push({entry, optIn: optInHint(text)})
        for (const f of findings) {
          if (GUIDE_FOR_NAMESPACE[f.key.split('.')[0]] !== entry) continue
          const g = guidanceFor(f.key, entry, text)
          // The guide files some renames under one span kind only. Say so when
          // this usage sits on the other kind, where the registry answer differs.
          const kinds = [...new Set((g?.section ?? '').toLowerCase().match(/\b(client|server)\b/g) ?? [])]
          const kind = kinds.length === 1 ? kinds[0] : undefined
          if (g && kind && f.spanKind && kind !== f.spanKind) g.appliesToOtherSpanKind = true
          if (g && (f.verdict === 'RENAMED' || f.verdict === 'REPLACED') && /^(removed|integrated)\b/i.test(g.comment ?? '')) {
            g.disagreesWithRegistry = true
            f.needsDecision = true
            f.replacementReason = `The registry says renamed to ${f.replacement}, but the migration guide says: "${g.comment}". Check the value before swapping the key.`
          }
          f.guidance = g
        }
      } catch {
        // The Knowledge Base is an enrichment. A failure here never hides a verdict.
      }
    }),
  )

  const held = new Set(findings.filter((f) => f.needsDecision).map((f) => f.key))
  const safeEdits = edits.filter((e) => ![...held].some((k) => e.from.slice(1, -1) === k))

  findings.sort((a, b) => Number(a.status === 'current') - Number(b.status === 'current') || a.lines[0] - b.lines[0])
  const deprecated = findings.filter((f) => f.status === 'deprecated')
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
