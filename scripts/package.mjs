import { execFileSync } from "node:child_process";
execFileSync("zip", [
  "-j",
  "-q",
  "taste-figma-plugin.zip",
  "dist/manifest.json",
  "dist/code.js",
  "dist/ui.html",
  "dist/THIRD_PARTY_LICENSES.txt",
  "dist/SETUP.txt",
]);
console.log(
  "Created taste-figma-plugin.zip. It contains no access keys or library data.",
);
