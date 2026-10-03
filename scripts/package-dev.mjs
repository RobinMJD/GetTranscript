import { cp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { zipSync, unzipSync } from "fflate";

// Reuse the permission and package checks of the Store packaging command.
await import("./package.mjs");
const version = JSON.parse(await readFile("package.json", "utf8")).version;
const source = unzipSync(
  await readFile(`release/gettranscript-v${version}-chromium-stores.zip`),
);
const name = `GetTranscript-Test-${version}`;
const destination = `release/${name}`;
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp("dist", destination, { recursive: true });
const manifest = JSON.parse(new TextDecoder().decode(source["manifest.json"]));
manifest.name = "GetTranscript — Test build";
manifest.version_name = `${version} local test`;
const manifestText = JSON.stringify(manifest, null, 2) + "\n";
source["manifest.json"] = new TextEncoder().encode(manifestText);
await writeFile(`${destination}/manifest.json`, manifestText);
const instructions = await readFile("docs/TESTING.md", "utf8");
await writeFile(`${destination}/TESTING.md`, instructions);
source["TESTING.md"] = new TextEncoder().encode(instructions);
const files = Object.fromEntries(
  Object.entries(source).map(([file, bytes]) => [
    `${name}/${file}`,
    [bytes, { mtime: new Date(2026, 0, 1) }],
  ]),
);
const zip = zipSync(files, { level: 9 });
const path = `release/gettranscript-v${version}-unpacked.zip`;
await writeFile(path, zip);
console.log(
  `Load unpacked: ${destination}\n${path}\nSHA-256 ${createHash("sha256").update(zip).digest("hex")}`,
);
