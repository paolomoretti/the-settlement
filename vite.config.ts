import { defineConfig, type Plugin } from 'vite';
import path from 'path';
import fs from 'fs';

const ASSET_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

/**
 * Serve and ship repo-root `assets/` at URL `/assets/*`.
 * Game art lives only under `assets/` — never duplicate sprites under `public/`.
 */
function projectAssetsFromRoot(root: string): Plugin {
  const assetsRoot = path.resolve(root, 'assets');
  let outDir = path.resolve(root, 'dist');

  const isUnderAssets = (resolvedFile: string): boolean => {
    const rel = path.relative(assetsRoot, resolvedFile);
    return rel !== '' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
  };

  return {
    name: 'project-root-assets',
    enforce: 'pre',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        try {
          const pathname = (req.url ?? '').split('?')[0] ?? '';
          if (!pathname.startsWith('/assets/')) {
            next();
            return;
          }
          const diskPath = path.resolve(path.join(root, pathname.slice(1)));
          if (!isUnderAssets(diskPath)) {
            next();
            return;
          }
          if (!fs.existsSync(diskPath) || !fs.statSync(diskPath).isFile()) {
            next();
            return;
          }
          const ext = path.extname(diskPath).toLowerCase();
          res.setHeader('Content-Type', ASSET_MIME[ext] ?? 'application/octet-stream');
          fs.createReadStream(diskPath).pipe(res);
        } catch {
          next();
        }
      });
    },
    closeBundle() {
      if (!fs.existsSync(assetsRoot)) return;
      const destAssets = path.join(outDir, 'assets');
      fs.mkdirSync(destAssets, { recursive: true });
      for (const name of fs.readdirSync(assetsRoot)) {
        const src = path.join(assetsRoot, name);
        const dest = path.join(destAssets, name);
        fs.cpSync(src, dest, { recursive: true });
      }
    },
  };
}

export default defineConfig({
  plugins: [projectAssetsFromRoot(__dirname)],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 3000,
  },
  build: {
    target: 'esnext',
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        debug: path.resolve(__dirname, 'debug.html'),
      },
    },
  },
});
