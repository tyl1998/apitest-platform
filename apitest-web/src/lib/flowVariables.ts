import type { Environment, FlowEdge, FlowNode } from "../api";
import type { VariableOption } from "../components/VariablePicker";

/**
 * Which variables a given field can reference, and where each comes from.
 *
 * "Upstream" is the set of nodes that actually run before this one, not every
 * node on the canvas: offering a value produced by a later step would be
 * offering something that is guaranteed to be missing at run time.
 *
 * Mirrors the server's precedence — node extracts beat flow seeds beat
 * environment values — so what the picker implies is what the run does.
 *
 * Everything except the environment is optional, because the endpoint editor
 * uses the same completion with no flow around it: there, the answer is simply
 * the environment plus the builtins.
 */
export function variableOptions(input: {
  nodes?: FlowNode[];
  edges?: FlowEdge[];
  /** Omit to include every node's extracts, e.g. for flow-level fields. */
  nodeId?: string;
  variables?: Record<string, string>;
  environment?: Environment;
}): VariableOption[] {
  const upstream = input.nodeId ? ancestors(input.nodeId, input.edges ?? []) : undefined;
  const options: VariableOption[] = [];
  const seen = new Set<string>();

  for (const node of input.nodes ?? []) {
    if (node.id === input.nodeId) continue;
    if (upstream && !upstream.has(node.id)) continue;
    for (const name of produces(node)) {
      if (!name.trim() || seen.has(name)) continue;
      seen.add(name);
      options.push({ name, origin: "step", detail: node.name || undefined });
    }
  }

  for (const [name, value] of Object.entries(input.variables ?? {})) {
    if (seen.has(name)) continue;
    seen.add(name);
    options.push({ name, origin: "flow", detail: value || undefined });
  }

  for (const [name, value] of Object.entries(input.environment?.variables ?? {})) {
    if (seen.has(name)) continue;
    seen.add(name);
    options.push({ name, origin: "environment", detail: value || undefined });
  }
  /* Secrets are offered by name only — the value never leaves the server. */
  for (const name of input.environment?.secretKeys ?? []) {
    if (seen.has(name)) continue;
    seen.add(name);
    options.push({ name, origin: "environment", detail: "secret" });
  }

  return [...options, ...BUILTINS];
}

/**
 * Variable names a node declares it will produce.
 *
 * Request and database nodes declare extracts. A subflow or loop node declares
 * an `outputs` allow-list, which is exactly the same promise in a different
 * shape — so it belongs here rather than being invisible to completion.
 *
 * A script node is deliberately absent: only the script knows what it writes,
 * so listing anything would be a guess. Its run result shows what it produced.
 * A loop with `outputs: undefined` (publish everything) is also unknowable
 * ahead of time and contributes nothing.
 */
function produces(node: FlowNode): string[] {
  if (node.type === "subflow" || node.type === "loop") return node.outputs ?? [];
  return (node.extracts ?? []).map((extract) => extract.name);
}
/**
 * Built-in dynamic variables, resolved per reference at run time.
 *
 * Listed last but they win over everything: letting an environment shadow
 * `$uuid` would make a request behave differently per environment.
 */
const BUILTINS: VariableOption[] = [
  { name: "$uuid", origin: "builtin", detail: "随机 UUID" },
  { name: "$timestamp", origin: "builtin", detail: "毫秒，$timestamp(s) 为秒" },
  { name: "$date", origin: "builtin", detail: "$date(YYYY-MM-DD)" },
  { name: "$randomInt", origin: "builtin", detail: "$randomInt(10,20)" },
  { name: "$randomStr", origin: "builtin", detail: "$randomStr(16)" },
];

/** Every node that can reach `nodeId`, following edges backwards. */
function ancestors(nodeId: string, edges: FlowEdge[]): Set<string> {
  const incoming = new Map<string, string[]>();
  for (const edge of edges) incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge.source]);

  const found = new Set<string>();
  const queue = [...(incoming.get(nodeId) ?? [])];
  while (queue.length) {
    const current = queue.shift()!;
    /* Guards against a cycle the user has drawn but not yet fixed — the canvas
       reports it separately, and this must not hang while they do. */
    if (found.has(current)) continue;
    found.add(current);
    queue.push(...(incoming.get(current) ?? []));
  }
  return found;
}
