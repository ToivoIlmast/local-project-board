import { useState, type FormEvent } from 'react';
import type { Task } from '../../../../contract/v1/index';
import { Button, Field, Input, Select, Textarea } from '../../../shared/ui/index';

export interface TaskValues {
  title: string;
  status: string;
  labels: string[];
  branch?: string | undefined;
  body: string;
}

export interface TaskFormProps {
  statuses: string[];
  task?: Task | undefined;
  defaultStatus?: string | undefined;
  submitLabel: string;
  pending: boolean;
  error: string | undefined;
  onSubmit: (values: TaskValues) => void;
  onCancel: () => void;
}

/** One form for creating and for changing a task: the same fields either way. */
export function TaskForm({
  statuses,
  task,
  defaultStatus,
  submitLabel,
  pending,
  error,
  onSubmit,
  onCancel,
}: TaskFormProps) {
  const [title, setTitle] = useState(task?.title ?? '');
  const [status, setStatus] = useState(task?.status ?? defaultStatus ?? statuses[0] ?? '');
  const [labels, setLabels] = useState((task?.labels ?? []).join(', '));
  const [branch, setBranch] = useState(task?.branch ?? '');
  const [body, setBody] = useState(task?.body ?? '');

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
    });
  };

  return (
    <form className="form" onSubmit={submit}>
      <Field label="Title">
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
      <Field label="Status">
        {(id) => (
          <Select
            id={id}
            options={statuses}
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          />
        )}
      </Field>
      <Field label="Labels" hint="Separated by commas">
        {(id) => (
          <Input
            id={id}
            value={labels}
            autoComplete="off"
            onChange={(event) => setLabels(event.target.value)}
          />
        )}
      </Field>
      <Field label="Branch" hint="A note, not a checkout">
        {(id) => (
          <Input
            id={id}
            value={branch}
            autoComplete="off"
            onChange={(event) => setBranch(event.target.value)}
          />
        )}
      </Field>
      <Field label="Description" hint="Markdown">
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
        <Button onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={pending || title.trim() === ''}>
          {pending ? 'Saving…' : submitLabel}
        </Button>
      </div>
    </form>
  );
}
