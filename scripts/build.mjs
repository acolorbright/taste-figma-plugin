import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
const api = process.env.TASTE_API_URL || "https://taste-figma-search.fly.dev";
const url = new URL(api);
// Figma accepts localhost for development but rejects numeric loopback URLs.
if (url.hostname === "127.0.0.1") url.hostname = "localhost";
if (
  url.pathname !== "/" ||
  url.search ||
  url.hash ||
  url.username ||
  url.password
)
  throw new Error(
    "TASTE_API_URL must be an origin without a path or credentials.",
  );
const local = ["localhost", "127.0.0.1"].includes(url.hostname);
if (url.protocol !== "https:" && !(local && url.protocol === "http:"))
  throw new Error("Use HTTPS for a shared server.");
await mkdir("dist", { recursive: true });
await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  outfile: "dist/code.js",
  target: "es2017",
});
const ui = await build({
  entryPoints: ["src/ui.ts"],
  bundle: true,
  write: false,
  target: "es2020",
  define: { __API_URL__: JSON.stringify(url.origin) },
});
// Bundle the recommended community components locally. Figma supplies theme
// colors; use installed/system fonts instead of DS's external font requests.
const componentCss = (
  await readFile(
    "node_modules/figma-plugin-ds/dist/figma-plugin-ds.css",
    "utf8",
  )
).replace(/@font-face\s*\{[^}]*\}/g, "");
const html = (await readFile("src/ui.html", "utf8"))
  .replace("<!-- COMPONENT_STYLES -->", () => `<style>${componentCss}</style>`)
  .replace(
    "<!-- SCRIPT -->",
    () => `<script>${ui.outputFiles[0].text}</script>`,
  );
await writeFile("dist/ui.html", html);
await writeFile(
  "dist/THIRD_PARTY_LICENSES.txt",
  "Figma Plugin DS — Thomas Lowry\n\n" +
    (await readFile("node_modules/figma-plugin-ds/LICENSE", "utf8")),
);
await writeFile(
  "dist/manifest.json",
  JSON.stringify(
    {
      name: "Taste — image search",
      id: process.env.FIGMA_PLUGIN_ID || "taste-private-dev",
      api: "1.0.0",
      main: "code.js",
      ui: "ui.html",
      editorType: ["figma", "figjam"],
      documentAccess: "dynamic-page",
      networkAccess: {
        allowedDomains: local ? ["none"] : [url.origin],
        devAllowedDomains: local ? [url.origin] : ["http://localhost:8765"],
        reasoning:
          "Search the private Taste reference library and download selected images.",
      },
    },
    null,
    2,
  ),
);
await writeFile("dist/SETUP.txt", `Taste — image search

1. Unzip this folder and keep it in a permanent location.
2. In Figma Desktop: Plugins > Development > Import plugin from manifest.
3. Choose manifest.json from this folder.
4. Run Taste — image search and enter the team access key supplied separately.
   The key is remembered on this device.
5. Select an image, text layers, or FigJam sticky notes to search automatically. Select results and insert.

Service: ${url.origin}
${local ? "This build requires the local Taste service." : "No local server or image library is needed."}

This is a private development distribution, not a published Figma listing.
`);
console.log(`Built dist/manifest.json (search service: ${url.origin})`);
