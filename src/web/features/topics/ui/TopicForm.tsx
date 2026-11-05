import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Topic } from '../../../../contract/v1/index';
import { useAsyncAction } from '../../../shared/hooks/useAsyncAction';
import { useUnsavedChanges } from '../../../shared/hooks/unsavedChanges';
import { Button, Field, Input, Textarea } from '../../../shared/ui/index';

export interface TopicFormProps {
  /** The topic being changed; none when a new one is made. */
  topic?: Topic | undefined;
  /** Resolves when the board took it, rejects with the board's own message. */
  onSave: (values: { title: string; body: string }) => Promise<unknown>;
  onDone: () => void;
}

/** One form for making a topic and for changing its title and description. */
export function TopicForm({ topic, onSave, onDone }: TopicFormProps) {
  const [title, setTitle] = useState(topic?.title ?? '');
  const [body, setBody] = useState(topic?.body ?? '');
  const titleRef = useRef<HTMLInputElement>(null);
  const saving = useAsyncAction(async () => {
    await onSave({ title: title.trim(), body });
  });
  const dirty = title !== (topic?.title ?? '') || body !== (topic?.body ?? '');

  // The form opens on its first field, so typing starts at once.
  useEffect(() => titleRef.current?.focus(), []);

  useUnsavedChanges({
    dirty,
    what: topic === undefined ? 'the new topic' : `the topic ${topic.id}`,
    save: async () => {
      if (title.trim() === '') return 'The title must not be blank.';
      const failure = await saving.attempt();
      if (failure === undefined) onDone();
      return failure;
    },
    discard: onDone,
  });

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (saving.pending || title.trim() === '') return;
    void saving.run().then((ok) => {
      if (ok) onDone();
    });
  };

  return (
    <form className="form topics__form" onSubmit={submit}>
      <Field label="Title">
        {(id) => (
          <Input
            id={id}
            ref={titleRef}
            value={title}
            required
            autoComplete="off"
            onChange={(event) => setTitle(event.target.value)}
          />
        )}
      </Field>
      <Field label="Description" hint="Markdown">
        {(id) => (
          <Textarea
            id={id}
            rows={6}
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />
        )}
      </Field>

      {saving.error === undefined ? null : (
        <p className="form__error" role="alert">
          {saving.error}
        </p>
      )}
      <div className="form__actions">
        <Button onClick={onDone}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={saving.pending || title.trim() === ''}>
          {saving.pending ? 'Saving…' : topic === undefined ? 'Create' : 'Save'}
        </Button>
      </div>
    </form>
  );
}
