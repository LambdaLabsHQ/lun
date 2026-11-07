/**
 * Builds the playground into playground/dist, or serves it while you work on it.
 *
 *     node playground/build.ts                 # build for deployment
 *     node playground/build.ts --serve [port]  # serve, and rebuild and reload on every change
 *
 * Files are named by their content's hash, so a browser never mixes a new
 * page with old scripts. The checking worker is built first, so the page can
 * name it.
 */
import * as esbuild from "esbuild";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = join(here, "..");
const dist = join(here, "dist");
const examplesDirectory = join(root, "examples");

/** `import examples from "norn:examples"`: every program in examples/, read when the bundle is built. */
const examples: esbuild.Plugin = {
  name: "norn-examples",
  setup(build) {
    build.onResolve({ filter: /^norn:examples$/ }, () => ({ path: "examples", namespace: "norn-examples" }));
    build.onLoad({ filter: /.*/, namespace: "norn-examples" }, () => {
      const files = readdirSync(examplesDirectory).filter((file) => file.endsWith(".norn")).sort();
      const list = files.map((file) => ({ file, source: readFileSync(join(examplesDirectory, file), "utf8") }));
      return {
        contents: `export default ${JSON.stringify(list)};`,
        loader: "js",
        watchDirs: [examplesDirectory],
        watchFiles: files.map((file) => join(examplesDirectory, file)),
      };
    });
  },
};

function options(hashed: boolean, liveReload: boolean, checkWorker: string): esbuild.BuildOptions & { metafile: true } {
  return {
    absWorkingDir: root,
    bundle: true,
    format: "esm",
    // Module workers and top-level await: current Chrome, Edge, Firefox and Safari.
    target: ["chrome109", "edge109", "firefox115", "safari16.4"],
    platform: "browser",
    loader: { ".norn": "text" },
    plugins: [examples],
    define: { CHECK_WORKER: JSON.stringify(checkWorker), LIVE_RELOAD: String(liveReload) },
    outdir: dist,
    entryNames: hashed ? "[name]-[hash]" : "[name]",
    minify: hashed,
    sourcemap: "linked",
    metafile: true,
    logLevel: "warning",
  };
}

/** The output file an entry point became. */
function output(result: esbuild.BuildResult<{ metafile: true }>, entry: string): string {
  const found = Object.entries(result.metafile.outputs).find(([, meta]) => meta.entryPoint === entry);
  if (found === undefined) throw new Error(`no output for ${entry}`);
  return basename(found[0]);
}

function page(scripts: { styles: string; main: string }): void {
  const html = readFileSync(join(here, "index.html"), "utf8")
    .replace('href="styles.css"', `href="${scripts.styles}"`)
    .replace('src="main.js"', `src="${scripts.main}"`);
  writeFileSync(join(dist, "index.html"), html);
  copyFileSync(join(here, "favicon.svg"), join(dist, "favicon.svg"));
}

const entries = {
  worker: { "check-worker": "playground/src/check-worker.ts" },
  page: { main: "playground/src/main.ts", styles: "playground/styles.css" },
};

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

if (process.argv.includes("--serve")) {
  const port = Number(process.argv[process.argv.indexOf("--serve") + 1]) || 8000;
  page({ styles: "styles.css", main: "main.js" });
  const context = await esbuild.context({ ...options(false, true, "check-worker.js"), entryPoints: { ...entries.worker, ...entries.page } });
  await context.watch();
  const { hosts } = await context.serve({ servedir: dist, port });
  console.log(`Serving the playground at http://${hosts[0] === "0.0.0.0" ? "localhost" : hosts[0]}:${port}/ (Ctrl-C stops)`);
} else {
  const worker = await esbuild.build({ ...options(true, false, ""), entryPoints: entries.worker });
  const workerFile = output(worker, entries.worker["check-worker"]);
  const built = await esbuild.build({ ...options(true, false, workerFile), entryPoints: entries.page });
  page({ styles: output(built, entries.page.styles), main: output(built, entries.page.main) });
  for (const file of readdirSync(dist).filter((name) => !name.endsWith(".map")).sort()) {
    console.log(`${relative(root, join(dist, file)).padEnd(44)} ${(statSync(join(dist, file)).size / 1024).toFixed(1).padStart(7)} KiB`);
  }
}
