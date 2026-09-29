import {defineField, defineType} from 'sanity'
import {attribute, deprecation, externalLink, replacement, sourceRef} from './attribute'

export const namespace = defineType({
  name: 'namespace',
  type: 'document',
  fields: [
    defineField({name: 'name', type: 'string', validation: (r) => r.required()}),
    defineField({name: 'attributeCount', type: 'number', readOnly: true}),
  ],
  preview: {
    select: {title: 'name', count: 'attributeCount'},
    prepare: ({title, count}) => ({title, subtitle: `${count} attributes`}),
  },
})

export const specRelease = defineType({
  name: 'specRelease',
  title: 'Spec release',
  type: 'document',
  fields: [
    defineField({name: 'tag', type: 'string'}),
    defineField({name: 'repository', type: 'url'}),
    defineField({
      name: 'releasesScanned',
      type: 'array',
      of: [
        {
          type: 'object',
          name: 'releaseStat',
          fields: [
            {name: 'tag', type: 'string'},
            {name: 'attributes', type: 'number'},
            {name: 'deprecated', type: 'number'},
          ],
          preview: {
            select: {title: 'tag', a: 'attributes', d: 'deprecated'},
            prepare: ({title, a, d}: {title?: string; a?: number; d?: number}) => ({title, subtitle: `${a} attributes, ${d} deprecated`}),
          },
        },
      ],
    }),
  ],
})

export const schemaTypes = [attribute, deprecation, replacement, sourceRef, externalLink, namespace, specRelease]
