import type { IChartEvent, ISankeyLabelRule } from '@openpanel/validation';
import { PlusIcon, XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ComboboxEvents } from '@/components/ui/combobox-events';
import { useAppParams } from '@/hooks/use-app-params';
import { useEventNames } from '@/hooks/use-event-names';
import { useDispatch } from '@/redux';
import { changeSankeyLabelBy } from '../reportSlice';
import { PropertiesCombobox } from './PropertiesCombobox';

interface SankeyLabelByProps {
  value: ISankeyLabelRule[];
}

/**
 * Editor for the Sankey "Node label" rules: relabel specific events by one of
 * their event-level properties (e.g. `screen_view` → its `path`) so the flow
 * fans out into per-screen nodes. Events without a rule keep their event name.
 */
export function SankeyLabelBy({ value }: SankeyLabelByProps) {
  const dispatch = useDispatch();
  const { projectId } = useAppParams();
  const eventNames = useEventNames({ projectId });

  const setRules = (rules: ISankeyLabelRule[]) => {
    dispatch(changeSankeyLabelBy(rules));
  };

  const updateRule = (index: number, patch: Partial<ISankeyLabelRule>) => {
    setRules(
      value.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)),
    );
  };

  const removeRule = (index: number) => {
    setRules(value.filter((_, i) => i !== index));
  };

  const addRule = () => {
    setRules([...value, { event: '', property: '' }]);
  };

  // Content-based keys (with an occurrence counter so duplicate/empty rows stay
  // distinct) instead of the array index.
  const seen = new Map<string, number>();
  const rows = value.map((rule) => {
    const base = `${rule.event}|${rule.property}`;
    const occurrence = seen.get(base) ?? 0;
    seen.set(base, occurrence + 1);
    return { rule, key: `${base}#${occurrence}` };
  });

  return (
    <div className="col gap-2">
      {rows.map(({ rule, key }, index) => (
        <div className="row items-center gap-2" key={key}>
          <ComboboxEvents<string>
            align="start"
            className="flex-1"
            items={eventNames.filter((item) => item.name !== '*')}
            onChange={(event) => updateRule(index, { event })}
            placeholder="Event"
            searchable
            value={rule.event || null}
          />
          <span className="whitespace-nowrap text-muted-foreground text-sm">
            by
          </span>
          <PropertiesCombobox
            categories={['event']}
            event={{ name: rule.event } as IChartEvent}
            onSelect={(action) => updateRule(index, { property: action.value })}
          >
            {(setOpen) => (
              <Button
                className="flex-1 justify-start"
                onClick={() => setOpen(true)}
                size="sm"
                variant="outline"
              >
                {rule.property || 'Select property'}
              </Button>
            )}
          </PropertiesCombobox>
          <Button
            aria-label="Remove label rule"
            onClick={() => removeRule(index)}
            size="icon"
            variant="ghost"
          >
            <XIcon className="size-4" />
          </Button>
        </div>
      ))}
      <Button
        className="self-start"
        onClick={addRule}
        size="sm"
        variant="outline"
      >
        <PlusIcon className="size-4" />
        Add label rule
      </Button>
    </div>
  );
}
