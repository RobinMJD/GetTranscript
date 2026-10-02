import { defineConfig } from "vite";
export default defineConfig({
  base: "./",
  build: {
    outDir: "dist",
    sourcemap: false,
    target: "chrome120",
    rollupOptions: {
      input: { popup: "index.html", collection: "collection.html" },
    },
  },
});
