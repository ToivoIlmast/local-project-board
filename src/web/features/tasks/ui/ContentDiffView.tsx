import { diffContent, type DiffLine, type TaskContent } from '../../../../contract/v1/index';
import { Text } from '../../../shared/ui/index';

export interface ContentDiffViewProps {
  before: TaskContent;
  after: TaskContent;
  /** Names the two sides for a screen reader: "Changes to the title" and so on. */
  label?: string;
}

/** Lines of unchanged text kept around a change; the rest of a long run is folded. */
const CONTEXT = 3;

type Row = { kind: 'line'; line: DiffLine } | { kind: 'fold'; hidden: number };

/** The diff with its long unchanged runs folded into "N unchanged lines". */
export function foldContext(lines: readonly DiffLine[]): Row[] {
  const keep = lines.map((line, index) => {
    if (line.kind !== 'same') return true;
    for (
      let at = Math.max(0, index - CONTEXT);
      at <= Math.min(lines.length - 1, index + CONTEXT);
      at += 1
    ) {
      if (lines[at]?.kind !== 'same') return true;
    }
    return false;
  });
  const rows: Row[] = [];
  let hidden = 0;
  lines.forEach((line, index) => {
    if (keep[index]) {
      if (hidden > 0) rows.push({ kind: 'fold', hidden });
      hidden = 0;
      rows.push({ kind: 'line', line });
    } else {
      hidden += 1;
    }
  });
  if (hidden > 0) rows.push({ kind: 'fold', hidden });
  return rows;
}

const MARK = { add: '+', remove: '−', same: ' ' } as const;
const SPOKEN = { add: 'Added: ', remove: 'Removed: ', same: '' } as const;

/**
 * Two contents side by side in time, field by field: the title, the labels and the body, each
 * only if it differs. The marks are text, not just colour, and a line says what it is to a
 * screen reader. The diff itself is the function the board runs (`diffContent`, ADR-0030 §9).
 */
export function ContentDiffView({ before, after, label = 'Changes' }: ContentDiffViewProps) {
  const diff = diffContent(before, after);
  if (diff.changed.length === 0) {
    return <Text tone="muted">No changes to the title, the labels or the description.</Text>;
  }

  return (
    <div className="diff" role="group" aria-label={label}>
      {diff.title === null ? null : (
        <section className="diff__field" aria-label="Title">
          <h4 className="diff__name">Title</h4>
          <div className="diff__line diff__line--remove">
            <span aria-hidden="true">{MARK.remove}</span>
            <span className="diff__text">
              <span className="visually-hidden">{SPOKEN.remove}</span>
              {diff.title.before}
            </span>
          </div>
          <div className="diff__line diff__line--add">
            <span aria-hidden="true">{MARK.add}</span>
            <span className="diff__text">
              <span className="visually-hidden">{SPOKEN.add}</span>
              {diff.title.after}
            </span>
          </div>
        </section>
      )}

      {diff.labels === null ? null : (
        <section className="diff__field" aria-label="Labels">
          <h4 className="diff__name">Labels</h4>
          {diff.labels.reordered ? <p className="diff__note">Only the order changed.</p> : null}
          {diff.labels.removed.map((labelText) => (
            <div key={`-${labelText}`} className="diff__line diff__line--remove">
              <span aria-hidden="true">{MARK.remove}</span>
              <span className="diff__text">
                <span className="visually-hidden">{SPOKEN.remove}</span>
                {labelText}
              </span>
            </div>
          ))}
          {diff.labels.added.map((labelText) => (
            <div key={`+${labelText}`} className="diff__line diff__line--add">
              <span aria-hidden="true">{MARK.add}</span>
              <span className="diff__text">
                <span className="visually-hidden">{SPOKEN.add}</span>
                {labelText}
              </span>
            </div>
          ))}
        </section>
      )}

      {diff.body === null ? null : (
        <section className="diff__field" aria-label="Description">
          <h4 className="diff__name">Description</h4>
          <div className="diff__body" tabIndex={0}>
            {foldContext(diff.body).map((row, index) =>
              row.kind === 'fold' ? (
                // A diff is a fixed sequence of lines: its position is its identity.
                // eslint-disable-next-line @eslint-react/no-array-index-key
                <div key={`f${index}`} className="diff__fold">
                  … {row.hidden} unchanged {row.hidden === 1 ? 'line' : 'lines'}
                </div>
              ) : (
                // eslint-disable-next-line @eslint-react/no-array-index-key
                <div key={`l${index}`} className={`diff__line diff__line--${row.line.kind}`}>
                  <span aria-hidden="true">{MARK[row.line.kind]}</span>
                  <span className="diff__text">
                    <span className="visually-hidden">{SPOKEN[row.line.kind]}</span>
                    {row.line.text === '' ? ' ' : row.line.text}
                  </span>
                </div>
              ),
            )}
          </div>
        </section>
      )}
    </div>
  );
}
