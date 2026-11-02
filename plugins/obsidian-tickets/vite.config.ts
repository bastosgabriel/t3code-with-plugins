import * as NodeFSP from "node:fs/promises";
import { defineConfig } from "vite-plus";

const pythonSource = {
  name: "python-source",
  async load(id: string) {
    if (id.endsWith(".py?raw"))
      return `export default ${JSON.stringify(await NodeFSP.readFile(id.slice(0, -4), "utf8"))};`;
  },
};

export default defineConfig({
  pack: { entry: ["src/index.ts"], outDir: "dist", format: "esm", plugins: [pythonSource] },
  test: { include: ["src/**/*.test.ts"] },
});
