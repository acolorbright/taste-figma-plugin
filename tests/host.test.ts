import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import vm from "node:vm";
const output = await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  write: false,
  target: "es2017",
});
function host() {
  const messages: any[] = [];
  const nodes: any[] = [];
  let commits = 0;
  const page: any = {
    type: "PAGE",
    removed: false,
    selection: [],
    appendChild(n: any) {
      n.parent = page;
    },
  };
  const figma: any = {
    currentPage: page,
    ui: {
      postMessage(m: any) {
        messages.push(m);
      },
    },
    viewport: { center: { x: 0, y: 0 }, scrollAndZoomIntoView() {} },
    showUI() {},
    on() {},
    notify() {},
    commitUndo() {
      commits++;
    },
    createImage(bytes: Uint8Array) {
      if (bytes[0] === 0) throw new Error("bad image");
      return {
        hash: "test",
        getSizeAsync: async () => ({ width: 200, height: 100 }),
      };
    },
  };
  const make = () => {
    const n: any = {
      removed: false,
      parent: page,
      width: 0,
      height: 0,
      resize(w: number, h: number) {
        this.width = w;
        this.height = h;
      },
      remove() {
        this.removed = true;
      },
      pluginData: {},
      setPluginData(key: string, value: string) { this.pluginData[key] = value; },
      getPluginData(key: string) { return this.pluginData[key] || ""; },
      appendChild(child: any) {
        child.parent = this;
      },
    };
    nodes.push(n);
    return n;
  };
  figma.createFrame = () => { throw new Error("Insertion must not create a frame"); };
  figma.createRectangle = make;
  vm.runInNewContext(output.outputFiles[0].text, {
    figma,
    __html__: "",
    Uint8Array,
  });
  return {
    figma,
    page,
    messages,
    nodes,
    commits: () => commits,
    send: (m: any) => figma.ui.onmessage(m),
  };
}
test("text query preserves separate layers and insertion stays anchored after selection changes", async () => {
  const h = host();
  h.page.selection = [
    {
      type: "TEXT",
      name: "a",
      characters: "Editorial",
      parent: h.page,
      absoluteBoundingBox: { x: 10, y: 20, width: 100, height: 50 },
    },
    {
      type: "TEXT",
      name: "b",
      characters: "Bold",
      parent: h.page,
      absoluteBoundingBox: { x: 10, y: 100, width: 100, height: 50 },
    },
  ];
  await h.send({ type: "query", requestId: 1 });
  assert.deepEqual(Array.from(h.messages[0].query.texts), [
    "Editorial",
    "Bold",
  ]);
  h.page.selection = [];
  await h.send({
    type: "insert",
    images: [
      { id: "1", name: "A", bytes: new Uint8Array([1]) },
      { id: "2", name: "B", bytes: new Uint8Array([1]) },
    ],
  });
  assert.equal(h.nodes.length, 2);
  assert.equal(h.nodes[0].name, "A");
  assert.equal(h.nodes[0].x, 158);
  assert.equal(h.nodes[0].y, 20);
  assert.equal(h.nodes[0].parent, h.page);
  assert.equal(h.nodes[1].parent, h.page);
  assert.equal(h.nodes[1].height, 160);
  assert.equal(h.nodes[1].x, 158 + 344);
  assert.equal(h.page.selection.length, 2);
  assert.equal(h.page.selection[0], h.nodes[0]);
  assert.equal(h.page.selection[1], h.nodes[1]);
  assert.equal(h.commits(), 1);
  assert.equal(h.messages.at(-1).type, "inserted");
});
test("a single inserted image becomes the next image-search source", async () => {
  const h = host();
  h.page.selection = [
    { type: "TEXT", name: "Prompt", characters: "Gradient", parent: h.page },
  ];
  await h.send({ type: "query", requestId: 1 });
  await h.send({ type: "insert", images: [
    { id: "1", name: "Gradient image", bytes: new Uint8Array([1]) },
  ] });
  const image = h.nodes[0];
  assert.equal(h.page.selection[0], image);
  await h.send({ type: "ready" });
  assert.equal(h.messages.at(-1).selection.kind, "image");
  image.exportAsync = async () => new Uint8Array([1, 2]);
  await h.send({ type: "query", requestId: 2 });
  assert.equal(h.messages.at(-1).query.kind, "image");
  assert.equal(h.messages.at(-1).query.excludeId, "1");
  image.rotation = 0;
  image.effects = [];
  image.exportAsync = async () => { throw new Error("Unchanged references should not be uploaded"); };
  await h.send({ type: "query", requestId: 3 });
  assert.equal(h.messages.at(-1).query.kind, "reference");
  assert.equal(h.messages.at(-1).query.id, "1");
});
test("image query exports the visible layer at a bounded resolution", async () => {
  const h = host();
  let settings: any;
  h.page.selection = [
    {
      type: "RECTANGLE",
      name: "photo",
      fills: [{ type: "IMAGE", imageHash: "x" }],
      width: 4000,
      height: 2000,
      parent: h.page,
      getPluginData: () => "",
      exportAsync: async (options: any) => {
        settings = options;
        return new Uint8Array([1, 2]);
      },
    },
  ];
  await h.send({ type: "query", requestId: 2 });
  assert.equal(settings.format, "PNG");
  assert.equal(settings.constraint.value, 1024 / 4000);
  assert.equal(h.messages[0].query.kind, "image");
});
test("page switches and invalid downloads never create partial artboards", async () => {
  const h = host();
  h.page.selection = [
    { type: "TEXT", name: "a", characters: "Text", parent: h.page },
  ];
  await h.send({ type: "query" });
  const images = [
    { id: "1", name: "A", bytes: new Uint8Array([1]) },
    { id: "2", name: "B", bytes: new Uint8Array([0]) },
  ];
  await h.send({ type: "insert", images });
  assert.equal(h.nodes.length, 0);
  assert.equal(h.messages.at(-1).type, "error");
  h.figma.currentPage = { ...h.page };
  await h.send({ type: "insert", images: images.slice(0, 1) });
  assert.equal(h.nodes.length, 0);
  assert.match(h.messages.at(-1).message, /Return to/);
});

test("selected text components export their nested text as a text query", async () => {
  const h = host();
  h.page.selection = [
    {
      type: "INSTANCE",
      name: "Your legal AI-ssistant",
      parent: h.page,
      children: [
        {
          type: "FRAME",
          name: "Wrapper",
          children: [
            {
              type: "TEXT",
              name: "Headline",
              characters: "Your legal AI-ssistant",
            },
            {
              type: "TEXT",
              name: "Subtitle",
              characters: "Less administration. More law.",
            },
          ],
        },
      ],
    },
  ];
  await h.send({ type: "ready" });
  assert.equal(h.messages[0].selection.kind, "text");
  assert.equal(h.messages[0].selection.count, 2);
  await h.send({ type: "query", requestId: 1 });
  assert.equal(h.messages[1].query.kind, "text");
  assert.deepEqual(Array.from(h.messages[1].query.texts), [
    "Your legal AI-ssistant",
    "Less administration. More law.",
  ]);
});

test("shapes with text export their text sublayer alongside ordinary text", async () => {
  const h = host();
  h.page.selection = [
    {
      type: "SHAPE_WITH_TEXT",
      name: "Shape name must not become the query",
      text: { characters: "Your legal AI-ssistant" },
      parent: h.page,
    },
    {
      type: "TEXT",
      name: "Subtitle",
      characters: "Less administration. More law.",
      parent: h.page,
    },
  ];
  await h.send({ type: "ready" });
  assert.equal(h.messages[0].selection.kind, "text");
  assert.equal(h.messages[0].selection.count, 2);
  await h.send({ type: "query", requestId: 1 });
  assert.deepEqual(Array.from(h.messages[1].query.texts), [
    "Your legal AI-ssistant",
    "Less administration. More law.",
  ]);
});
