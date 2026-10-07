import {
  describeSelection,
  selectedTextNodes,
  gridPositions,
  type InsertImage,
} from "./shared";
figma.showUI(__html__, { width: 660, height: 680, themeColors: true });
let anchor: { page: PageNode; x: number; y: number } | null = null;
let busy = false;
function selection() {
  figma.ui.postMessage({
    type: "selection",
    selection: describeSelection(figma.currentPage.selection),
  });
}
figma.on("selectionchange", selection);
function captureAnchor(nodes: readonly SceneNode[]) {
  const page = figma.currentPage;
  let parent: BaseNode | null = nodes[0]?.parent ?? null;
  while (parent && parent.type !== "FRAME" && parent.type !== "PAGE")
    parent = parent.parent;
  const frame =
    parent?.type === "FRAME" &&
    nodes.every((n) => {
      let p: BaseNode | null = n.parent;
      while (p) {
        if (p === parent) return true;
        p = p.parent;
      }
      return false;
    })
      ? parent
      : null;
  // Place references beside the source frame so clipped content cannot hide them.
  const boxes = (frame ? [frame] : nodes)
    .map((n) => n.absoluteBoundingBox)
    .filter((b): b is Rect => !!b);
  const right = boxes.length
    ? Math.max(...boxes.map((b) => b.x + b.width)) + 48
    : figma.viewport.center.x;
  const top = boxes.length
    ? Math.min(...boxes.map((b) => b.y))
    : figma.viewport.center.y;
  return { page, x: right, y: top };
}
figma.ui.onmessage = async (message) => {
  try {
    if (message.type === "load-connection") {
      const key = await figma.clientStorage.getAsync(`taste-access-key:${message.endpoint}`);
      const storedId = await figma.clientStorage.getAsync("taste-installation-id");
      figma.ui.postMessage({ type: "connection", key: typeof key === "string" ? key : "", installationId: storedId });
      return;
    }
    if (message.type === "save-installation") {
      if (typeof message.id === "string" && /^[a-f0-9-]{36}$/.test(message.id))
        await figma.clientStorage.setAsync("taste-installation-id", message.id);
      return;
    }
    if (message.type === "save-connection") {
      await figma.clientStorage.setAsync(`taste-access-key:${message.endpoint}`, message.key);
      return;
    }
    if (message.type === "ready") {
      selection();
      return;
    }
    if (message.type === "query") {
      if (busy) return;
      busy = true;
      try {
        const nodes = [...figma.currentPage.selection];
        const info = describeSelection(nodes);
        if (info.kind === "invalid") throw new Error(info.label);
        anchor = captureAnchor(nodes);
        if (info.kind === "text") {
          const texts = selectedTextNodes(nodes)
            .map((n) => n.characters?.trim() || "")
            .filter(Boolean);
          if (texts.length > 50 || texts.join("\n").length > 12000)
            throw new Error(
              "Select up to 50 text layers with at most 12,000 characters.",
            );
          figma.ui.postMessage({
            type: "query",
            requestId: message.requestId,
            query: { kind: "text", texts },
          });
        } else {
          // Export the visible crop and transforms, not the original un-cropped fill.
          const node = nodes[0];
          const referenceId = node.getPluginData("tasteReferenceId");
          const paints = "fills" in node && Array.isArray(node.fills) ? node.fills : [];
          const unchanged = paints.length === 1 && paints[0].type === "IMAGE" &&
            paints[0].scaleMode === "FIT" &&
            paints[0].imageHash === node.getPluginData("tasteImageHash") &&
            "rotation" in node && node.rotation === 0 && "effects" in node && node.effects.length === 0;
          if (referenceId && unchanged) {
            figma.ui.postMessage({ type: "query", requestId: message.requestId,
              query: { kind: "reference", id: referenceId } });
            return;
          }
          const bytes = await node.exportAsync({
            format: "PNG",
            constraint: {
              type: "SCALE",
              value: Math.min(1, 1024 / Math.max(node.width, node.height)),
            },
          });
          if (bytes.length > 8 * 1024 * 1024)
            throw new Error(
              "This image is too large. Try a smaller selection.",
            );
          figma.ui.postMessage({
            type: "query",
            requestId: message.requestId,
            query: { kind: "image", bytes, excludeId: node.getPluginData("tasteReferenceId") || undefined },
          });
        }
      } finally {
        busy = false;
      }
      return;
    }
    if (message.type === "insert") {
      if (busy) return;
      busy = true;
      const created: RectangleNode[] = [];
      try {
        const images = message.images as InsertImage[];
        if (!Array.isArray(images) || !images.length || images.length > 24)
          throw new Error("Choose between 1 and 24 images.");
        const target = anchor;
        if (!target || target.page.removed || target.page !== figma.currentPage)
          throw new Error("Return to the search’s page, or run a new search.");
        const loaded = [];
        for (const image of images) {
          const bytes = new Uint8Array(image.bytes);
          if (!bytes.length || bytes.length > 20 * 1024 * 1024)
            throw new Error("Invalid image size.");
          const fill = figma.createImage(bytes);
          loaded.push({ image, fill, size: await fill.getSizeAsync() });
        }
        const positions = gridPositions(loaded.map((i) => i.size));
        for (let i = 0; i < loaded.length; i++) {
          const { image, fill } = loaded[i];
          const pos = positions[i];
          const node = figma.createRectangle();
          created.push(node);
          node.name = image.name;
          node.resize(pos.width, pos.height);
          node.fills = [
            { type: "IMAGE", imageHash: fill.hash, scaleMode: "FIT" },
          ];
          node.setPluginData("tasteReferenceId", image.id);
          node.setPluginData("tasteImageHash", fill.hash);
          target.page.appendChild(node);
          node.x = target.x + pos.x;
          node.y = target.y + pos.y;
        }
        target.page.selection = created;
        figma.viewport.scrollAndZoomIntoView(created);
        figma.commitUndo();
        target.x += Math.max(...positions.map((p) => p.x + p.width)) + 48;
        figma.ui.postMessage({ type: "inserted", count: created.length });
        figma.notify(
          `Added ${created.length} image${created.length === 1 ? "" : "s"}`,
        );
      } catch (error) {
        for (const node of created) if (!node.removed) node.remove();
        throw error;
      } finally {
        busy = false;
      }
    }
  } catch (error) {
    figma.ui.postMessage({
      type: "error",
      requestId: message.requestId,
      message: error instanceof Error ? error.message : "Something went wrong.",
    });
  }
};
