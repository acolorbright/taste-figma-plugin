import { test } from "node:test";
import assert from "node:assert/strict";
import { describeSelection, gridPositions } from "../src/shared";
test("only nonempty text selections and one visible image fill are valid", () => {
  assert.equal(describeSelection([]).kind, "invalid");
  assert.equal(
    describeSelection([{ type: "TEXT", name: "a", characters: "  " }]).kind,
    "invalid",
  );
  assert.equal(
    describeSelection([
      { type: "TEXT", name: "a", characters: "Bold" },
      { type: "TEXT", name: "b", characters: "Editorial" },
    ]).kind,
    "text",
  );
  const image = {
    type: "RECTANGLE",
    name: "image",
    fills: [{ type: "IMAGE", imageHash: "a" }],
  };
  assert.equal(describeSelection([image]).kind, "image");
  assert.equal(describeSelection([image, image]).kind, "invalid");
  assert.equal(
    describeSelection([image, { type: "TEXT", name: "x", characters: "x" }])
      .kind,
    "invalid",
  );
  assert.equal(
    describeSelection([
      { ...image, fills: [{ type: "IMAGE", imageHash: "a", visible: false }] },
    ]).kind,
    "invalid",
  );
});
test("grid preserves aspect ratio and clears the tallest image in each row", () => {
  const grid = gridPositions([
    { width: 400, height: 200 },
    { width: 100, height: 300 },
    { width: 100, height: 100 },
    { width: 200, height: 100 },
  ]);
  assert.equal(grid[0].height, 160);
  assert.equal(grid[1].height, 960);
  assert.equal(grid[3].y, 984);
  assert.equal(grid[3].x, 0);
});

test("text in frames and instances is recognized, excluding hidden content", () => {
  const headline = {
    id: "headline",
    type: "TEXT",
    name: "Headline",
    characters: "Your legal AI-ssistant",
  };
  const instance = {
    type: "INSTANCE",
    name: "Your legal AI-ssistant",
    children: [
      { type: "RECTANGLE", name: "Background" },
      { type: "FRAME", name: "Wrapper", children: [headline] },
      {
        type: "TEXT",
        name: "Hidden text",
        characters: "Ignore",
        visible: false,
      },
    ],
  };
  assert.equal(describeSelection([instance]).kind, "text");
  assert.equal(describeSelection([instance]).count, 1);
  assert.equal(describeSelection([instance, headline]).count, 1);
  assert.equal(
    describeSelection([{ ...instance, children: [] }]).kind,
    "invalid",
  );
});

test("FigJam sticky notes use their text and ignore empty or hidden notes", () => {
  const note = { id: "note", type: "STICKY", name: "Note title", text: { characters: "Warm editorial photography" } };
  assert.equal(describeSelection([note]).kind, "text");
  assert.equal(describeSelection([{ ...note, text: { characters: "  " } }]).kind, "invalid");
  assert.equal(describeSelection([{ ...note, visible: false }]).kind, "invalid");
  assert.equal(describeSelection([{ type: "GROUP", name: "Notes", children: [note] }]).kind, "text");
  assert.equal(describeSelection([note, {type: "TEXT", name: "Caption", characters: "Natural textures"}]).count, 2);
});
