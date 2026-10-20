import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/**
 * @implNote Everything is inlined into one index.html because the server serves only that file;
 * the bundle runs on Node 20 in the image, which cannot strip TypeScript, hence a .mjs script.
 */
const uiDirectory = new URL("./", import.meta.url);
const outputFile = new URL("../public/index.html", import.meta.url);

const bundle = await build({
  entryPoints: [fileURLToPath(new URL("src/main.ts", uiDirectory))],
  bundle: true,
  format: "iife",
  target: "es2022",
  minify: true,
  write: false,
  charset: "utf8",
});

const template = await readFile(new URL("index.html", uiDirectory), "utf8");
const styles = await readFile(new URL("styles.css", uiDirectory), "utf8");
const script = bundle.outputFiles[0].text.replaceAll("</script", "<\\/script");
const page = template.replace("/*styles*/", () => styles).replace("/*script*/", () => script);

await mkdir(new URL("../public/", import.meta.url), { recursive: true });
await writeFile(outputFile, page, "utf8");
console.log(`wrote ${fileURLToPath(outputFile)} (${Math.round(page.length / 1024)} KB)`);
