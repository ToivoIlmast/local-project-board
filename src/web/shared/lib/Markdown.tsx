import ReactMarkdown from 'react-markdown';

export interface MarkdownProps {
  children: string;
}

/**
 * Markdown as markdown. Raw HTML inside it is not rendered: the board shows text written by
 * an agent, and an agent's `<script>` belongs in a sandboxed report, never in this page (§15).
 */
export function Markdown({ children }: MarkdownProps) {
  return (
    <div className="markdown">
      <ReactMarkdown
        components={{
          // A code block can be wider than the panel; a keyboard has to be able to scroll it.
          pre: ({ node: _node, ...props }) => <pre tabIndex={0} {...props} />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
