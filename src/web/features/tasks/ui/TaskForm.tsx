import { useState, type FormEvent } from 'react';
import type { Task } from '../../../../contract/v1/index';
import { useBoard } from '../../../api/react';
import { useStatusLabel, useT } from '../../../shared/i18n/index';
import {
  Button,
  Field,
  Input,
  Select,
  Textarea,
  type SelectOption,
} from '../../../shared/ui/index';
import {
  blockOptions,
  parseDependsOn,
  type FieldErrors,
  type PlacementField,
} from '../model/placement';
import { useTaskT } from '../i18n/details';

export interface TaskValues {
  title: string;
  status: string;
  labels: string[];
  branch?: string | undefined;
  body: string;
  /** Where the task is placed and what it waits for; empty is not set. */
  topic?: string | undefined;
  block?: string | undefined;
  dependsOn?: string[] | undefined;
}

export interface TaskFormProps {
  statuses: string[];
  task?: Task | undefined;
  /** What the form starts with instead of the task's own: a draft, or the one being kept. */
  initial?: Partial<TaskValues> | undefined;
  defaultStatus?: string | undefined;
  submitLabel: string;
  pending: boolean;
  error: string | undefined;
  /** What the board refused in the fields of the place, each said at its own field. */
  fieldErrors?: FieldErrors | undefined;
  /** A field the board refused was changed: what it said of it no longer holds. */
  onFieldEdited?: ((field: PlacementField) => void) | undefined;
  onSubmit: (values: TaskValues) => void;
  onCancel: () => void;
}

/** A value the board no longer has is still the person's entry: it stays, and is said so. */
function withStale(options: SelectOption[], value: string, label: string): SelectOption[] {
  if (
    value === '' ||
    options.some((option) => typeof option !== 'string' && option.value === value)
  ) {
    return options;
  }
  return [...options, { value, label }];
}

/** One form for creating and for changing a task: the same fields either way. */
export function TaskForm({
  statuses,
  task,
  initial,
  defaultStatus,
  submitLabel,
  pending,
  error,
  fieldErrors,
  onFieldEdited,
  onSubmit,
  onCancel,
}: TaskFormProps) {
  const { state } = useBoard();
  const t = useTaskT();
  const common = useT();
  const statusLabel = useStatusLabel();
  const [title, setTitle] = useState(initial?.title ?? task?.title ?? '');
  const [status, setStatus] = useState(
    initial?.status ?? task?.status ?? defaultStatus ?? statuses[0] ?? '',
  );
  const [labels, setLabels] = useState((initial?.labels ?? task?.labels ?? []).join(', '));
  const [branch, setBranch] = useState(
    initial !== undefined && 'branch' in initial ? (initial.branch ?? '') : (task?.branch ?? ''),
  );
  const [body, setBody] = useState(initial?.body ?? task?.body ?? '');
  const [topic, setTopic] = useState(
    initial !== undefined && 'topic' in initial ? (initial.topic ?? '') : (task?.topic ?? ''),
  );
  const [block, setBlock] = useState(
    initial !== undefined && 'block' in initial ? (initial.block ?? '') : (task?.block ?? ''),
  );
  const [dependsOn, setDependsOn] = useState(
    (initial !== undefined && 'dependsOn' in initial
      ? (initial.dependsOn ?? [])
      : (task?.dependsOn ?? [])
    ).join(', '),
  );

  const blocks = blockOptions(state.topics, topic === '' ? undefined : topic);
  const topicChoices = withStale(
    [
      { value: '', label: t('form.noTopic') },
      ...state.topics.map((held) => ({ value: held.id, label: `${held.id} · ${held.title}` })),
    ],
    topic,
    t('form.topicStale', { topic }),
  );
  const blockChoices = withStale(
    [
      { value: '', label: t('form.noBlock') },
      ...blocks.map((held) => ({ value: held.id, label: `${held.id} · ${held.title}` })),
    ],
    block,
    t('form.blockStale', { block }),
  );

  const changeTopic = (next: string): void => {
    setTopic(next);
    onFieldEdited?.('topic');
    // A block of another topic is not carried over.
    if (
      !blockOptions(state.topics, next === '' ? undefined : next).some((held) => held.id === block)
    ) {
      setBlock('');
    }
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    onSubmit({
      title: title.trim(),
      status,
      labels: labels
        .split(',')
        .map((label) => label.trim())
        .filter((label) => label !== ''),
      branch: branch.trim() === '' ? undefined : branch.trim(),
      body,
      topic: topic === '' ? undefined : topic,
      block: topic === '' || block === '' ? undefined : block,
      dependsOn: parseDependsOn(dependsOn),
    });
  };

  return (
    <form className="form" onSubmit={submit}>
      <Field label={t('field.title')}>
        {(id) => (
          <Input
            id={id}
            value={title}
            required
            autoComplete="off"
            onChange={(event) => setTitle(event.target.value)}
          />
        )}
      </Field>
      <Field label={t('field.status')}>
        {(id) => (
          <Select
            id={id}
            options={statuses.map((value) => ({ value, label: statusLabel(value) }))}
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          />
        )}
      </Field>
      <Field label={t('field.topic')} error={fieldErrors?.topic}>
        {(id, describedBy) => (
          <Select
            id={id}
            aria-describedby={describedBy}
            aria-invalid={fieldErrors?.topic !== undefined}
            options={topicChoices}
            value={topic}
            onChange={(event) => changeTopic(event.target.value)}
          />
        )}
      </Field>
      <Field
        label={t('field.block')}
        hint={topic === '' ? t('form.blockHint') : undefined}
        error={fieldErrors?.block}
      >
        {(id, describedBy) => (
          <Select
            id={id}
            aria-describedby={describedBy}
            aria-invalid={fieldErrors?.block !== undefined}
            options={blockChoices}
            value={block}
            disabled={topic === ''}
            onChange={(event) => {
              setBlock(event.target.value);
              onFieldEdited?.('block');
            }}
          />
        )}
      </Field>
      <Field
        label={t('field.dependsOn')}
        hint={t('form.dependsHint')}
        error={fieldErrors?.dependsOn}
      >
        {(id, describedBy) => (
          <Input
            id={id}
            aria-describedby={describedBy}
            aria-invalid={fieldErrors?.dependsOn !== undefined}
            value={dependsOn}
            autoComplete="off"
            onChange={(event) => {
              setDependsOn(event.target.value);
              onFieldEdited?.('dependsOn');
            }}
          />
        )}
      </Field>
      <Field label={t('field.labels')} hint={t('form.labelsHint')}>
        {(id) => (
          <Input
            id={id}
            value={labels}
            autoComplete="off"
            onChange={(event) => setLabels(event.target.value)}
          />
        )}
      </Field>
      <Field label={t('field.branch')} hint={t('form.branchHint')}>
        {(id) => (
          <Input
            id={id}
            value={branch}
            autoComplete="off"
            onChange={(event) => setBranch(event.target.value)}
          />
        )}
      </Field>
      <Field label={t('field.description')} hint={t('form.descriptionHint')}>
        {(id) => (
          <Textarea
            id={id}
            rows={8}
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />
        )}
      </Field>

      {error === undefined ? null : (
        <p className="form__error" role="alert">
          {error}
        </p>
      )}
      <div className="form__actions">
        <Button onClick={onCancel}>{common('ui.cancel')}</Button>
        <Button type="submit" variant="primary" disabled={pending || title.trim() === ''}>
          {pending ? common('ui.saving') : submitLabel}
        </Button>
      </div>
    </form>
  );
}
