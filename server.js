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

let BUILD_DATE = 'dev';
try { BUILD_DATE = readFileSync(join(__dirname, 'build-date.txt'), 'utf8').trim(); } catch {}

// ---- config: HA add-on options.json takes precedence over env vars ----

// SUPERVISOR_TOKEN is always injected by HA Supervisor into every add-on container.
// Checking for it is more reliable than checking for /data/options.json, which may
// not yet exist on first start (race condition).
const IS_HA_ADDON = !!process.env.SUPERVISOR_TOKEN;

const HA_OPTIONS_FILE = '/data/options.json';
let haOpts = {};
if (existsSync(HA_OPTIONS_FILE)) {
  try { haOpts = JSON.parse(readFileSync(HA_OPTIONS_FILE, 'utf8')); }
  catch (e) { console.warn('[config] Could not read options.json:', e.message); }
}

function opt(haKey, envKey, fallback) {
  return haOpts[haKey] ?? process.env[envKey] ?? fallback;
}

const PORT           = parseInt(process.env.PORT ?? '5173');
let   MATTER_WS_URL  = opt('matter_ws_url',  'MATTER_WS_URL',  'ws://127.0.0.1:5580');
const OTA_ADDON_SLUG = opt('ota_addon_slug', 'OTA_CONTAINER',  'core_matter_server');
// With the all_addon_configs map, each add-on's config is at /addon_configs/<slug>/.
// We write the descriptor + binary into matter-server's config dir so it finds them
// at startup under its own /config/updates path.
const OTA_WRITE_DIR  = opt('ota_write_dir',  'OTA_WRITE_DIR',  IS_HA_ADDON ? `/addon_configs/${OTA_ADDON_SLUG}/updates` : '/matter-data/updates');
const CERT_FILE    = process.env.CERT_FILE   ?? '/certs/cert.pem';
const KEY_FILE     = process.env.KEY_FILE    ?? '/certs/key.pem';
const HTTPS_PORT   = parseInt(process.env.HTTPS_PORT ?? opt('https_port', 'HTTPS_PORT', '5174'));
const PUSH_THREAD  = opt('push_thread_script', 'PUSH_THREAD_SCRIPT', '');

// Read the default gateway from the Linux routing table.
// Used to reach host_network add-ons (like matter-server) from inside the hassio Docker network.
function defaultGateway() {
  try {
    const table = readFileSync('/proc/net/route', 'utf8');
    for (const line of table.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 3 || cols[1] !== '00000000' || cols[2] === '00000000') continue;
      const h = cols[2].padStart(8, '0');
      return [parseInt(h.slice(6,8),16), parseInt(h.slice(4,6),16),
              parseInt(h.slice(2,4),16), parseInt(h.slice(0,2),16)].join('.');
    }
  } catch {}
  return null;
}

// Discover matter-server's reachable address via the Supervisor API.
// If it uses host_network (ip_address = "0.0.0.0"), fall back to the
// Docker bridge gateway so we can reach its host-network port.
if (IS_HA_ADDON) {
  try {
    const _r = await fetch(`http://supervisor/addons/${OTA_ADDON_SLUG}/info`, {
      headers: { Authorization: `Bearer ${process.env.SUPERVISOR_TOKEN}` },
    });
    const _j = await _r.json();
    const _ip  = _j?.data?.ip_address;
    const _u   = new URL(MATTER_WS_URL);
    const _port = _u.port || '5580';
    const _path = _u.pathname || '/ws';
    console.log(`[ha-matter-utils] Supervisor: matter-server ip_address=${_ip}`);
    if (_ip && _ip !== '0.0.0.0') {
      MATTER_WS_URL = `ws://${_ip}:${_port}${_path}`;
    } else {
      // host_network add-on — reach it via the Docker bridge gateway
      const gw = defaultGateway();
      if (gw) MATTER_WS_URL = `ws://${gw}:${_port}${_path}`;
      console.log(`[ha-matter-utils] host_network add-on; gateway=${gw}`);
    }
  } catch (e) {
    console.warn(`[ha-matter-utils] Discovery failed (${e.message}); using ${MATTER_WS_URL}`);
  }
}

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

// ---- Thread TLV helper ----

// Opens HA Core WebSocket, fetches the primary Thread dataset TLV, closes.
// Returns the hex TLV string, or null if unavailable / not configured.
async function fetchHAThreadTLV() {
  if (!IS_HA_ADDON) return null;
  const token = process.env.SUPERVISOR_TOKEN;
  if (!token) return null;

  return new Promise((resolve) => {
    let ws;
    try { ws = new WebSocket('ws://homeassistant/api/websocket'); }
    catch { resolve(null); return; }

    let msgId = 1;
    const finish = (tlv) => {
      clearTimeout(timer);
      try { ws.close(); } catch {}
      resolve(tlv);
    };
    const timer = setTimeout(() => finish(null), 5000);

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'auth_required') {
          ws.send(JSON.stringify({ type: 'auth', access_token: token }));
        } else if (msg.type === 'auth_ok') {
          ws.send(JSON.stringify({ id: msgId++, type: 'thread/list_datasets' }));
        } else if (msg.type === 'result' && msg.id === 1) {
          const datasets = msg.result?.datasets;
          if (!msg.success || !datasets?.length) { finish(null); return; }
          ws.send(JSON.stringify({ id: msgId++, type: 'thread/get_dataset_tlv', dataset_id: datasets[0].dataset_id }));
        } else if (msg.type === 'result' && msg.id === 2) {
          finish(msg.success ? (msg.result?.tlv ?? null) : null);
        }
      } catch { finish(null); }
    });
    ws.on('error', () => finish(null));
  });
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

        // Descriptor format matches python-matter-server's local OTA provider JSON schema.
        // Fields must be camelCase inside a "modelVersion" wrapper — this is what
        // load_local_updates() reads at startup from --ota-provider-dir.
        const descriptor = {
          modelVersion: {
            vid,
            pid,
            softwareVersion: swVer,
            softwareVersionString: swVerStr,
            softwareVersionValid: true,
            otaUrl: `file://${otaFilename}`,
            otaFileSize: String(otaBuffer.length),
            otaChecksum: sha256,
            otaChecksumType: 1,
            minApplicableSoftwareVersion: minVer,
            maxApplicableSoftwareVersion: maxVer,
            releaseNotesUrl: fields.releaseNotesUrl || '',
            firmwareInformation: '',
          },
        };
        const jsonName = `${vid}_${pid}_v${swVer}.json`;
        writeFileSync(join(OTA_WRITE_DIR, jsonName), JSON.stringify(descriptor, null, 2));

        // python-matter-server loads --ota-provider-dir at startup only, so a restart
        // is required before update_node will see the new descriptor.
        console.log(`[upload] firmware written: ${otaFilename} v${swVer} (${otaBuffer.length} bytes)`);
        await restartMatterServer();
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

  if (urlPath === '/api/thread-tlv') {
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
    try { sendJson(res, 200, { tlv: await fetchHAThreadTLV() }); }
    catch { sendJson(res, 200, { tlv: null }); }
    return;
  }

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

// ---- HTTP server (port 5173 — HA ingress) ----

const httpServer = http.createServer(handleRequest);

// ---- HTTPS server (port 5174 — direct browser access, camera requires secure context) ----

const hasCerts    = existsSync(CERT_FILE) && existsSync(KEY_FILE);
const httpsServer = hasCerts
  ? https.createServer({ cert: readFileSync(CERT_FILE), key: readFileSync(KEY_FILE) }, handleRequest)
  : null;

// ---- WebSocket proxy: client /ws → matter-server ----

const wss = new WebSocketServer({ noServer: true });

function handleUpgrade(req, socket, head) {
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
      upstream.on('unexpected-response', (_req, res) => {
        let body = '';
        res.on('data', c => { if (body.length < 300) body += c; });
        res.on('end', () => {
          console.error(`[ws-proxy] HTTP ${res.statusCode} from matter-server (expected 101). Body: ${body.trim()}`);
          client.close();
        });
      });
      client.on('close',    ()  => upstream.close());
      client.on('error',    (e) => { console.error('[ws-client]', e.message); upstream.close(); });
    });
  } else {
    socket.destroy();
  }
}

httpServer.on('upgrade', handleUpgrade);
if (httpsServer) httpsServer.on('upgrade', handleUpgrade);

const mode = IS_HA_ADDON ? 'HA add-on (ingress)' : 'standalone';

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`[ha-matter-utils] Build: ${BUILD_DATE}`);
  console.log(`[ha-matter-utils] HTTP  on :${PORT} [${mode}]`);
  console.log(`[ha-matter-utils] WebSocket proxy → ${MATTER_WS_URL}`);
  console.log(`[ha-matter-utils] OTA write → ${OTA_WRITE_DIR}`);
});

if (httpsServer) {
  httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
    console.log(`[ha-matter-utils] HTTPS on :${HTTPS_PORT} [${mode}] (self-signed cert — accept once in browser)`);
  });
}
