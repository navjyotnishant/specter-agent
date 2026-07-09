import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import Placeholder from "@tiptap/extension-placeholder";
import CodeBlock from "@tiptap/extension-code-block";
import Highlight from "@tiptap/extension-highlight";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import MarkdownIt from "markdown-it";
import {
  Bold,
  Italic,
  UnderlineIcon,
  Strikethrough,
  Code,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  ListChecks,
  Minus,
  Undo,
  Redo,
  Highlighter,
} from "lucide-react";
import { useEffect, useCallback } from "react";
import { cn } from "@/lib/utils";

const md = new MarkdownIt({ html: false, breaks: true });

// ── Markdown → HTML ───────────────────────────────────────────────────────────
function markdownToHtml(markdown: string): string {
  return md.render(markdown || "");
}

// ── HTML → Markdown ───────────────────────────────────────────────────────────
function htmlToMarkdown(html: string): string {
  // Walk the DOM tree and convert to Markdown
  const el = document.createElement("div");
  el.innerHTML = html;
  return nodeToMarkdown(el).trim();
}

function nodeToMarkdown(node: Node, ctx: { listType?: "ul" | "ol" | "task"; depth?: number; index?: number } = {}): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";

  if (node.nodeType !== Node.ELEMENT_NODE) return "";

  const el = node as HTMLElement;
  const tag = el.tagName.toLowerCase();
  const children = Array.from(el.childNodes);

  const inline = () => children.map((c) => nodeToMarkdown(c, ctx)).join("");
  const block = (prefix: string) => `${prefix}${inline()}\n`;

  switch (tag) {
    case "h1": return `# ${inline()}\n\n`;
    case "h2": return `## ${inline()}\n\n`;
    case "h3": return `### ${inline()}\n\n`;
    case "h4": return `#### ${inline()}\n\n`;
    case "p":  return `${inline()}\n\n`;
    case "strong": case "b": return `**${inline()}**`;
    case "em": case "i":     return `_${inline()}_`;
    case "u":                return `__${inline()}__`;
    case "s": case "del":    return `~~${inline()}~~`;
    case "code": return el.parentElement?.tagName.toLowerCase() === "pre"
      ? inline()
      : `\`${inline()}\``;
    case "pre": {
      const codeEl = el.querySelector("code");
      const lang = codeEl?.className.replace("language-", "") ?? "";
      return `\`\`\`${lang}\n${codeEl?.textContent ?? ""}\n\`\`\`\n\n`;
    }
    case "mark": return `==${inline()}==`;
    case "hr":   return `---\n\n`;
    case "br":   return "\n";
    case "blockquote": return children.map((c) => `> ${nodeToMarkdown(c, ctx).trimEnd()}`).join("\n") + "\n\n";
    case "ul": {
      // detect task list
      const isTask = el.querySelector('input[type="checkbox"]') !== null;
      return children
        .filter((c) => (c as HTMLElement).tagName?.toLowerCase() === "li")
        .map((c) => nodeToMarkdown(c, { listType: isTask ? "task" : "ul", depth: (ctx.depth ?? 0) + 1 }))
        .join("") + "\n";
    }
    case "ol": {
      return children
        .filter((c) => (c as HTMLElement).tagName?.toLowerCase() === "li")
        .map((c, i) => nodeToMarkdown(c, { listType: "ol", depth: (ctx.depth ?? 0) + 1, index: i + 1 }))
        .join("") + "\n";
    }
    case "li": {
      const indent = "  ".repeat(Math.max(0, (ctx.depth ?? 1) - 1));
      if (ctx.listType === "task") {
        const cb = el.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
        const checked = cb?.checked ? "x" : " ";
        // remove checkbox from text
        const textNodes = Array.from(el.childNodes).filter(
          (c) => !(c instanceof HTMLElement && c.tagName.toLowerCase() === "input")
        );
        const text = textNodes.map((c) => nodeToMarkdown(c, ctx)).join("").trim();
        return `${indent}- [${checked}] ${text}\n`;
      }
      if (ctx.listType === "ol") return `${indent}${ctx.index ?? 1}. ${inline().trim()}\n`;
      return `${indent}- ${inline().trim()}\n`;
    }
    case "div": return children.map((c) => nodeToMarkdown(c, ctx)).join("");
    default:    return inline();
  }
}

// ── Toolbar button ─────────────────────────────────────────────────────────────
function ToolbarBtn({
  onClick, active, disabled, title, children,
}: {
  onClick: () => void; active?: boolean; disabled?: boolean; title: string; children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onMouseDown={(e) => { e.preventDefault(); onClick(); }}
      disabled={disabled}
      title={title}
      className={cn(
        "flex h-7 w-7 items-center justify-center rounded-lg transition-colors",
        active
          ? "bg-indigo-100 text-indigo-700"
          : "text-slate-500 hover:bg-slate-100 hover:text-slate-800",
        disabled && "cursor-not-allowed opacity-40",
      )}
    >
      {children}
    </button>
  );
}

function Divider() {
  return <div className="mx-1 h-5 w-px bg-slate-200" />;
}

// ── Main component ─────────────────────────────────────────────────────────────
interface RichTextEditorProps {
  value: string;           // Markdown in
  onChange: (md: string) => void; // Markdown out
  placeholder?: string;
  minHeight?: string;
  className?: string;
}

export function RichTextEditor({ value, onChange, placeholder = "Write skill instructions…", minHeight = "420px", className }: RichTextEditorProps) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ codeBlock: false }),
      Underline,
      CodeBlock.configure({ languageClassPrefix: "language-" }),
      Highlight,
      TaskList,
      TaskItem.configure({ nested: true }),
      Placeholder.configure({ placeholder }),
    ],
    content: markdownToHtml(value),
    onUpdate: ({ editor: e }) => {
      onChange(htmlToMarkdown(e.getHTML()));
    },
    editorProps: {
      attributes: {
        class: cn(
          "prose prose-sm prose-slate max-w-none outline-none",
          "prose-headings:font-semibold prose-headings:text-slate-900",
          "prose-code:rounded prose-code:bg-slate-100 prose-code:px-1 prose-code:text-slate-800 prose-code:font-mono prose-code:text-xs",
          "prose-pre:rounded-xl prose-pre:bg-slate-900 prose-pre:text-slate-100",
          "prose-blockquote:border-l-indigo-300 prose-blockquote:text-slate-500",
          "prose-li:marker:text-slate-400",
        ),
      },
    },
  });

  // Sync external value changes (e.g. switching skills)
  useEffect(() => {
    if (!editor) return;
    const currentHtml = editor.getHTML();
    const newHtml = markdownToHtml(value);
    // Only update if content genuinely changed to avoid cursor jump
    if (htmlToMarkdown(currentHtml).trim() !== value.trim()) {
      editor.commands.setContent(newHtml, false);
    }
  }, [value, editor]);

  const e = editor;

  return (
    <div className={cn("rounded-xl border border-slate-200 bg-white overflow-hidden", className)}>
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-0.5 border-b border-slate-100 bg-slate-50 px-2 py-1.5">
        {/* history */}
        <ToolbarBtn title="Undo" onClick={() => e?.chain().focus().undo().run()} disabled={!e?.can().undo()}>
          <Undo className="h-3.5 w-3.5" />
        </ToolbarBtn>
        <ToolbarBtn title="Redo" onClick={() => e?.chain().focus().redo().run()} disabled={!e?.can().redo()}>
          <Redo className="h-3.5 w-3.5" />
        </ToolbarBtn>

        <Divider />

        {/* headings */}
        <ToolbarBtn title="Heading 1" active={e?.isActive("heading", { level: 1 })} onClick={() => e?.chain().focus().toggleHeading({ level: 1 }).run()}>
          <Heading1 className="h-3.5 w-3.5" />
        </ToolbarBtn>
        <ToolbarBtn title="Heading 2" active={e?.isActive("heading", { level: 2 })} onClick={() => e?.chain().focus().toggleHeading({ level: 2 }).run()}>
          <Heading2 className="h-3.5 w-3.5" />
        </ToolbarBtn>
        <ToolbarBtn title="Heading 3" active={e?.isActive("heading", { level: 3 })} onClick={() => e?.chain().focus().toggleHeading({ level: 3 }).run()}>
          <Heading3 className="h-3.5 w-3.5" />
        </ToolbarBtn>

        <Divider />

        {/* inline marks */}
        <ToolbarBtn title="Bold" active={e?.isActive("bold")} onClick={() => e?.chain().focus().toggleBold().run()}>
          <Bold className="h-3.5 w-3.5" />
        </ToolbarBtn>
        <ToolbarBtn title="Italic" active={e?.isActive("italic")} onClick={() => e?.chain().focus().toggleItalic().run()}>
          <Italic className="h-3.5 w-3.5" />
        </ToolbarBtn>
        <ToolbarBtn title="Underline" active={e?.isActive("underline")} onClick={() => e?.chain().focus().toggleUnderline().run()}>
          <UnderlineIcon className="h-3.5 w-3.5" />
        </ToolbarBtn>
        <ToolbarBtn title="Strikethrough" active={e?.isActive("strike")} onClick={() => e?.chain().focus().toggleStrike().run()}>
          <Strikethrough className="h-3.5 w-3.5" />
        </ToolbarBtn>
        <ToolbarBtn title="Highlight" active={e?.isActive("highlight")} onClick={() => e?.chain().focus().toggleHighlight().run()}>
          <Highlighter className="h-3.5 w-3.5" />
        </ToolbarBtn>
        <ToolbarBtn title="Inline code" active={e?.isActive("code")} onClick={() => e?.chain().focus().toggleCode().run()}>
          <Code className="h-3.5 w-3.5" />
        </ToolbarBtn>

        <Divider />

        {/* lists */}
        <ToolbarBtn title="Bullet list" active={e?.isActive("bulletList")} onClick={() => e?.chain().focus().toggleBulletList().run()}>
          <List className="h-3.5 w-3.5" />
        </ToolbarBtn>
        <ToolbarBtn title="Numbered list" active={e?.isActive("orderedList")} onClick={() => e?.chain().focus().toggleOrderedList().run()}>
          <ListOrdered className="h-3.5 w-3.5" />
        </ToolbarBtn>
        <ToolbarBtn title="Task list" active={e?.isActive("taskList")} onClick={() => e?.chain().focus().toggleTaskList().run()}>
          <ListChecks className="h-3.5 w-3.5" />
        </ToolbarBtn>

        <Divider />

        {/* blocks */}
        <ToolbarBtn title="Divider" onClick={() => e?.chain().focus().setHorizontalRule().run()}>
          <Minus className="h-3.5 w-3.5" />
        </ToolbarBtn>
      </div>

      {/* editor area */}
      <EditorContent
        editor={editor}
        className="px-4 py-3"
        style={{ minHeight }}
      />
    </div>
  );
}
