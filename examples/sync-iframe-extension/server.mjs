/**
 * Dual-origin dev server for the cross-origin iframe broker example.
 *
 * - localhost:3000  → parent page (the "host" origin)
 * - localhost:3001  → iframe + worker (the "extension" origin)
 *
 * Both origins serve Cross-Origin-Opener-Policy + Cross-Origin-Embedder-Policy
 * headers so every context in the chain is crossOriginIsolated — required for
 * SharedArrayBuffer (which powers sync RPC).
 *
 * The server also maps bare-specifier imports from the built mixed-signals
 * package and @preact/signals-core so the HTML files can use <script type="importmap">
 * without a bundler.
 */

import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve, extname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '../..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

// ── File mapping ────────────────────────────────────────────────────────
// Resolve URL paths to filesystem paths for each origin.

function resolveFile(port, urlPath) {
  // Built mixed-signals files — served from both origins
  if (urlPath.startsWith('/build/')) {
    return join(ROOT, urlPath);
  }

  // @preact/signals-core — served from both origins
  if (urlPath.startsWith('/vendor/signals-core.mjs')) {
    return join(ROOT, 'node_modules/@preact/signals-core/dist/signals-core.mjs');
  }

  // Parent origin (3000): only parent.html
  if (port === 3000) {
    if (urlPath === '/' || urlPath === '/parent.html') {
      return join(__dirname, 'parent.html');
    }
    return null;
  }

  // Extension origin (3001): iframe.html, worker.mjs
  if (port === 3001) {
    if (urlPath === '/' || urlPath === '/iframe.html') {
      return join(__dirname, 'iframe.html');
    }
    if (urlPath === '/worker.mjs') {
      return join(__dirname, 'worker.mjs');
    }
    return null;
  }

  return null;
}

// ── Request handler ─────────────────────────────────────────────────────

function handler(port) {
  return async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const filePath = resolveFile(port, url.pathname);

    if (!filePath) {
      res.writeHead(404, {'Content-Type': 'text/plain'});
      res.end('Not found');
      return;
    }

    try {
      let content = await readFile(filePath);
      const ext = extname(filePath);
      const mime = MIME[ext] ?? 'application/octet-stream';

      // Rewrite bare `@preact/signals-core` imports in built JS files
      // to the vendored URL. This is necessary because module workers
      // don't support import maps, so the built chunks that reference
      // `@preact/signals-core` must use a URL the browser can fetch.
      if (ext === '.js' || ext === '.mjs') {
        let text = content.toString('utf-8');
        if (text.includes('@preact/signals-core')) {
          text = text.replaceAll(
            '"@preact/signals-core"',
            '"/vendor/signals-core.mjs"',
          );
          content = Buffer.from(text, 'utf-8');
        }
      }

      res.writeHead(200, {
        'Content-Type': mime,
        // ── Cross-Origin Isolation ────────────────────────────────
        // Both origins MUST serve these for crossOriginIsolated = true.
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
        // Allow cross-origin fetches of these resources by the other origin.
        'Cross-Origin-Resource-Policy': 'cross-origin',
      });
      res.end(content);
    } catch (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, {'Content-Type': 'text/plain'});
        res.end(`Not found: ${url.pathname}`);
      } else {
        res.writeHead(500, {'Content-Type': 'text/plain'});
        res.end(String(err));
      }
    }
  };
}

// ── Start both servers ──────────────────────────────────────────────────

const parentServer = createServer(handler(3000));
const iframeServer = createServer(handler(3001));

parentServer.listen(3000, () => {
  console.log('🏠 Parent (host)    → http://localhost:3000');
});

iframeServer.listen(3001, () => {
  console.log('📦 Iframe (extension) → http://localhost:3001');
  console.log();
  console.log('Open http://localhost:3000 in your browser to start the demo.');
});
