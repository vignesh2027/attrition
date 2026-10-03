import type {StructureResolver} from 'sanity/structure'
import {CONTEXT_SCHEMA_TYPE_NAME} from '@sanity/context/studio'
import {VERDICTS} from './schemaTypes/attribute'

export const structure: StructureResolver = (S) =>
  S.list()
    .title('Attrition')
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
                      .filter('_type in ["attribute", "metric", "event"] && deprecation.verdict == $v')
                      .params({v: value})
                      .defaultOrdering([{field: 'key', direction: 'asc'}]),
                  ),
              ),
            ),
        ),
      S.listItem()
        .title('Dropped without notice')
        .child(
          S.documentList()
            .title('Left the spec with no deprecation entry')
            .filter('_type in ["attribute", "metric", "event"] && status == "dropped"')
            .defaultOrdering([{field: 'key', direction: 'asc'}]),
        ),
      S.listItem()
        .title('Metrics with a unit change')
        .child(
          S.documentList()
            .title('Renamed and the unit changed')
            .filter('_type == "metric" && defined(deprecation.unitChange)')
            .defaultOrdering([{field: 'key', direction: 'asc'}]),
        ),
      S.listItem()
        .title('Spec errata')
        .child(S.documentList().title('Upstream inconsistencies').filter('defined(specErratum)')),
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
      S.documentTypeListItem('metric').title('All metrics'),
      S.documentTypeListItem('event').title('All events'),
      S.documentTypeListItem('namespace').title('Namespaces'),
      S.documentTypeListItem('specRelease').title('Spec releases scanned'),
      S.divider(),
      S.documentTypeListItem(CONTEXT_SCHEMA_TYPE_NAME).title('Agent Context'),
    ])
