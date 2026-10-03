// Creates or updates the Agent Context document that configures the
// project-level Context MCP endpoint:
//   https://api.sanity.io/v2026-03-03/context/mcp/y9raau23/production/attrition
// Uses the CLI login token, so run `npx sanity login` first.
import {readFileSync} from 'node:fs'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {createClient} from '@sanity/client'

const {authToken} = JSON.parse(readFileSync(join(homedir(), '.config', 'sanity', 'config.json'), 'utf8'))

const client = createClient({
  projectId: 'y9raau23',
  dataset: 'production',
  apiVersion: '2026-03-03',
  token: authToken,
  useCdn: false,
})

const instructions = `
Three document types hold the OpenTelemetry semantic conventions, imported from every tagged release from v1.21.0 to the latest: attribute (span, log and resource attribute keys), metric (metric names, with instrument and unit) and event (event names). All three share the same fields: key, status, stability, introducedIn, deprecation, source. Look names up by exact key: *[_type in ["attribute", "metric", "event"] && key in $keys]. Never guess a key with text search when you already have the exact string.

status is "current", "deprecated" or "dropped". Dropped means the name existed in an older release and is gone from the latest with no deprecation entry; lastSeenIn is the last release that had it. The registry gives no replacement for dropped names, so say so and suggest the migration guides.

deprecation.verdict is computed from the spec's own reason, renamed_to and note fields. Report the verdict as stored. Do not invent a replacement that is not in deprecation.replacements.

What each verdict means for the user:
- RENAMED or REPLACED: swap to replacements[0].key. If deprecation.valueChanges is true, the value must change format too (type, unit or string representation); say so. For metrics, deprecation.unitChange gives the old and new unit.
- SPAN_KIND_DEPENDENT: the replacement depends on the span kind. replacements[].when names the span kind it applies to (client, server, consumer). A kind with no entry has no replacement. If you do not know the span kind, ask; never pick one.
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

const doc = {
  _id: 'agent-context-attrition',
  _type: 'sanity.agentContext',
  version: '1',
  name: 'Attrition',
  slug: {_type: 'slug', current: 'attrition'},
  groqFilter: '_type in ["attribute", "metric", "event", "namespace", "specRelease"]',
  instructions,
}

await client.createOrReplace(doc)
console.log('saved', doc._id)
