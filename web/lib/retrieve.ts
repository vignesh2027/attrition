// Retrieval for the chat agent. Before the model runs, the server works out
// what the question is about and fetches exactly that through Sanity Context:
// the attribute documents for any keys it names (groq_query), a namespace
// summary when it asks about an area such as "database spans" (groq_query),
// and the matching rows of the official migration guides (knowledge_base_read).
//
// The model then answers from that evidence in a single call. This keeps each
// answer to a few thousand tokens, which matters on a free model tier, and it
// means the agent never has to guess which document to open.
import 'server-only'
import {analyzeKeys, scan} from './analyze'
import {groq, groqString, kbRead, kbSearch, type TraceEntry} from './context'

const NAMESPACE_WORDS: Array<[RegExp, string]> = [
  [/\b(database|db|sql|query|queries)\b/i, 'db'],
  [/\bhttp\b|\bserver span|\bclient span|\burl\b/i, 'http'],
  [/\brpc\b|\bgrpc\b/i, 'rpc'],
  [/\bmessag(e|ing)\b|\bkafka\b|\brabbit/i, 'messaging'],
  [/\bgen[_ ]?ai\b|\bllm\b|\bgenai\b/i, 'gen_ai'],
  [/\bcode\.|\bcode attributes?\b/i, 'code'],
  [/\bnet\.|\bnetwork\b/i, 'net'],
]

export type Evidence = {
  keys: string[]
  attributes: unknown[]
  namespaces: Array<{namespace: string; deprecated: unknown[]}>
  guideRows: Array<{entry: string; rows: string[]}>
  scan?: unknown
  trace: TraceEntry[]
}

function codeBlock(text: string) {
  const m = text.match(/```[\w-]*\n([\s\S]*?)```/)
  return m ? m[1] : null
}

export async function retrieve(question: string): Promise<Evidence> {
  const trace: TraceEntry[] = []
  const code = codeBlock(question)
  const evidence: Evidence = {keys: [], attributes: [], namespaces: [], guideRows: [], trace}

  if (code) {
    const r = await scan(code)
    evidence.scan = {
      specRelease: r.specRelease,
      summary: r.summary,
      findings: r.findings.map((f) => ({
        key: f.key,
        verdict: f.verdict,
        lines: f.lines,
        spanKind: f.spanKind,
        replacement: f.replacement,
        why: f.replacementReason,
        guide: f.guidance?.comment ?? null,
        source: f.sourceUrl,
      })),
      patch: r.patch,
    }
    trace.push(...r.trace)
  }

  const prose = code ? question.replace(/```[\s\S]*?```/g, ' ') : question
  const keys = await analyzeKeys(prose, trace)
  evidence.keys = keys

  if (keys.length) {
    evidence.attributes = await groq<unknown[]>(
      `*[_type in ["attribute", "metric", "event"] && key in [${keys.map(groqString).join(', ')}]]{
        "kind": _type, key, status, stability, unit, introducedIn, lastSeenIn, specErratum, "src": source.url,
        "deprecatedValues": members[defined(deprecated)]{value, deprecated, replacementValue},
        deprecation{verdict, note, deprecatedIn, unitChange, valueChanges, "movedTo": movedTo.url, "replacements": replacements[]{key, when}}
      }`,
      trace,
    )
  }

  const wantMetrics = /\bmetrics?\b|\bhistogram|\bcounter|\bgauge|\bunit/i.test(prose)
  const namespaces = [...new Set(NAMESPACE_WORDS.filter(([rx]) => rx.test(prose)).map(([, ns]) => ns))].slice(0, 2)
  if (!keys.length) {
    for (const ns of namespaces) {
      const deprecated = await groq<unknown[]>(
        `*[_type in ${wantMetrics ? '["metric"]' : '["attribute"]'} && status != "current" && string::startsWith(key, ${groqString(`${ns}.`)})] | order(deprecation.deprecatedIn asc){
          "kind": _type, key, "v": deprecation.verdict, "in": deprecation.deprecatedIn, "lastSeenIn": lastSeenIn, "to": deprecation.replacements[].key,
          "unit": deprecation.unitChange, "movedTo": deprecation.movedTo.url
        }[0...40]`,
        trace,
      )
      evidence.namespaces.push({namespace: ns, deprecated})
    }
  }

  // Ask the Knowledge Base itself which entries cover the question: search by
  // the names it mentions, or by the question text when it names none.
  const queries = keys.length ? keys.slice(0, 3) : [prose.slice(0, 200)]
  const hits = (await Promise.all(queries.map((q) => kbSearch(q, trace, 2).catch(() => [])))).flat()
  const entries = [...new Set(hits.sort((a, b) => Number(b.path.includes('migration')) - Number(a.path.includes('migration')) || b.score - a.score).map((h) => h.path))].slice(0, 2)
  for (const entry of entries) {
    try {
      const text = await kbRead([entry], trace)
      if (!text) continue
      const lines = text.split('\n')
      const rows = lines.filter(
        (l) => /OTEL_SEMCONV_STABILITY_OPT_IN/.test(l) || (keys.length ? keys.some((k) => l.includes(`\`${k}\``)) : /^#{1,3} /.test(l)),
      )
      evidence.guideRows.push({entry, rows: rows.slice(0, 25)})
    } catch {
      // The Knowledge Base adds guidance; its absence never blocks an answer.
    }
  }
  return evidence
}
