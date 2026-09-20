import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { zipSync, unzipSync } from "fflate";
import { createHash } from "node:crypto";
import { posix } from "node:path";
const version = JSON.parse(await readFile("package.json", "utf8")).version;
const files = {};
async function walk(dir, prefix = "") {
  for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    const name = posix.join(prefix, e.name);
    if (e.isDirectory()) await walk(`${dir}/${e.name}`, name);
    else {
      if (e.isSymbolicLink() || /\.map$|(^|\/)\.|\.local\./.test(name))
        throw new Error(`Unexpected package file: ${name}`);
      files[name] = [
        new Uint8Array(await readFile(`${dir}/${e.name}`)),
        { mtime: new Date(2026, 0, 1, 0, 0, 0) },
      ];
    }
  }
}
await walk("dist");
const zip = zipSync(files, { level: 9 });
const contents = unzipSync(zip);
const manifest = JSON.parse(
  new TextDecoder().decode(contents["manifest.json"]),
);
if (manifest.version !== version || manifest.manifest_version !== 3)
  throw new Error("Manifest version mismatch.");
if (manifest.short_name && manifest.short_name.length > 12)
  throw new Error(
    "The compact extension label exceeds the Store limit of 12 characters.",
  );
if (
  manifest.background?.service_worker !== "background.js" ||
  manifest.background?.type !== "module"
)
  throw new Error("Missing background session worker.");
const expected = ["activeTab", "downloads", "scripting", "storage"];
if (
  JSON.stringify([...manifest.permissions].sort()) !== JSON.stringify(expected)
)
  throw new Error("Unexpected permissions.");
if (
  manifest.host_permissions ||
  manifest.content_scripts ||
  manifest.externally_connectable
)
  throw new Error("Persistent website access is not part of this release.");
for (const file of [
  "index.html",
  "background.js",
  "help.html",
  "LICENSE.txt",
  "THIRD_PARTY_NOTICES.txt",
  "icons/icon128.png",
])
  if (!contents[file]) throw new Error(`Missing ${file}`);
for (const [name, bytes] of Object.entries(contents)) {
  if (
    name.endsWith(".js") &&
    /Weekly project sync|Alex Morgan|Jordan Lee/.test(
      new TextDecoder().decode(bytes),
    )
  )
    throw new Error("Demo data leaked into the production bundle.");
}
await mkdir("release", { recursive: true });
const path = `release/gettranscript-v${version}-chromium-stores.zip`;
await writeFile(path, zip);
console.log(
  `${path}\nSHA-256 ${createHash("sha256").update(zip).digest("hex")}\n${Object.keys(contents).length} verified files, ${zip.length} bytes`,
);
