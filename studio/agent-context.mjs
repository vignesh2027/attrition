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
Every attribute document is one OpenTelemetry semantic convention attribute, imported from the latest tagged release of open-telemetry/semantic-conventions. Look attributes up by their exact key: *[_type == "attribute" && key in $keys]. Never guess a key with text search when you already have the exact string.

A deprecated attribute has status "deprecated" and a deprecation object. deprecation.verdict is computed from the spec's own reason, renamed_to and note fields. Report the verdict as stored. Do not invent a replacement that is not in deprecation.replacements.

What each verdict means for the user:
- RENAMED or REPLACED: swap to replacements[0].key everywhere.
- SPAN_KIND_DEPENDENT: the replacement depends on the span kind. replacements[].when says "client spans" or "server spans". If you do not know the span kind, ask; never pick one.
- SPLIT: set every key in replacements together.
- CONDITIONAL: read deprecation.note; the condition decides.
- MERGED_INTO: fold the value into replacements[0].key (for example a fully qualified name).
- USE_SIGNAL_FIELD: stop setting an attribute; the note names the field of the span or log record to use.
- MOVED_OUT: the attribute now lives in another repository, linked in deprecation.movedTo.url. It is not removed.
- REMOVED: delete it. There is no replacement.

deprecation.deprecatedIn is the first release that deprecated the key and introducedIn is the first release that defined it, scanned from every release since v1.21.0. Use them to answer "was this already deprecated in the version I pin?".

Always cite source.url, which links to the exact line of the spec YAML at that release.
`.trim()

const doc = {
  _id: 'agent-context-attrition',
  _type: 'sanity.agentContext',
  version: '1',
  name: 'Attrition',
  slug: {_type: 'slug', current: 'attrition'},
  groqFilter: '_type in ["attribute", "namespace", "specRelease"]',
  instructions,
}

await client.createOrReplace(doc)
console.log('saved', doc._id)
