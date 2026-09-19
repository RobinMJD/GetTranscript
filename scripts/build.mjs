import { build } from "vite";
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import sharp from "sharp";
const icon = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><defs><linearGradient id="b" x2="1" y2="1"><stop stop-color="#3488ff"/><stop offset="1" stop-color="#1556ee"/></linearGradient></defs><rect width="128" height="128" rx="28" fill="url(#b)"/><path d="M70 26H34a5 5 0 0 0-5 5v62a5 5 0 0 0 5 5h37V47L70 26Z" fill="white"/><path d="m70 26 22 21H70Z" fill="#d8e7ff"/><path d="M42 47h17M42 59h25M42 71h18" stroke="#2563eb" stroke-width="6" stroke-linecap="round"/><path d="M90 65v36m-14-13 14 14 14-14" fill="none" stroke="white" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
await mkdir("public/icons", { recursive: true });
await writeFile("public/icons/icon.svg", icon);
for (const size of [16, 32, 48, 128])
  await sharp(Buffer.from(icon))
    .resize(size, size)
    .png()
    .toFile(`public/icons/icon${size}.png`);
await build();
await copyFile("LICENSE", "dist/LICENSE.txt");
const reactLicense = await readFile("node_modules/react/LICENSE", "utf8");
await writeFile(
  "dist/THIRD_PARTY_NOTICES.txt",
  "CueKit includes React and React DOM.\n\n" + reactLicense,
);
console.log("Built CueKit for Chromium.");
