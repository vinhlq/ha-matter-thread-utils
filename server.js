// Production HTTPS server for ha-matter-thread-utils.
// Serves the built Vite app, proxies /ws to matter-server, handles firmware uploads.

import https from 'node:https';
import { readFileSync, existsSync, rmdirSync, mkdtempSync, writeFileSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, extname, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import Busboy from 'busboy';
import { WebSocket, WebSocketServer } from 'ws';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, 'dist');

const PORT          = parseInt(process.env.PORT          ?? '5173');
const MATTER_WS_URL = process.env.MATTER_WS_URL          ?? 'ws://127.0.0.1:5580';
const OTA_CONTAINER = process.env.OTA_CONTAINER          ?? 'matter-server';
const OTA_DIR       = process.env.OTA_DIR                ?? '/data/updates';
const CERT_FILE     = process.env.CERT_FILE              ?? '/certs/cert.pem';
const KEY_FILE      = process.env.KEY_FILE               ?? '/certs/key.pem';
const PUSH_THREAD   = process.env.PUSH_THREAD_SCRIPT     ?? '';

const MIME = {
  '.html':  'text/html; charset=utf-8',
  '.js':    'text/javascript',
  '.mjs':   'text/javascript',
  '.css':   'text/css',
  '.json':  'application/json',
  '.png':   'image/png',
  '.svg':   'image/svg+xml',
  '.ico':   'image/x-icon',
  '.wasm':  'application/wasm',
  '.woff':  'font/woff',
  '.woff2': 'font/woff2',
};

// ---- helpers ----

function runDocker(...args) {
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout: 120_000 });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout || `docker ${args[0]} failed`);
  return r.stdout;
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// ---- firmware upload handler ----

function handleFirmwareUpload(req, res) {
  if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }

  let bb;
  try {
    bb = Busboy({ headers: req.headers, limits: { fileSize: 100 * 1024 * 1024 } });
  } catch {
    sendJson(res, 400, { error: 'Expected multipart/form-data upload' });
    return;
  }

  let otaBuffer = null;
  let otaFilename = 'firmware.ota';
  const fields = {};

  bb.on('file', (_n, stream, info) => {
    otaFilename = info.filename || 'firmware.ota';
    const chunks = [];
    stream.on('data', c => chunks.push(c));
    stream.on('end', () => { otaBuffer = Buffer.concat(chunks); });
  });
  bb.on('field', (name, val) => { fields[name] = val; });

  bb.on('finish', () => {
    if (!otaBuffer) { sendJson(res, 400, { error: 'No OTA file received' }); return; }

    const vid      = parseInt(fields.vid);
    const pid      = parseInt(fields.pid);
    const swVer    = parseInt(fields.softwareVersion);
    const swVerStr = (fields.softwareVersionString || '').trim();
    const minVer   = parseInt(fields.minApplicableSoftwareVersion ?? '0');
    const maxVer   = parseInt(fields.maxApplicableSoftwareVersion ?? String(swVer - 1));

    if (!vid || !pid || !swVer || !swVerStr) {
      sendJson(res, 400, { error: 'Missing required fields: vid, pid, softwareVersion, softwareVersionString' });
      return;
    }

    try {
      const sha256 = createHash('sha256').update(otaBuffer).digest('base64');

      const tmpDir = mkdtempSync(join(tmpdir(), 'matter-ota-'));
      const tmpOta = join(tmpDir, otaFilename);
      writeFileSync(tmpOta, otaBuffer);

      runDocker('exec', OTA_CONTAINER, 'mkdir', '-p', OTA_DIR);
      runDocker('cp', tmpOta, `${OTA_CONTAINER}:${OTA_DIR}/${otaFilename}`);
      unlinkSync(tmpOta);

      const descriptor = {
        modelVersion: {
          vid, pid,
          softwareVersion: swVer,
          softwareVersionString: swVerStr,
          otaUrl: `file://${OTA_DIR}/${otaFilename}`,
          otaChecksum: sha256,
          otaChecksumType: 1,
          minApplicableSoftwareVersion: minVer,
          maxApplicableSoftwareVersion: maxVer,
          softwareVersionValid: true,
          firmwareInformation: null,
          releaseNotesUrl: fields.releaseNotesUrl || null,
        },
      };
      const jsonName = `${vid}_${pid}_v${swVer}.json`;
      const tmpJson  = join(tmpDir, jsonName);
      writeFileSync(tmpJson, JSON.stringify(descriptor, null, 2));
      runDocker('cp', tmpJson, `${OTA_CONTAINER}:${OTA_DIR}/${jsonName}`);
      unlinkSync(tmpJson);
      try { rmdirSync(tmpDir); } catch {}

      runDocker('restart', OTA_CONTAINER);

      if (PUSH_THREAD) {
        try { spawnSync('bash', [PUSH_THREAD], { encoding: 'utf8', timeout: 60_000 }); }
        catch (e) { console.warn('[upload] push-thread-dataset failed:', e.message); }
      }

      sendJson(res, 200, { ok: true, softwareVersion: swVer, softwareVersionString: swVerStr, filename: otaFilename });
    } catch (err) {
      console.error('[upload]', err.message);
      sendJson(res, 500, { error: err.message });
    }
  });

  bb.on('error', err => sendJson(res, 400, { error: err.message }));
  req.pipe(bb);
}

// ---- static file handler ----

function handleRequest(req, res) {
  const urlPath = (req.url ?? '/').split('?')[0];

  if (urlPath === '/api/upload-firmware') return handleFirmwareUpload(req, res);

  // Resolve path, prevent traversal outside dist/
  const rel = decodeURIComponent(urlPath).replace(/^\/+/, '');
  let filePath = resolve(DIST, rel);
  if (!filePath.startsWith(DIST + sep) && filePath !== DIST) {
    filePath = join(DIST, 'index.html');
  }

  // SPA fallback: no extension or missing file → index.html
  if (!existsSync(filePath) || !extname(filePath)) {
    filePath = join(DIST, 'index.html');
  }

  if (!existsSync(filePath)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream' });
  res.end(readFileSync(filePath));
}

// ---- HTTPS server ----

const server = https.createServer(
  { cert: readFileSync(CERT_FILE), key: readFileSync(KEY_FILE) },
  handleRequest,
);

// ---- WebSocket proxy: client /ws → matter-server ----

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if ((req.url ?? '').startsWith('/ws')) {
    wss.handleUpgrade(req, socket, head, (client) => {
      const upstream = new WebSocket(MATTER_WS_URL);

      const forward = (src, dst) =>
        src.on('message', (data, isBinary) => {
          if (dst.readyState === WebSocket.OPEN) dst.send(data, { binary: isBinary });
        });

      upstream.on('open', () => {
        forward(client, upstream);
        forward(upstream, client);
      });
      upstream.on('close',  ()  => client.close());
      upstream.on('error',  (e) => { console.error('[ws-proxy]', e.message); client.close(); });
      client.on('close',    ()  => upstream.close());
      client.on('error',    (e) => { console.error('[ws-client]', e.message); upstream.close(); });
    });
  } else {
    socket.destroy();
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[ha-matter-utils] HTTPS on :${PORT}`);
  console.log(`[ha-matter-utils] WebSocket proxy → ${MATTER_WS_URL}`);
});
