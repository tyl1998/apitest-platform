import { useMemo, useState } from "react";
import { Drawer } from "antd";
import { useTranslation } from "react-i18next";

type Node = {
  /** JSONPath expression that reads this node, e.g. `$.data.items[0].id`. */
  path: string;
  /** Label shown in the tree: the key or index that reached this node. */
  label: string;
  /** Rendered preview of the value; objects and arrays show their size. */
  preview: string;
  /** Only leaves are selectable — a whole object is rarely a useful assertion. */
  selectable: boolean;
  depth: number;
  children: Node[];
};

/** A key that needs bracket notation because dotted access would not parse. */
function step(key: string) {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `.${key}` : `['${key.replace(/'/g, "\\'")}']`;
}

function preview(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[] ${value.length}`;
  if (typeof value === "object") return `{} ${Object.keys(value as object).length}`;
  if (typeof value === "string") return value.length > 60 ? `"${value.slice(0, 60)}…"` : `"${value}"`;
  return String(value);
}

/**
 * Walks a parsed body into selectable paths.
 *
 * Arrays are indexed rather than wildcarded: the picker offers what the body
 * actually contains, so a chosen path always resolves against this response.
 */
function build(value: unknown, path: string, label: string, depth: number): Node {
  const isObject = value !== null && typeof value === "object";
  const children: Node[] = !isObject ? [] : Array.isArray(value)
    /* Deep arrays make the tree unreadable, and an assertion on the 200th
       element is not something anyone picks from a list. */
    ? value.slice(0, 50).map((item, index) => build(item, `${path}[${index}]`, `[${index}]`, depth + 1))
    : Object.entries(value as Record<string, unknown>).map(([key, item]) => build(item, `${path}${step(key)}`, key, depth + 1));

  return { path, label, preview: preview(value), selectable: !isObject, depth, children };
}

function flatten(node: Node, expanded: Set<string>, into: Node[] = []): Node[] {
  into.push(node);
  if (expanded.has(node.path)) for (const child of node.children) flatten(child, expanded, into);
  return into;
}

/** Paths expanded by default: the root and its immediate object children. */
function initialExpanded(root: Node): Set<string> {
  const open = new Set<string>([root.path]);
  for (const child of root.children) if (child.children.length) open.add(child.path);
  return open;
}

/**
 * Picks JSONPath expressions out of a response body.
 *
 * Typing a path by hand means guessing at the shape and finding out only when
 * the assertion fails, so the body itself is the menu. Selecting several
 * returns several paths, one assertion each.
 */
export function JsonPathPicker({ open, body, onClose, onPick }: {
  open: boolean;
  /** Raw response text. Parsed here so a non-JSON body can be reported. */
  body?: string;
  onClose: () => void;
  onPick: (paths: string[]) => void;
}) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  /* Re-seeded per open so a previous pick never carries into the next one. */
  const [seeded, setSeeded] = useState(false);

  const root = useMemo(() => {
    if (!body) return undefined;
    try { return build(JSON.parse(body), "$", "$", 0); } catch { return undefined; }
  }, [body]);

  if (open && !seeded) {
    setSeeded(true);
    setSelected([]);
    setExpanded(root ? initialExpanded(root) : new Set());
  }
  if (!open && seeded) setSeeded(false);

  function toggleSelected(path: string) {
    setSelected((current) => current.includes(path) ? current.filter((item) => item !== path) : [...current, path]);
  }

  function toggleExpanded(path: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  }

  const rows = root ? flatten(root, expanded) : [];

  return <Drawer
    title={t("assertions.pickTitle")}
    open={open}
    onClose={onClose}
    width={560}
    extra={<div className="history-tools">
      <span className="muted mono">{t("assertions.pickSelected", { count: selected.length })}</span>
      <button className="btn btn-primary" disabled={!selected.length} onClick={() => { onPick(selected); onClose(); }}>
        {t("assertions.pickConfirm")}
      </button>
    </div>}
  >
    {!root
      ? <p className="muted">{t("assertions.pickNotJson")}</p>
      : <div className="jsonpath-tree">
          {rows.map((node) => <div
            key={node.path}
            className={`jsonpath-row${selected.includes(node.path) ? " is-selected" : ""}`}
            style={{ paddingLeft: `${node.depth * 14 + 8}px` }}
          >
            {node.children.length
              ? <button className="jsonpath-toggle mono" onClick={() => toggleExpanded(node.path)} aria-label={t("assertions.pickExpand")}>
                  {expanded.has(node.path) ? "−" : "+"}
                </button>
              : <span className="jsonpath-toggle" />}
            {node.selectable
              ? <label className="jsonpath-pick">
                  <input type="checkbox" checked={selected.includes(node.path)} onChange={() => toggleSelected(node.path)} />
                  <span className="mono jsonpath-key">{node.label}</span>
                  <span className="mono muted jsonpath-value truncate">{node.preview}</span>
                </label>
              : <span className="jsonpath-pick is-branch">
                  <span className="mono jsonpath-key">{node.label}</span>
                  <span className="mono muted jsonpath-value">{node.preview}</span>
                </span>}
          </div>)}
        </div>}
  </Drawer>;
}
