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
      options: {list: ['current', 'deprecated'], layout: 'radio'},
      validation: (r) => r.required(),
    }),
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
    defineField({name: 'deprecation', type: 'deprecation', group: 'deprecation', hidden: ({document}) => document?.status !== 'deprecated'}),
    defineField({name: 'source', type: 'sourceRef', group: 'source'}),
  ],
  orderings: [{title: 'Key', name: 'keyAsc', by: [{field: 'key', direction: 'asc'}]}],
  preview: {
    select: {key: 'key', status: 'status', verdict: 'deprecation.verdict', stability: 'stability'},
    prepare: ({key, status, verdict, stability}) => ({
      title: key,
      subtitle: status === 'deprecated' ? `deprecated · ${verdict}` : `current · ${stability}`,
    }),
  },
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
    defineField({name: 'deprecatedIn', title: 'First release that deprecates it', type: 'string'}),
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
