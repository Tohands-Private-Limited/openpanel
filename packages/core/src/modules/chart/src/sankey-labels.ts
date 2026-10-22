// Sankey node label-by rules: an event can be grouped by one of its
// event-level properties (e.g. `screen_view` by `path`) instead of its name.
// Kept apart from sankey.sql.ts so that file stays close to upstream.

import { type SqlFragment, sql } from '@openpanel/db/src/clickhouse/sql';
import {
  type ISankeyLabelRule,
  isEventLevelProperty,
} from '../../report/report.constants';
import { compiledText } from './compiled';
import {
  getSelectPropertyKey,
  isKnownEventField,
  isWildcardPropertyKey,
} from './field-resolution';

/**
 * The few places the session-path pipeline depends on what a path element is.
 * Without rules an element is the event name and sankey.sql.ts uses upstream's
 * text unchanged; with rules it is a `(name, label)` tuple, so anchors match on
 * the name (`.1`) while nodes, links and entries use the label (`.2`).
 */
export interface SankeyPathShape {
  orderedEventColumns: SqlFragment;
  dedupeConsecutive: SqlFragment;
  truncateAtRepeat: SqlFragment;
  transitionPairs: SqlFragment;
  /** Appended to the lambda argument of every anchor (start/end event) match. */
  anchorName: SqlFragment;
  /** Appended to a path element wherever its node label is read. */
  labelOf: SqlFragment;
}

const LABELLED_PATH_SHAPE = {
  dedupeConsecutive: compiledText(
    'arrayCompact(groupArray((name, label))) as events_deduped'
  ),
  truncateAtRepeat: compiledText(`if(
      arrayFirstIndex(x -> x > 1, arrayEnumerateUniq(arrayMap(t -> t.2, events_sliced))) = 0,
      events_sliced,
      arraySlice(
        events_sliced,
        1,
        arrayFirstIndex(x -> x > 1, arrayEnumerateUniq(arrayMap(t -> t.2, events_sliced))) - 1
      )
    )`),
  transitionPairs: compiledText(
    '(SELECT arrayJoin(arrayMap(i -> (events[i].2, events[i + 1].2, i), range(1, length(events)))) as pair FROM session_paths WHERE length(events) >= 2)'
  ),
  anchorName: compiledText('.1'),
  labelOf: compiledText('.2'),
};

/**
 * A rule only reaches SQL for a known, scalar, event-level field: the flow
 * query has no profile/group join, `getSelectPropertyKey` inlines an unknown
 * name as an identifier, and `getUserFlowCore` callers skip the zod refine.
 */
function isApplicableLabelRule(rule: ISankeyLabelRule): boolean {
  return (
    rule.event !== '' &&
    rule.property !== '' &&
    isEventLevelProperty(rule.property) &&
    isKnownEventField(rule.property) &&
    !isWildcardPropertyKey(rule.property)
  );
}

/**
 * Each event's node label: its rule's property value, else its name. An empty
 * value falls back to the name so no node renders blank.
 */
export function buildSankeyLabelExpr(labelBy: ISankeyLabelRule[]): SqlFragment {
  const branches = labelBy.filter(isApplicableLabelRule).map((rule) => {
    const value = sql`toString(${getSelectPropertyKey(rule.property)})`;
    return sql`name = ${sql.string(rule.event)}, ifNull(nullIf(${value}, ''), name)`;
  });
  if (branches.length === 0) {
    return sql`name`;
  }
  return sql`multiIf(${sql.join(branches)}, name)`;
}

/**
 * `null` unless a rule applies: the tuple pipeline costs a second string per
 * path element, which a flow without rules should not pay.
 */
export function sankeyLabelledPathShape(
  labelBy: ISankeyLabelRule[] = []
): SankeyPathShape | null {
  if (!labelBy.some(isApplicableLabelRule)) {
    return null;
  }
  return {
    ...LABELLED_PATH_SHAPE,
    orderedEventColumns: sql`name, ${buildSankeyLabelExpr(labelBy)} as label`,
  };
}
