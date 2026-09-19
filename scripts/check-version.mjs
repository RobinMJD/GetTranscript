import { readFileSync } from "node:fs";
const version = JSON.parse(readFileSync("package.json", "utf8")).version;
const manifest = JSON.parse(readFileSync("public/manifest.json", "utf8"));
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
if (
  !/^\d+\.\d+\.\d+$/.test(version) ||
  version !== manifest.version ||
  version !== lock.version ||
  version !== lock.packages[""].version
)
  throw new Error("Extension version fields are inconsistent.");
if (process.argv[2] && process.argv[2] !== `v${version}`)
  throw new Error("Release tag does not match the extension version.");
if (
  !readFileSync("public/help.html", "utf8").includes(`GetTranscript ${version}`)
)
  throw new Error("Help version is stale.");
if (
  !readFileSync("README.md", "utf8").includes(
    `Current version: **v${version}**`,
  )
)
  throw new Error("README version is stale.");
console.log(`Version synchronized: ${version}`);
