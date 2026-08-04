import { isValidElement, memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { MermaidBlock } from "./MermaidBlock";

interface MarkdownProps {
  /** Markdown source text. */
  children: string;
  /** Tighter spacing for the ThinkingBlock's max-300px scrollable pane. */
  compact?: boolean;
}

/**
 * Shared Markdown renderer for agent-produced content (assistant bubbles +
 * thinking blocks). Plugin set and component map are stable across both
 * call-sites so visual behaviour stays consistent.
 *
 * Plugins:
 *  - `remark-gfm`  — GFM tables, strikethrough, task lists, autolinks.
 *  - `rehype-highlight` — syntax highlighting for fenced code blocks. CSS
 *    theme is provided by the `.hljs-*` rules in globals.css (so it
 *    follows the dark / light theme switch automatically).
 *
 * Security: raw HTML is NOT passed through (no `rehype-raw`). React-markdown
 * escapes inline HTML by default; agent output cannot inject `<script>` etc.
 *
 * Streaming note: `ReactMarkdown` re-parses the full string on every text
 * change during agent streaming. Acceptable for v1; revisit if long replies
 * with deep syntax trees cause visible jank.
 */
export const Markdown = memo(function Markdown({ children, compact }: MarkdownProps) {
  return (
    <div className={compact ? "markdown-body markdown-body--compact" : "markdown-body"}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={components}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
});

// ─── Component map ───────────────────────────────────────────────────────

const components: Components = {
  // Fenced code blocks: rehype-highlight injects `class="hljs language-xxx"`
  // on the inner `<code>`. Detect `language-mermaid` and route to
  // `<MermaidBlock>`; everything else gets the default highlighting wrapper.
  code({ className, children, ...rest }) {
    const text = String(children ?? "");
    if (/language-mermaid/.test(className ?? "")) {
      // Render in place of the outer <pre><code> — return a block element
      // that visually replaces the whole fenced block.
      return <MermaidBlock code={text.replace(/\n$/, "")} />;
    }
    return (
      <code className={className} {...rest}>
        {children}
      </code>
    );
  },

  // Code-block container — padded, scrollable, themed surface, with a small
  // language label in the top-right corner (extracted from the inner
  // `<code>`'s `language-xxx` class).
  pre({ children, ...rest }) {
    let language: string | null = null;
    if (isValidElement(children)) {
      const childProps = children.props as { className?: string };
      const m = /language-(\w+)/.exec(childProps.className ?? "");
      if (m) language = m[1];
    }
    return (
      <div className="my-2.5 relative group/codeblock">
        {language ? (
          <span
            className="absolute right-2.5 top-1.5 text-[10px] font-medium uppercase tracking-wider text-[var(--text-tertiary)] select-none pointer-events-none"
            aria-hidden
          >
            {language}
          </span>
        ) : null}
        <pre
          className="overflow-x-auto rounded-[var(--radius-md)] border border-[color:var(--border-subtle)] bg-[var(--glass-3-surface)] py-2.5 px-3 pr-14 text-xs leading-relaxed font-mono"
          {...rest}
        >
          {children}
        </pre>
      </div>
    );
  },

  // GFM tables — surfaces, striped body rows, hover, header tint.
  table({ children, ...rest }) {
    return (
      <div className="my-2.5 overflow-x-auto rounded-[var(--radius-md)] border border-[color:var(--border-subtle)] bg-[var(--glass-3-surface)]">
        <table className="w-full text-sm border-collapse" {...rest}>
          {children}
        </table>
      </div>
    );
  },
  thead({ children, ...rest }) {
    return (
      <thead
        className="bg-[var(--glass-2-surface)] border-b border-[color:var(--border-default)]"
        {...rest}
      >
        {children}
      </thead>
    );
  },
  th({ children, ...rest }) {
    return (
      <th
        className="text-left font-semibold py-1.5 px-2.5 text-[var(--text-primary)] whitespace-nowrap"
        {...rest}
      >
        {children}
      </th>
    );
  },
  tbody({ children, ...rest }) {
    return <tbody {...rest}>{children}</tbody>;
  },
  tr({ children, ...rest }) {
    return (
      <tr
        className="border-b border-[color:var(--border-subtle)] last:border-0 transition-colors hover:bg-[var(--overlay-hover)]"
        {...rest}
      >
        {children}
      </tr>
    );
  },
  td({ children, ...rest }) {
    return (
      <td className="py-1.5 px-2.5 align-top" {...rest}>
        {children}
      </td>
    );
  },

  // Checkbox rendered for GFM task-list items. The list-item itself already
  // contains a `disabled` checkbox from remark-gfm; we restyle it so it
  // matches the dark/light theme instead of inheriting the browser default.
  input({ type, checked, disabled, ...rest }) {
    if (type !== "checkbox") {
      return <input type={type} {...rest} />;
    }
    return (
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        readOnly
        className="mr-1.5 align-middle accent-[var(--accent)]"
        {...rest}
      />
    );
  },

  // Links — open externally, never inside the Tauri webview. Subtle
  // underline by default so links stay scannable; color follows the
  // theme accent.
  a({ href, children, ...rest }) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-[var(--accent)] underline decoration-[color:var(--accent)]/30 underline-offset-2 hover:decoration-[color:var(--accent)] hover:text-[var(--accent-hover)] transition-colors"
        {...rest}
      >
        {children}
      </a>
    );
  },

  // Lists — muted markers (CSS `marker:`), tight spacing, nested style.
  ul({ children, ...rest }) {
    return (
      <ul
        className="my-1.5 pl-6 list-disc marker:text-[var(--text-tertiary)] [&_ul]:list-circle [&_ol]:list-decimal space-y-0.5"
        {...rest}
      >
        {children}
      </ul>
    );
  },
  ol({ children, ...rest }) {
    return (
      <ol
        className="my-1.5 pl-6 list-decimal marker:text-[var(--text-tertiary)] marker:font-normal space-y-0.5"
        {...rest}
      >
        {children}
      </ol>
    );
  },
  li({ children, ...rest }) {
    return (
      <li className="leading-relaxed" {...rest}>
        {children}
      </li>
    );
  },

  // Blockquote — accent left border + subtle surface tint.
  blockquote({ children, ...rest }) {
    return (
      <blockquote
        className="border-l-2 border-[color:var(--accent)] bg-[var(--glass-2-surface)]/60 pl-3 pr-2 py-1 my-2 text-[var(--text-secondary)] not-italic rounded-r-[var(--radius-sm)]"
        {...rest}
      >
        {children}
      </blockquote>
    );
  },

  // Headings — size gradient + subtle bottom border for h1/h2 to anchor
  // the eye in long replies.
  h1({ children, ...rest }) {
    return (
      <h1
        className="text-[1.4em] font-semibold mt-3 mb-1.5 pb-1 border-b border-[color:var(--border-subtle)] text-[var(--text-primary)]"
        {...rest}
      >
        {children}
      </h1>
    );
  },
  h2({ children, ...rest }) {
    return (
      <h2
        className="text-[1.25em] font-semibold mt-3 mb-1.5 pb-1 border-b border-[color:var(--border-subtle)] text-[var(--text-primary)]"
        {...rest}
      >
        {children}
      </h2>
    );
  },
  h3({ children, ...rest }) {
    return (
      <h3 className="text-[1.1em] font-semibold mt-2.5 mb-1 text-[var(--text-primary)]" {...rest}>
        {children}
      </h3>
    );
  },
  h4({ children, ...rest }) {
    return (
      <h4 className="text-[1.05em] font-semibold mt-2 mb-1 text-[var(--text-primary)]" {...rest}>
        {children}
      </h4>
    );
  },
  h5({ children, ...rest }) {
    return (
      <h5 className="text-[1em] font-semibold mt-2 mb-1 text-[var(--text-primary)]" {...rest}>
        {children}
      </h5>
    );
  },
  h6({ children, ...rest }) {
    return (
      <h6 className="text-[0.95em] font-semibold mt-1.5 mb-1 text-[var(--text-secondary)]" {...rest}>
        {children}
      </h6>
    );
  },

  // Horizontal rule — subtle dashed line instead of a solid hairline.
  hr({ ...rest }) {
    return (
      <hr
        className="my-3.5 border-0 border-t border-dashed border-[color:var(--border-default)]"
        {...rest}
      />
    );
  },

  // Paragraphs — tight margins (EntryView already had this; centralised here).
  p({ children, ...rest }) {
    return (
      <p className="my-1.5 leading-relaxed" {...rest}>
        {children}
      </p>
    );
  },

  // Strong / em — explicit theme colour so they don't drift toward the
  // muted `--muted-foreground` token (which the docs voice uses).
  strong({ children, ...rest }) {
    return (
      <strong className="font-semibold text-[var(--text-primary)]" {...rest}>
        {children}
      </strong>
    );
  },
  em({ children, ...rest }) {
    return (
      <em className="italic text-[var(--text-primary)]" {...rest}>
        {children}
      </em>
    );
  },

  // Strikethrough — slightly muted so deleted text doesn't shout.
  del({ children, ...rest }) {
    return (
      <del className="text-[var(--text-secondary)] line-through decoration-[color:var(--destructive)]/50" {...rest}>
        {children}
      </del>
    );
  },

  // Images — cap height, rounded corners.
  img({ src, alt, ...rest }) {
    return (
      <img
        src={src}
        alt={alt ?? ""}
        className="my-2 max-h-72 max-w-full rounded-[var(--radius-sm)] object-contain border border-[color:var(--border-subtle)]"
        loading="lazy"
        {...rest}
      />
    );
  },
};
