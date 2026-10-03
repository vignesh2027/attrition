import {defineArrayMember, defineField, defineType} from 'sanity'

export const VERDICTS = [
  {title: 'Renamed: one new key, always', value: 'RENAMED'},
  {title: 'Replaced: one new key, reason not given as a rename', value: 'REPLACED'},
  {title: 'Depends on span kind (client vs server)', value: 'SPAN_KIND_DEPENDENT'},
  {title: 'Split into several keys, set together', value: 'SPLIT'},
  {title: 'Conditional: replacement depends on a stated condition', value: 'CONDITIONAL'},
  {title: 'Merged into another key', value: 'MERGED_INTO'},
  {title: 'Use a field of the signal instead of an attribute', value: 'USE_SIGNAL_FIELD'},
  {title: 'Moved out of this repository', value: 'MOVED_OUT'},
  {title: 'Removed, no replacement', value: 'REMOVED'},
  {title: 'Dropped: left the spec with no deprecation entry', value: 'DROPPED'},
  {title: 'Needs human review', value: 'NEEDS_REVIEW'},
]

export const attribute = defineType({
  name: 'attribute',
  title: 'Attribute',
  type: 'document',
  groups: [
    {name: 'spec', title: 'Spec', default: true},
    {name: 'deprecation', title: 'Deprecation'},
    {name: 'source', title: 'Source'},
  ],
  fields: [
    defineField({
      name: 'key',
      title: 'Attribute key',
      type: 'string',
      group: 'spec',
      description: 'The exact string instrumentation sets, for example db.system.name',
      validation: (r) => r.required(),
    }),
    defineField({name: 'namespace', type: 'reference', to: [{type: 'namespace'}], group: 'spec'}),
    defineField({
      name: 'status',
      type: 'string',
      group: 'spec',
      options: {list: ['current', 'deprecated', 'dropped'], layout: 'radio'},
      description: 'dropped: present in an older release, absent from the latest, with no deprecation entry',
      validation: (r) => r.required(),
    }),
    defineField({name: 'lastSeenIn', title: 'Last release that defines it', type: 'string', group: 'spec', hidden: ({document}) => document?.status !== 'dropped'}),
    defineField({
      name: 'stability',
      type: 'string',
      group: 'spec',
      options: {list: ['stable', 'release_candidate', 'development', 'alpha', 'beta', 'unspecified']},
    }),
    defineField({name: 'type', title: 'Value type', type: 'string', group: 'spec'}),
    defineField({name: 'brief', type: 'text', rows: 2, group: 'spec'}),
    defineField({name: 'note', type: 'text', rows: 4, group: 'spec'}),
    defineField({name: 'examples', type: 'array', of: [{type: 'string'}], group: 'spec'}),
    defineField({
      name: 'members',
      title: 'Enum members',
      type: 'array',
      group: 'spec',
      of: [
        defineArrayMember({
          type: 'object',
          name: 'enumMember',
          fields: [
            {name: 'id', type: 'string'},
            {name: 'value', type: 'string'},
            {name: 'brief', type: 'text', rows: 2},
            {name: 'stability', type: 'string'},
            {name: 'deprecated', type: 'string', description: 'Deprecation note, if this value is deprecated'},
            {name: 'replacementValue', type: 'string', description: 'The value to send instead, when the spec renamed it'},
          ],
          preview: {select: {title: 'value', subtitle: 'deprecated'}},
        }),
      ],
    }),
    defineField({
      name: 'introducedIn',
      title: 'First release that defines it',
      type: 'string',
      group: 'spec',
      description: 'Scanned from every tagged release since v1.21.0',
    }),
    defineField({name: 'deprecation', type: 'deprecation', group: 'deprecation', hidden: ({document}) => document?.status === 'current'}),
    defineField({name: 'source', type: 'sourceRef', group: 'source'}),
  ],
  orderings: [{title: 'Key', name: 'keyAsc', by: [{field: 'key', direction: 'asc'}]}],
  preview: {
    select: {key: 'key', status: 'status', verdict: 'deprecation.verdict', stability: 'stability'},
    prepare: ({key, status, verdict, stability}) => ({
      title: key,
      subtitle: status === 'current' ? `current · ${stability}` : `${status} · ${verdict}`,
    }),
  },
})

// Metrics and events share the attribute model: a wire name, a status and the
// same deprecation object, so one verdict vocabulary covers every signal.
const signalFields = (kind: 'metric' | 'event') => [
  defineField({name: 'key', title: kind === 'metric' ? 'Metric name' : 'Event name', type: 'string', group: 'spec', validation: (r) => r.required()}),
  defineField({name: 'namespace', type: 'string', group: 'spec'}),
  defineField({name: 'status', type: 'string', group: 'spec', options: {list: ['current', 'deprecated', 'dropped'], layout: 'radio'}}),
  defineField({name: 'stability', type: 'string', group: 'spec'}),
  defineField({name: 'brief', type: 'text', rows: 2, group: 'spec'}),
  ...(kind === 'metric'
    ? [
        defineField({name: 'instrument', type: 'string', group: 'spec', options: {list: ['counter', 'updowncounter', 'histogram', 'gauge']}}),
        defineField({name: 'unit', type: 'string', group: 'spec', description: 'UCUM unit, for example s, ms, By'}),
      ]
    : []),
  defineField({name: 'introducedIn', title: 'First release that defines it', type: 'string', group: 'spec'}),
  defineField({name: 'lastSeenIn', title: 'Last release that defines it', type: 'string', group: 'spec', hidden: ({document}) => document?.status !== 'dropped'}),
  defineField({
    name: 'specErratum',
    title: 'Known spec erratum',
    type: 'text',
    rows: 2,
    group: 'spec',
    description: 'An inconsistency in the upstream spec that the importer found and documented',
  }),
  defineField({name: 'deprecation', type: 'deprecation', group: 'deprecation', hidden: ({document}) => document?.status === 'current'}),
  defineField({name: 'source', type: 'sourceRef', group: 'source'}),
]

const signalPreview = {
  select: {key: 'key', status: 'status', verdict: 'deprecation.verdict', unit: 'unit'},
  prepare: ({key, status, verdict, unit}: {key?: string; status?: string; verdict?: string; unit?: string}) => ({
    title: key,
    subtitle: [status === 'current' ? 'current' : `${status} · ${verdict}`, unit].filter(Boolean).join(' · '),
  }),
}

const signalGroups = [
  {name: 'spec', title: 'Spec', default: true},
  {name: 'deprecation', title: 'Deprecation'},
  {name: 'source', title: 'Source'},
]

export const metric = defineType({
  name: 'metric',
  title: 'Metric',
  type: 'document',
  groups: signalGroups,
  fields: signalFields('metric'),
  orderings: [{title: 'Name', name: 'keyAsc', by: [{field: 'key', direction: 'asc'}]}],
  preview: signalPreview,
})

export const event = defineType({
  name: 'event',
  title: 'Event',
  type: 'document',
  groups: signalGroups,
  fields: signalFields('event'),
  orderings: [{title: 'Name', name: 'keyAsc', by: [{field: 'key', direction: 'asc'}]}],
  preview: signalPreview,
})

export const deprecation = defineType({
  name: 'deprecation',
  type: 'object',
  fields: [
    defineField({
      name: 'verdict',
      type: 'string',
      description: 'Computed by scripts/build-dataset.mjs from reason, renamed_to and note. The agent reports this; it never invents one.',
      options: {list: VERDICTS},
      validation: (r) => r.required(),
    }),
    defineField({name: 'reason', title: 'Reason given by the spec', type: 'string', options: {list: ['renamed', 'obsoleted', 'uncategorized', 'unspecified']}}),
    defineField({name: 'note', type: 'text', rows: 3}),
    defineField({
      name: 'deprecatedIn',
      title: 'First release that deprecates it',
      type: 'string',
      description: 'For DROPPED names, the first release without them',
    }),
    defineField({
      name: 'unitChange',
      type: 'object',
      description: 'Metrics only: the replacement uses a different unit, found by comparing the two metric documents',
      fields: [
        {name: 'from', type: 'string'},
        {name: 'to', type: 'string'},
      ],
    }),
    defineField({
      name: 'valueChanges',
      title: 'Value format changes too',
      type: 'boolean',
      description: 'The replacement expects a different type, unit or string representation, so a key swap alone is wrong.',
    }),
    defineField({
      name: 'replacements',
      type: 'array',
      of: [defineArrayMember({type: 'replacement'})],
    }),
    defineField({name: 'finalReplacement', type: 'reference', to: [{type: 'attribute'}], weak: true, description: 'End of a rename chain'}),
    defineField({name: 'renameChain', type: 'array', of: [{type: 'string'}]}),
    defineField({name: 'movedTo', type: 'externalLink'}),
  ],
})

export const replacement = defineType({
  name: 'replacement',
  type: 'object',
  fields: [
    defineField({name: 'key', title: 'Replacement key', type: 'string', validation: (r) => r.required()}),
    defineField({
      name: 'when',
      title: 'Applies when',
      type: 'string',
      description: 'always, client spans, server spans, together, condition in note, combine the value, related',
    }),
    defineField({name: 'attribute', type: 'reference', to: [{type: 'attribute'}], weak: true}),
    defineField({name: 'metric', type: 'reference', to: [{type: 'metric'}], weak: true}),
  ],
  preview: {select: {title: 'key', subtitle: 'when'}},
})

export const sourceRef = defineType({
  name: 'sourceRef',
  title: 'Source',
  type: 'object',
  fields: [
    defineField({name: 'release', type: 'string'}),
    defineField({name: 'file', type: 'string'}),
    defineField({name: 'line', type: 'number'}),
    defineField({name: 'url', type: 'url'}),
  ],
})

export const externalLink = defineType({
  name: 'externalLink',
  type: 'object',
  fields: [
    defineField({name: 'label', type: 'string'}),
    defineField({name: 'url', type: 'url'}),
  ],
})
