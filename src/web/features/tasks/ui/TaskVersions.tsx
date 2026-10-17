import { useState } from 'react';
import type { Task, VersionList } from '../../../../contract/v1/index';
import { formatDate } from '../../../shared/lib/format';
import { Button, Field, Select, Text } from '../../../shared/ui/index';
import {
  CURRENT,
  currentVersion,
  taskContent,
  versionSummaryText,
  type Selected,
} from '../model/history';
import { useVersion } from '../model/useTaskHistory';
import { ContentDiffView } from './ContentDiffView';

export interface TaskVersionsProps {
  task: Task;
  list: VersionList | undefined;
  error: string | undefined;
  onRetry: () => void;
  /** Shows a version in the panel above, in place of the task. */
  onView: (selected: Selected) => void;
}

/** The side of a comparison: a version number, or what the task is now. */
type Side = typeof CURRENT | number;

/**
 * The history of the content of a task: every version with its number, date, where it came
 * from and what it changed, and a comparison of any two (ADR-0030). Only what the board said.
 */
export function TaskVersions({ task, list, error, onRetry, onView }: TaskVersionsProps) {
  const versions = [...(list?.versions ?? [])].sort((a, b) => b.number - a.number);
  const at = currentVersion(task, list);
  const [from, setFrom] = useState<Side | undefined>(undefined);
  const [to, setTo] = useState<Side>(CURRENT);

  // The default comparison is the version before the current one against the current one.
  const older = versions.find((version) => version.number !== at);
  const fromSide: Side | undefined = from ?? older?.number;

  const sides: { value: string; label: string }[] = [
    { value: CURRENT, label: at === null ? 'Current' : `Current (v${at})` },
    ...versions
      .filter((version) => version.number !== at)
      .map((version) => ({ value: String(version.number), label: `v${version.number}` })),
  ];
  const parse = (value: string): Side => (value === CURRENT ? CURRENT : Number(value));

  return (
    <section className="history" aria-labelledby={`versions-${task.id}`}>
      <h3 className="ai__title" id={`versions-${task.id}`}>
        Versions
      </h3>
      {error === undefined ? null : (
        <div className="notice" role="alert">
          <span>{error}</span>
          <Button size="small" onClick={onRetry}>
            Try again
          </Button>
        </div>
      )}
      {list === undefined ? null : versions.length === 0 ? (
        <Text tone="muted">
          No versions yet: the first change to the title, the labels or the description makes one.
        </Text>
      ) : (
        <ol className="history__list">
          {versions.map((version) => (
            <li key={version.number} className="history__item">
              <span className="history__number">v{version.number}</span>
              <span className="history__what">
                {versionSummaryText(version)}
                <span className="history__when"> · {formatDate(version.createdAt)}</span>
              </span>
              <Button
                size="small"
                aria-label={`View v${version.number}`}
                onClick={() => onView(version.number === at ? CURRENT : version.number)}
              >
                View
              </Button>
            </li>
          ))}
        </ol>
      )}

      {versions.length < 1 || sides.length < 2 ? null : (
        <div className="history__compare">
          <Field label="Compare">
            {(id) => (
              <Select
                id={id}
                options={sides.filter((side) => side.value !== String(to))}
                value={String(fromSide ?? '')}
                onChange={(event) => setFrom(parse(event.target.value))}
              />
            )}
          </Field>
          <Field label="With">
            {(id) => (
              <Select
                id={id}
                options={sides.filter((side) => side.value !== String(fromSide))}
                value={String(to)}
                onChange={(event) => setTo(parse(event.target.value))}
              />
            )}
          </Field>
          {fromSide === undefined ? null : <Comparison task={task} from={fromSide} to={to} />}
        </div>
      )}
    </section>
  );
}

function Comparison({ task, from, to }: { task: Task; from: Side; to: Side }) {
  const a = useVersion(task.id, from === CURRENT ? undefined : from);
  const b = useVersion(task.id, to === CURRENT ? undefined : to);
  const label = (side: Side): string => (side === CURRENT ? 'now' : `v${side}`);

  const before = from === CURRENT ? taskContent(task) : a.version?.snapshot;
  const after = to === CURRENT ? taskContent(task) : b.version?.snapshot;
  const error = a.error ?? b.error;
  if (error !== undefined) {
    return (
      <p className="form__error" role="alert">
        {error}
      </p>
    );
  }
  if (before === undefined || after === undefined) return <Text tone="muted">Loading…</Text>;
  return (
    <ContentDiffView
      before={before}
      after={after}
      label={`Changes from ${label(from)} to ${label(to)}`}
    />
  );
}
