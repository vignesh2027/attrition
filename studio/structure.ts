import type {StructureResolver} from 'sanity/structure'
import {CONTEXT_SCHEMA_TYPE_NAME} from '@sanity/context/studio'
import {VERDICTS} from './schemaTypes/attribute'

export const structure: StructureResolver = (S) =>
  S.list()
    .title('Semconv Sentinel')
    .items([
      S.listItem()
        .title('Deprecated, by verdict')
        .child(
          S.list()
            .title('Verdict')
            .items(
              VERDICTS.map(({title, value}) =>
                S.listItem()
                  .id(value)
                  .title(title)
                  .child(
                    S.documentList()
                      .title(title)
                      .filter('_type == "attribute" && deprecation.verdict == $v')
                      .params({v: value})
                      .defaultOrdering([{field: 'key', direction: 'asc'}]),
                  ),
              ),
            ),
        ),
      S.listItem()
        .title('Current attributes')
        .child(
          S.documentList()
            .title('Current')
            .filter('_type == "attribute" && status == "current"')
            .defaultOrdering([{field: 'key', direction: 'asc'}]),
        ),
      S.divider(),
      S.documentTypeListItem('attribute').title('All attributes'),
      S.documentTypeListItem('namespace').title('Namespaces'),
      S.documentTypeListItem('specRelease').title('Spec releases scanned'),
      S.divider(),
      S.documentTypeListItem(CONTEXT_SCHEMA_TYPE_NAME).title('Agent Context'),
    ])
