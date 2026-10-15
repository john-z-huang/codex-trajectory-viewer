import ReactMarkdown from "react-markdown";
import { safeMarkdownUrl } from "../lib/markdown-content.js";
import { markdownComponents } from "../lib/markdown-components.js";

export default function MarkdownContent({ children }) {
  return <div className="markdown-body">
    <ReactMarkdown
      urlTransform={safeMarkdownUrl}
      components={markdownComponents}
    >{children}</ReactMarkdown>
  </div>;
}
