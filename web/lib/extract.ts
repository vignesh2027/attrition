// Deterministic extraction of OpenTelemetry attribute usage from source code.
//
// Nothing here calls a model. Given the list of attribute keys that exist in
// the spec (fetched from Sanity), it finds:
//   - string literals that are exact attribute keys ("db.system")
//   - semconv constants from the Go, JS, Java and Python SDKs (DBSystemKey,
//     ATTR_DB_SYSTEM, SEMATTRS_DB_SYSTEM, DbIncubatingAttributes.DB_SYSTEM)
//   - the span kind in effect near each usage, when the code states one
//   - the semconv version the file pins, when it imports a versioned package

export type KeyInfo = {key: string; members?: string[]}

export type SpanKind = 'client' | 'server' | 'producer' | 'consumer' | 'internal'

export type Usage = {
  key: string
  line: number
  column: number
  text: string
  form: 'string' | 'constant' | 'enum-constant'
  spanKind: SpanKind | null
  spanKindLine: number | null
}

export type Extraction = {
  usages: Usage[]
  // String keys set as attributes under a namespace the spec owns (db., http.)
  // but that the spec does not define. Reported, never rewritten.
  unknown: Array<{key: string; line: number; namespace: string}>
  pinnedVersion: {version: string; line: number; text: string} | null
  language: 'go' | 'typescript' | 'javascript' | 'python' | 'java' | 'unknown'
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

export function buildIndex(keys: KeyInfo[]) {
  const byKey = new Map<string, KeyInfo>()
  const byNorm = new Map<string, string[]>()
  const namespaces = new Set<string>()
  for (const k of keys) {
    namespaces.add(k.key.split('.')[0])
    byKey.set(k.key, k)
    const n = norm(k.key)
    byNorm.set(n, [...(byNorm.get(n) ?? []), k.key])
  }
  return {byKey, byNorm, namespaces}
}

export type KeyIndex = ReturnType<typeof buildIndex>

export function detectLanguage(code: string): Extraction['language'] {
  if (/^\s*package\s+\w+/m.test(code) && /\bfunc\b/.test(code)) return 'go'
  if (/^\s*(import|package)\s+[\w.]+;/m.test(code) || /\bpublic\s+(class|static)\b/.test(code)) return 'java'
  if (/^\s*(from\s+[\w.]+\s+import|import\s+\w+)\s*$/m.test(code) || /\bdef\s+\w+\(/.test(code)) return 'python'
  if (/:\s*(string|number|boolean)\b|\binterface\s+\w+|\bimport\s+type\b/.test(code)) return 'typescript'
  if (/\b(const|let|require\(|import\s+.*from)\b/.test(code)) return 'javascript'
  return 'unknown'
}

const SPAN_KIND_PATTERNS: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
  // Go: trace.SpanKindClient, trace.WithSpanKind(trace.SpanKindServer)
  [/SpanKind(Client|Server|Producer|Consumer|Internal)\b/g, (m) => m[1]],
  // JS/TS/Java/Python: SpanKind.CLIENT, SpanKind.SERVER
  [/SpanKind\.(CLIENT|SERVER|PRODUCER|CONSUMER|INTERNAL)\b/g, (m) => m[1]],
  // OTLP enum names
  [/SPAN_KIND_(CLIENT|SERVER|PRODUCER|CONSUMER|INTERNAL)\b/g, (m) => m[1]],
  // Config style: kind: "client"
  [/\bkind\s*[:=]\s*["'](client|server|producer|consumer|internal)["']/gi, (m) => m[1]],
]

function spanKindMarks(lines: string[]) {
  const marks: Array<{line: number; kind: SpanKind}> = []
  lines.forEach((text, i) => {
    for (const [rx, pick] of SPAN_KIND_PATTERNS) {
      for (const m of text.matchAll(rx)) marks.push({line: i + 1, kind: pick(m).toLowerCase() as SpanKind})
    }
  })
  return marks
}

// The nearest span kind stated before the usage (within 60 lines), otherwise
// the nearest one shortly after it (within 8 lines, for builder chains).
function nearestKind(marks: Array<{line: number; kind: SpanKind}>, line: number) {
  let best: {line: number; kind: SpanKind} | null = null
  for (const m of marks) {
    if (m.line <= line && line - m.line <= 60 && (!best || m.line > best.line)) best = m
  }
  if (best) return best
  for (const m of marks) {
    if (m.line > line && m.line - line <= 8 && (!best || m.line < best.line)) best = m
  }
  return best
}

const ATTRIBUTE_CALL = /attribute|setAttribute|set_attribute|WithAttributes|putAttribute|SetTag|setTag/i

const STRING_LITERAL = /(["'`])([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)\1/g

// Constant spellings used by the official SDKs.
const CONSTANT_PATTERNS: Array<{rx: RegExp; strip: (s: string) => string}> = [
  // JS/TS: ATTR_DB_SYSTEM, SEMATTRS_DB_SYSTEM, SEMRESATTRS_SERVICE_NAME, DBSYSTEMVALUES_REDIS is an enum value
  {rx: /\b(?:ATTR|SEMATTRS|SEMRESATTRS)_([A-Z0-9_]+)\b/g, strip: (s) => s},
  // Java/Python classes: DbIncubatingAttributes.DB_SYSTEM, SpanAttributes.DB_SYSTEM
  {rx: /\b\w*(?:Attributes|Attrs)\.([A-Z][A-Z0-9_]+)\b/g, strip: (s) => s},
  // Go: semconv.DBSystemKey, semconv.HTTPRequestMethodKey, semconv.DBSystemRedis
  {rx: /\bsemconv\.([A-Z][A-Za-z0-9]+)\b/g, strip: (s) => s.replace(/Key$/, '')},
]

function resolveConstant(name: string, index: KeyIndex): {key: string; form: Usage['form']} | null {
  const n = norm(name)
  const exact = index.byNorm.get(n)
  if (exact?.length === 1) return {key: exact[0], form: 'constant'}
  // Enum value constants: DBSystemRedis -> db.system + "redis"
  for (let cut = n.length - 1; cut > 2; cut--) {
    const keys = index.byNorm.get(n.slice(0, cut))
    if (keys?.length !== 1) continue
    const rest = n.slice(cut)
    const info = index.byKey.get(keys[0])
    if (info?.members?.some((m) => norm(m) === rest)) return {key: keys[0], form: 'enum-constant'}
  }
  return null
}

const VERSION_PATTERNS: RegExp[] = [
  /go\.opentelemetry\.io\/otel\/semconv\/v(\d+\.\d+\.\d+)/,
  /["']@opentelemetry\/semantic-conventions["']\s*:\s*["'][\^~]?(\d+\.\d+\.\d+)["']/,
  /io\.opentelemetry\.semconv:opentelemetry-semconv(?:-incubating)?:(\d+\.\d+\.\d+)/,
]

// Lines that belong to import statements. A constant named in an import is a
// declaration of intent, not a usage, so it is not reported.
function importLines(lines: string[]) {
  const out = new Set<number>()
  let open = false
  lines.forEach((text, i) => {
    const t = text.trim()
    const starts = /^(import\b|from\s+[\w.]+\s+import\b)/.test(t)
    if (starts || open) {
      out.add(i + 1)
      const closes = /\bfrom\s+["'][^"']+["']/.test(t) || (/\)\s*$/.test(t) && !/\($/.test(t)) || (starts && !/[({]\s*$/.test(t))
      open = !closes
    }
  })
  return out
}

export function extract(code: string, index: KeyIndex): Extraction {
  const lines = code.split('\n')
  const marks = spanKindMarks(lines)
  const imports = importLines(lines)
  const usages: Usage[] = []
  const unknown: Extraction['unknown'] = []
  const seen = new Set<string>()
  let pinnedVersion: Extraction['pinnedVersion'] = null

  lines.forEach((text, i) => {
    const line = i + 1
    if (!pinnedVersion) {
      for (const rx of VERSION_PATTERNS) {
        const m = text.match(rx)
        if (m) {
          pinnedVersion = {version: `v${m[1]}`, line, text: text.trim()}
          break
        }
      }
    }

    const push = (key: string, column: number, raw: string, form: Usage['form']) => {
      const id = `${line}:${column}:${key}`
      if (seen.has(id)) return
      seen.add(id)
      const kind = nearestKind(marks, line)
      usages.push({key, line, column, text: raw, form, spanKind: kind?.kind ?? null, spanKindLine: kind?.line ?? null})
    }

    if (imports.has(line)) return
    for (const m of text.matchAll(STRING_LITERAL)) {
      if (index.byKey.has(m[2])) push(m[2], (m.index ?? 0) + 1, m[0], 'string')
      else if (ATTRIBUTE_CALL.test(text) && index.namespaces.has(m[2].split('.')[0]) && !unknown.some((u) => u.key === m[2])) {
        unknown.push({key: m[2], line, namespace: m[2].split('.')[0]})
      }
    }
    for (const {rx, strip} of CONSTANT_PATTERNS) {
      for (const m of text.matchAll(rx)) {
        const hit = resolveConstant(strip(m[1]), index)
        if (hit) push(hit.key, (m.index ?? 0) + 1, m[0], hit.form)
      }
    }
  })

  usages.sort((a, b) => a.line - b.line || a.column - b.column)
  return {usages, unknown, pinnedVersion, language: detectLanguage(code)}
}
