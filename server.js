// Production server for ha-matter-thread-utils.
// Serves the built Vite app, proxies /ws to matter-server, handles firmware uploads.
//
// Mode detection (automatic):
//   HA add-on  — /data/options.json exists → HTTP (HA ingress handles TLS)
//   Standalone — no options.json           → HTTPS if cert files are present

import http  from 'node:http';
import https from 'node:https';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join, extname, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import Busboy from 'busboy';
import { WebSocket, WebSocketServer } from 'ws';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, 'dist');

// ---- config: HA add-on options.json takes precedence over env vars ----

const HA_OPTIONS_FILE = '/data/options.json';
const IS_HA_ADDON     = existsSync(HA_OPTIONS_FILE);

let haOpts = {};
if (IS_HA_ADDON) {
  try { haOpts = JSON.parse(readFileSync(HA_OPTIONS_FILE, 'utf8')); }
  catch (e) { console.warn('[config] Could not read options.json:', e.message); }
}

function opt(haKey, envKey, fallback) {
  return haOpts[haKey] ?? process.env[envKey] ?? fallback;
}

const PORT           = parseInt(process.env.PORT ?? '5173');
const MATTER_WS_URL  = opt('matter_ws_url',  'MATTER_WS_URL',  'ws://127.0.0.1:5580');
const OTA_ADDON_SLUG = opt('ota_addon_slug', 'OTA_CONTAINER',  'core_matter_server');
// Path this container writes to (shared volume mount or addon_config).
const OTA_WRITE_DIR  = opt('ota_write_dir',  'OTA_WRITE_DIR',  IS_HA_ADDON ? '/config/updates' : '/matter-data/updates');
// Path matter-server sees for the same directory (used in otaUrl inside the descriptor).
const OTA_SERVER_DIR = opt('ota_server_dir', 'OTA_SERVER_DIR', IS_HA_ADDON ? '/config/updates' : '/data/updates');
const CERT_FILE      = process.env.CERT_FILE ?? '/certs/cert.pem';
const KEY_FILE       = process.env.KEY_FILE  ?? '/certs/key.pem';
const PUSH_THREAD    = opt('push_thread_script', 'PUSH_THREAD_SCRIPT', '');

// HA ingress handles TLS; standalone mode uses a self-signed cert.
const USE_HTTPS = !IS_HA_ADDON && existsSync(CERT_FILE) && existsSync(KEY_FILE);

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

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function restartMatterServer() {
  if (IS_HA_ADDON) {
    // Use HA Supervisor REST API — no Docker socket needed.
    const token = process.env.SUPERVISOR_TOKEN;
    if (!token) throw new Error('SUPERVISOR_TOKEN not set');
    const r = await fetch(`http://supervisor/addons/${OTA_ADDON_SLUG}/restart`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    if (!r.ok) throw new Error(`Supervisor restart failed: ${r.status} ${await r.text()}`);
  } else {
    const r = spawnSync('docker', ['restart', OTA_ADDON_SLUG], { encoding: 'utf8', timeout: 120_000 });
    if (r.status !== 0) throw new Error(r.stderr || r.stdout || 'docker restart failed');
  }
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

    (async () => {
      try {
        const sha256 = createHash('sha256').update(otaBuffer).digest('base64');

        mkdirSync(OTA_WRITE_DIR, { recursive: true });
        writeFileSync(join(OTA_WRITE_DIR, otaFilename), otaBuffer);

        const descriptor = {
          modelVersion: {
            vid, pid,
            softwareVersion: swVer,
            softwareVersionString: swVerStr,
            // otaUrl uses the path as matter-server sees it inside its own container.
            otaUrl: `file://${OTA_SERVER_DIR}/${otaFilename}`,
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
        writeFileSync(join(OTA_WRITE_DIR, jsonName), JSON.stringify(descriptor, null, 2));

        await restartMatterServer();

        if (PUSH_THREAD) {
          try { spawnSync('bash', [PUSH_THREAD], { encoding: 'utf8', timeout: 60_000 }); }
          catch (e) { console.warn('[upload] push-thread-dataset failed:', e.message); }
        }

        sendJson(res, 200, { ok: true, softwareVersion: swVer, softwareVersionString: swVerStr, filename: otaFilename });
      } catch (err) {
        console.error('[upload]', err.message);
        sendJson(res, 500, { error: err.message });
      }
    })();
  });

  bb.on('error', err => sendJson(res, 400, { error: err.message }));
  req.pipe(bb);
}

// ---- static file handler ----

function handleRequest(req, res) {
  const urlPath = (req.url ?? '/').split('?')[0];

  if (urlPath === '/api/upload-firmware') return handleFirmwareUpload(req, res);

  const rel = decodeURIComponent(urlPath).replace(/^\/+/, '');
  let filePath = resolve(DIST, rel);
  if (!filePath.startsWith(DIST + sep) && filePath !== DIST) {
    filePath = join(DIST, 'index.html');
  }
  if (!existsSync(filePath) || !extname(filePath)) {
    filePath = join(DIST, 'index.html');
  }
  if (!existsSync(filePath)) {
    res.writeHead(404); res.end('Not found'); return;
  }

  res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream' });
  res.end(readFileSync(filePath));
}

// ---- HTTP / HTTPS server ----

const server = USE_HTTPS
  ? https.createServer({ cert: readFileSync(CERT_FILE), key: readFileSync(KEY_FILE) }, handleRequest)
  : http.createServer(handleRequest);

// ---- WebSocket proxy: client /ws → matter-server ----

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if ((req.url ?? '').startsWith('/ws')) {
    wss.handleUpgrade(req, socket, head, (client) => {
      const upstream = new WebSocket(MATTER_WS_URL);
      const fwd = (src, dst) =>
        src.on('message', (data, isBinary) => {
          if (dst.readyState === WebSocket.OPEN) dst.send(data, { binary: isBinary });
        });
      upstream.on('open', () => { fwd(client, upstream); fwd(upstream, client); });
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
  const proto = USE_HTTPS ? 'HTTPS' : 'HTTP';
  const mode  = IS_HA_ADDON ? 'HA add-on (ingress)' : 'standalone';
  console.log(`[ha-matter-utils] ${proto} on :${PORT} [${mode}]`);
  console.log(`[ha-matter-utils] WebSocket proxy → ${MATTER_WS_URL}`);
  console.log(`[ha-matter-utils] OTA write → ${OTA_WRITE_DIR}  (server path: ${OTA_SERVER_DIR})`);
});
