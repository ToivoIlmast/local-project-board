import type { Topic } from '../../../../contract/v1/index';
import { useBoardT } from '../i18n';
import { Field, Select, type SelectOption } from '../../../shared/ui/index';
import { NO_TOPIC } from '../model/filterByTopic';

export interface TopicFilterProps {
  topics: Topic[];
  /** The value in the address bar: none for All, `none`, or a topic id. */
  value: string | null;
  onChange: (value: string | null) => void;
}

/** Which tasks the board shows: all of them, those with no topic, or those of one topic. */
export function TopicFilter({ topics, value, onChange }: TopicFilterProps) {
  const t = useBoardT();
  const options: SelectOption[] = [
    { value: '', label: t('filter.all') },
    { value: NO_TOPIC, label: t('filter.none') },
    ...topics.map((topic) => ({ value: topic.id, label: `${topic.id} · ${topic.title}` })),
  ];
  // A value the board does not have is still what is selected: the select must say so, not
  // quietly show All above an empty board. The page explains it in a notice.
  if (
    value !== null &&
    !options.some((option) => typeof option !== 'string' && option.value === value)
  ) {
    options.push({ value, label: t('filter.missing', { id: value }), disabled: true });
  }

  return (
    <section className="board-filter" aria-label={t('filter.label')}>
      <Field label={t('filter.topic')}>
        {(id) => (
          <Select
            id={id}
            options={options}
            value={value ?? ''}
            onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
          />
        )}
      </Field>
    </section>
  );
}
