import ReactMarkdown from "react-markdown";
import type { ObservationRecord } from "../types.js";

export function ObservationText({ observation }: { observation: ObservationRecord }) {
  const text = sourceDisplayText(observation.text);
  return <MarkdownText text={text} markdown={observation.role === "assistant"} />;
}

export function MarkdownText({ text, markdown }: { text: string; markdown?: boolean }) {
  const displayText = sourceDisplayText(text);
  if (!markdown) return <p className="whitespace-pre-wrap break-words text-sm leading-6 text-[var(--app-ink)]">{displayText}</p>;

  return (
    <div className="source-markdown break-words text-sm leading-6 text-[var(--app-ink)]">
      <ReactMarkdown
        skipHtml
        components={{
          a: ({ children, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
          img: ({ alt }) => <span className="text-[var(--app-subtle)]">Image: {alt || "attachment"}</span>
        }}
      >
        {displayText}
      </ReactMarkdown>
    </div>
  );
}

export function sourceDisplayText(text: string): string {
  let inFence = false;
  return text.split(/\r?\n/).map((line) => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      return line;
    }
    if (inFence) return line;
    return line.replace(/^(Image|File|Files mentioned):\s+(.+?)\s+\(((?:\/|~\/|[A-Za-z]:\\)[^)]+)\)$/i, (_match, kind: string, name: string) =>
      `${kind.toLowerCase() === "files mentioned" ? "File" : kind}: ${name}`
    );
  }).join("\n");
}
