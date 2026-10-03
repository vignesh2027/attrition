// Creates or updates the two organization-level Context MCP endpoints that
// Attrition reads, the same objects the Context app in the Sanity Dashboard
// manages:
//   attrition     the dataset y9raau23.production, with instructions and a filter
//   attrition-kb  the Knowledge Base kbI5ncVyqDpc
// Uses the CLI login token, so run `npx sanity login` first.
import {readFileSync} from 'node:fs'
import {homedir} from 'node:os'
import {join} from 'node:path'

const ORG = 'oc2g3x7ee'
const API = `https://api.sanity.io/v1/context/organizations/${ORG}/mcp`
const {authToken} = JSON.parse(readFileSync(join(homedir(), '.config', 'sanity', 'config.json'), 'utf8'))
const headers = {Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json'}

const datasetInstructions = `
Three document types hold the OpenTelemetry semantic conventions, imported from every tagged release from v1.21.0 to the latest: attribute (span, log and resource attribute keys), metric (metric names, with instrument and unit) and event (event names). All three share the same fields: key, status, stability, introducedIn, deprecation, source. Look names up by exact key: *[_type in ["attribute", "metric", "event"] && key in $keys]. Never guess a key with text search when you already have the exact string.

status is "current", "deprecated" or "dropped". Dropped means the name existed in an older release and is gone from the latest with no deprecation entry; lastSeenIn is the last release that had it. The registry gives no replacement for dropped names, so say so and point to the attrition-kb migration guides.

deprecation.verdict is computed from the spec's own reason, renamed_to and note fields. Report the verdict as stored. Do not invent a replacement that is not in deprecation.replacements.

What each verdict means for the user:
- RENAMED or REPLACED: swap to replacements[0].key. If deprecation.valueChanges is true, the value must change format too (type, unit or string representation); say so. For metrics, deprecation.unitChange gives the old and new unit.
- SPAN_KIND_DEPENDENT: the replacement depends on the span kind. replacements[].when names the span kind it applies to. A kind with no entry has no replacement. If you do not know the span kind, ask; never pick one.
- SPLIT: set every key in replacements together.
- CONDITIONAL: read deprecation.note; the condition decides.
- MERGED_INTO: fold the value into replacements[0].key (for example a fully qualified name).
- USE_SIGNAL_FIELD: stop setting an attribute; the note names the field of the span or log record to use.
- MOVED_OUT: the name now lives in another repository, linked in deprecation.movedTo.url. It is not removed.
- REMOVED: delete it. There is no replacement.
- DROPPED: left the spec silently, see above.

Enum values can be deprecated on their own: attribute.members[] has deprecated (a note) and replacementValue.

specErratum on a document records an inconsistency in the upstream spec that the importer found. Mention it when relevant.

deprecation.deprecatedIn is the first release that deprecated the name and introducedIn is the first release that defined it. Use them to answer "was this already deprecated in the version I pin?".

Always cite source.url, which links to the exact line of the spec YAML at that release.
`.trim()

const endpoints = [
  {
    title: 'Attrition',
    name: 'attrition',
    instructions: datasetInstructions,
    groqFilter: '_type in ["attribute", "metric", "event", "namespace", "specRelease"]',
    sources: [{type: 'dataset', id: 'y9raau23.production'}],
  },
  {
    title: 'Attrition Knowledge Base',
    name: 'attrition-kb',
    instructions:
      'This Knowledge Base holds the official OpenTelemetry semantic convention migration guides and a slice of retired attributes and metrics. Use it for what changed beyond the name: behaviour, units, privacy notes and the OTEL_SEMCONV_STABILITY_OPT_IN dual-emit values. For the verdict and the replacement name, the attrition dataset endpoint is the source of truth. Several conflicts between the registry and the guides were resolved by a person; follow those standing instructions.',
    sources: [{type: 'knowledge-base', id: 'kbI5ncVyqDpc'}],
  },
]

for (const ep of endpoints) {
  // The update route takes the endpoint id; look it up by name first.
  const probe = await fetch(`${API}/${ep.name}`, {
    method: 'POST',
    headers: {...headers, Accept: 'application/json, text/event-stream'},
    body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/list'}),
  })
  const exists = probe.ok
  const existing = exists ? await findId(ep.name) : null
  const res = existing
    ? await fetch(`${API}/${existing}`, {method: 'PATCH', headers, body: JSON.stringify({title: ep.title, instructions: ep.instructions, groqFilter: ep.groqFilter ?? null, sources: ep.sources})})
    : await fetch(API, {method: 'POST', headers, body: JSON.stringify(ep)})
  const body = await res.json()
  console.log(res.ok ? `saved ${body.name} (${body.id})` : `failed ${ep.name}: ${body.message}`)
}

// Ids of the endpoints created for this project. The API lists none by name,
// so the ids are kept here after the first run.
async function findId(name) {
  return {attrition: 'mcp1h08jo4h', 'attrition-kb': 'mcp0yojnrh1'}[name] ?? null
}
