export type SelectionInfo = {
  kind: "image" | "text" | "invalid";
  label: string;
  count: number;
};
export type SearchQuery =
  { kind: "text"; texts: string[] } | { kind: "reference"; id: string } | { kind: "image"; bytes: Uint8Array; excludeId?: string };
export type Result = {
  id: string;
  name: string;
  cluster: string;
  score: number;
};
export type InsertImage = { id: string; name: string; bytes: Uint8Array };
type SelectableNode = {
  id?: string;
  type: string;
  name: string;
  visible?: boolean;
  characters?: string;
  text?: { characters: string };
  fills?: unknown;
  children?: readonly SelectableNode[];
};
const textContainers = new Set([
  "FRAME",
  "GROUP",
  "COMPONENT",
  "INSTANCE",
  "COMPONENT_SET",
  "SECTION",
]);
const textTypes = new Set(["TEXT", "TEXT_PATH", "SHAPE_WITH_TEXT", "STICKY"]);
export function selectedTextNodes(
  nodes: readonly SelectableNode[],
): SelectableNode[] {
  const found: SelectableNode[] = [];
  const seen = new Set<string | SelectableNode>();
  function visit(node: SelectableNode) {
    if (node.visible === false || seen.has(node.id ?? node)) return;
    seen.add(node.id ?? node);
    if (textTypes.has(node.type)) {
      found.push({
        type: node.type,
        name: node.name,
        characters: node.characters ?? node.text?.characters ?? "",
      });
    } else if (textContainers.has(node.type)) node.children?.forEach(visit);
  }
  nodes.forEach(visit);
  return found;
}
export function selectedImageNodes<T extends SelectableNode>(nodes: readonly T[]): T[] {
  const found: T[] = [];
  const seen = new Set<string | SelectableNode>();
  function visit(node: SelectableNode) {
    if (node.visible === false || seen.has(node.id ?? node)) return;
    seen.add(node.id ?? node);
    if (Array.isArray(node.fills) && node.fills.some((p: any) => p.type === "IMAGE" && p.visible !== false && p.imageHash))
      found.push(node as T);
    else if (textContainers.has(node.type)) node.children?.forEach(visit);
  }
  nodes.forEach(visit);
  return found;
}

export function describeSelection(
  nodes: readonly SelectableNode[],
): SelectionInfo {
  if (!nodes.length)
    return {
      kind: "invalid",
      count: 0,
      label: "Select an image or text layers or sticky notes.",
    };
  if (
    nodes.length === 1 &&
    Array.isArray(nodes[0].fills) &&
    nodes[0].fills.some(
      (p: any) => p.type === "IMAGE" && p.visible !== false && p.imageHash,
    )
  )
    return { kind: "image", count: 1, label: nodes[0].name };
  if (nodes.every((n) => textTypes.has(n.type) || textContainers.has(n.type))) {
    const texts = selectedTextNodes(nodes);
    if (texts.some((n) => n.characters?.trim())) {
      return {
        kind: "text",
        count: texts.length,
        label:
          texts.length === 1 ? "1 text layer" : `${texts.length} text layers`,
      };
    }
    return {
      kind: "invalid",
      count: nodes.length,
      label:
        "No readable text in the selection. Select a text layer, sticky note, or container with text.",
    };
  }
  return {
    kind: "invalid",
    count: nodes.length,
    label: `Selected ${nodes.map((n) => n.type.toLowerCase()).join(", ")}. Select an image, text, sticky note, or container with text.`,
  };
}
export function gridPositions(
  sizes: { width: number; height: number }[],
  width = 320,
  gap = 24,
) {
  let x = 0,
    y = 0,
    rowHeight = 0;
  return sizes.map((size, i) => {
    if (i > 0 && i % 3 === 0) {
      x = 0;
      y += rowHeight + gap;
      rowHeight = 0;
    }
    const height = (width * size.height) / size.width;
    const result = { x, y, width, height };
    x += width + gap;
    rowHeight = Math.max(rowHeight, height);
    return result;
  });
}
