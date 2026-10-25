import type { ComponentPropsWithoutRef } from 'react';
import ReactMarkdown, { type Components, type ExtraProps } from 'react-markdown';

export interface MarkdownProps {
  children: string;
  /**
   * The level a `#` heading of the text takes, when the text sits under headings of the page:
   * the rest follow it, down to h6, so the outline of the page stays in order.
   */
  headingLevel?: 2 | 3 | 4 | 5 | 6;
}

const LEVELS = [1, 2, 3, 4, 5, 6] as const;
type HeadingTag = `h${(typeof LEVELS)[number]}`;

function shiftedHeadings(first: number): Components {
  return Object.fromEntries(
    LEVELS.map((level) => {
      const Tag = `h${Math.min(6, level + first - 1)}` as HeadingTag;
      return [
        `h${level}`,
        ({ node: _node, ...props }: ComponentPropsWithoutRef<'h1'> & ExtraProps) => (
          <Tag {...props} />
        ),
      ];
    }),
  ) as Components;
}

/**
 * Markdown as markdown. Raw HTML inside it is not rendered: the board shows text written by
 * an agent, and an agent's `<script>` belongs in a sandboxed report, never in this page (§15).
 */
export function Markdown({ children, headingLevel }: MarkdownProps) {
  return (
    <div className="markdown">
      <ReactMarkdown
        components={{
          ...(headingLevel === undefined ? {} : shiftedHeadings(headingLevel)),
          // A code block can be wider than the panel; a keyboard has to be able to scroll it.
          pre: ({ node: _node, ...props }) => <pre tabIndex={0} {...props} />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
