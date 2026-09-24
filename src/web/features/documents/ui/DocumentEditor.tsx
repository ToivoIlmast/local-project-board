import { useState, type FormEvent } from 'react';
import { Button, Field, Input, Textarea } from '../../../shared/ui/index';

export interface DocumentEditorProps {
  /** Set when an existing document is being rewritten; its name cannot change. */
  name?: string | undefined;
  initialContent?: string;
  pending: boolean;
  error: string | undefined;
  onSubmit: (name: string, content: string) => void;
  onCancel: () => void;
}

export function DocumentEditor({
  name,
  initialContent = '',
  pending,
  error,
  onSubmit,
  onCancel,
}: DocumentEditorProps) {
  const [fileName, setFileName] = useState(name ?? '');
  const [content, setContent] = useState(initialContent);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    onSubmit(fileName.trim(), content);
  };

  return (
    <form className="form" onSubmit={submit}>
      <Field label="File name" hint="Ends in .md or .html">
        {(id) => (
          <Input
            id={id}
            value={fileName}
            autoComplete="off"
            disabled={name !== undefined}
            onChange={(event) => setFileName(event.target.value)}
          />
        )}
      </Field>
      <Field label="Content">
        {(id) => (
          <Textarea
            id={id}
            rows={14}
            value={content}
            onChange={(event) => setContent(event.target.value)}
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
        <Button type="submit" variant="primary" disabled={pending || fileName.trim() === ''}>
          {pending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </form>
  );
}
