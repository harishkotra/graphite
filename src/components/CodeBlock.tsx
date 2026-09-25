import { useState } from "react";

// Minimal Python highlighter — enough for matplotlib snippets, zero deps.
function highlightPython(code: string): { __html: string } {
  const escaped = code
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  const KW = /\b(import|from|as|def|return|if|elif|else|for|while|in|not|and|or|is|None|True|False|try|except|finally|with|lambda|class|pass|raise|assert|yield|global|del|break|continue)\b/;

  const html = escaped
    .replace(/(#.*)$/gm, '<span class="tok-comment">$1</span>')
    .replace(/(&quot;|")(?:[^"\\\n]|\\.)*\1|'(?:[^'\\\n]|\\.)*'/g, (m) => `<span class="tok-str">${m}</span>`)
    .replace(new RegExp(`(${KW.source})`, "g"), '<span class="tok-kw">$1</span>')
    .replace(/\b(\d+\.?\d*)\b/g, '<span class="tok-num">$1</span>');
  return { __html: html };
}

export function CodeBlock({ code, label }: { code: string; label: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="codeblock">
      <button className="codeblock-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="codeblock-caret" aria-hidden="true">{open ? "▾" : "▸"}</span>
        {label}
        <span className="codeblock-meta">{code.split("\n").length} lines</span>
      </button>
      {open && (
        <pre className="codeblock-pre">
          <code dangerouslySetInnerHTML={highlightPython(code)} />
        </pre>
      )}
    </div>
  );
}
