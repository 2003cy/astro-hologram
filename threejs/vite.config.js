import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vite";

const DATA_DIR = path.resolve(__dirname, "..", "data");
const REQUIRED_SCENE_ASSETS = [
  "scene_config.json",
  "stars.json",
  "stars_atlas.png",
  "nebula.png",
  "nebula_signal.png",
  "nebula_meta.json",
];

function sceneDisplayName(id, exportDir) {
  try {
    const config = JSON.parse(
      fs.readFileSync(path.join(exportDir, "scene_config.json"), "utf8"),
    );
    if (typeof config.scene_name === "string" && config.scene_name.trim()) {
      return config.scene_name.trim();
    }
  } catch {
    // A malformed config is reported by the browser when that scene is loaded.
  }
  return id.replace(/[-_]+/g, " ").replace(/\b\w/g, char => char.toUpperCase());
}

function discoverScenes() {
  if (!fs.existsSync(DATA_DIR)) return [];
  return fs.readdirSync(DATA_DIR, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => {
      const exportDir = path.join(DATA_DIR, entry.name, "export");
      return {
        id: entry.name,
        name: sceneDisplayName(entry.name, exportDir),
        exportDir,
      };
    })
    .filter(scene => REQUIRED_SCENE_ASSETS.every(file => {
      const assetPath = path.join(scene.exportDir, file);
      return fs.existsSync(assetPath) && fs.statSync(assetPath).isFile();
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function exportFiles(directory, root = directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return exportFiles(absolutePath, root);
    return [{
      absolutePath,
      relativePath: path.relative(root, absolutePath).replaceAll("\\", "/"),
    }];
  });
}

function sceneAssetsPlugin() {
  const scenes = discoverScenes();
  const manifest = JSON.stringify({
    scenes: scenes.map(({ id, name }) => ({ id, name })),
  });

  return {
    name: "astro-scene-assets",

    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const requestPath = decodeURIComponent(
          new URL(request.url, "http://localhost").pathname,
        );
        if (requestPath === "/scenes/manifest.json") {
          response.setHeader("Content-Type", "application/json; charset=utf-8");
          response.end(manifest);
          return;
        }

        const match = requestPath.match(/^\/scenes\/([^/]+)\/(.+)$/);
        if (!match) {
          next();
          return;
        }
        const scene = scenes.find(candidate => candidate.id === match[1]);
        if (!scene) {
          next();
          return;
        }

        const exportRoot = path.resolve(scene.exportDir);
        const assetPath = path.resolve(exportRoot, match[2]);
        if (
          !assetPath.startsWith(`${exportRoot}${path.sep}`)
          || !fs.existsSync(assetPath)
          || !fs.statSync(assetPath).isFile()
        ) {
          next();
          return;
        }

        const mimeTypes = {
          ".json": "application/json; charset=utf-8",
          ".png": "image/png",
          ".jpg": "image/jpeg",
          ".jpeg": "image/jpeg",
          ".webp": "image/webp",
        };
        response.setHeader(
          "Content-Type",
          mimeTypes[path.extname(assetPath).toLowerCase()] ?? "application/octet-stream",
        );
        fs.createReadStream(assetPath).pipe(response);
      });
    },

    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "scenes/manifest.json",
        source: manifest,
      });
      for (const scene of scenes) {
        for (const file of exportFiles(scene.exportDir)) {
          this.emitFile({
            type: "asset",
            fileName: `scenes/${scene.id}/${file.relativePath}`,
            source: fs.readFileSync(file.absolutePath),
          });
        }
      }
    },
  };
}

export default defineConfig({
  // Relative paths allow the built demo to run from a GitHub Pages repo subpath.
  base: "./",
  root: path.resolve(__dirname),
  // Only data/<scene>/export is published; raw FITS/parquet inputs stay private.
  publicDir: false,
  plugins: [sceneAssetsPlugin()],
  server: {
    host: "0.0.0.0",
    port: 4173,
    open: true,
  },
});
