import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { execSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Busboy from 'busboy';

const OTA_CONTAINER = 'matter-server';
const OTA_DIR_IN_CONTAINER = '/data/updates';
const PUSH_THREAD_SCRIPT = '/home/pi/hass/push-thread-dataset.sh';

function runDocker(...args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 120_000 });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `docker ${args[0]} failed`);
  return result.stdout;
}

/** Upload handler — called by Vite's configureServer */
function handleFirmwareUpload(req, res) {
  if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }

  let bb;
  try {
    bb = Busboy({ headers: req.headers, limits: { fileSize: 100 * 1024 * 1024 } });
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Expected multipart/form-data upload' }));
    return;
  }

  let otaBuffer = null;
  let otaFilename = 'firmware.ota';
  const fields = {};

  bb.on('file', (_name, stream, info) => {
    otaFilename = info.filename || 'firmware.ota';
    const chunks = [];
    stream.on('data', c => chunks.push(c));
    stream.on('end', () => { otaBuffer = Buffer.concat(chunks); });
  });

  bb.on('field', (name, val) => { fields[name] = val; });

  bb.on('finish', () => {
    if (!otaBuffer) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No OTA file received' }));
      return;
    }

    // Validate required metadata
    const vid = parseInt(fields.vid);
    const pid = parseInt(fields.pid);
    const softwareVersion = parseInt(fields.softwareVersion);
    const softwareVersionString = (fields.softwareVersionString || '').trim();
    const minVersion = parseInt(fields.minApplicableSoftwareVersion ?? '0');
    const maxVersion = parseInt(fields.maxApplicableSoftwareVersion ?? String(softwareVersion - 1));

    if (!vid || !pid || !softwareVersion || !softwareVersionString) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing required fields: vid, pid, softwareVersion, softwareVersionString' }));
      return;
    }

    try {
      // Compute SHA-256 checksum (base64) — otaChecksumType 1 = sha256
      const sha256 = createHash('sha256').update(otaBuffer).digest('base64');

      // Write .ota to a host temp file, then docker cp it in
      const tmpDir = mkdtempSync(join(tmpdir(), 'matter-ota-'));
      const tmpOta = join(tmpDir, otaFilename);
      writeFileSync(tmpOta, otaBuffer);

      // Ensure destination dir exists in container
      runDocker('exec', OTA_CONTAINER, 'mkdir', '-p', OTA_DIR_IN_CONTAINER);

      // Copy .ota file into container
      runDocker('cp', tmpOta, `${OTA_CONTAINER}:${OTA_DIR_IN_CONTAINER}/${otaFilename}`);
      unlinkSync(tmpOta);

      // Build and write the JSON descriptor
      const descriptor = {
        modelVersion: {
          vid,
          pid,
          softwareVersion,
          softwareVersionString,
          otaUrl: `file://${OTA_DIR_IN_CONTAINER}/${otaFilename}`,
          otaChecksum: sha256,
          otaChecksumType: 1,  // sha256
          minApplicableSoftwareVersion: minVersion,
          maxApplicableSoftwareVersion: maxVersion,
          softwareVersionValid: true,
          firmwareInformation: null,
          releaseNotesUrl: fields.releaseNotesUrl || null,
        },
      };
      const jsonFilename = `${vid}_${pid}_v${softwareVersion}.json`;
      const tmpJson = join(tmpDir, jsonFilename);
      writeFileSync(tmpJson, JSON.stringify(descriptor, null, 2));
      runDocker('cp', tmpJson, `${OTA_CONTAINER}:${OTA_DIR_IN_CONTAINER}/${jsonFilename}`);
      unlinkSync(tmpJson);

      // Remove temp dir
      try { rmdirSync(tmpDir); } catch (_) {}

      // Restart matter-server so it picks up the new local update descriptor
      runDocker('restart', OTA_CONTAINER);

      // Re-push Thread credentials after restart (matter-server forgets them)
      try {
        spawnSync('bash', [PUSH_THREAD_SCRIPT], { encoding: 'utf8', timeout: 60_000 });
      } catch (e) {
        console.warn('[firmware-upload] push-thread-dataset failed:', e.message);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, softwareVersion, softwareVersionString, filename: otaFilename }));

    } catch (err) {
      console.error('[firmware-upload] error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  bb.on('error', err => {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  });

  req.pipe(bb);
}

export default defineConfig({
  plugins: [
    basicSsl(),
    {
      name: 'firmware-upload',
      configureServer(server) {
        server.middlewares.use('/api/upload-firmware', handleFirmwareUpload);
      },
    },
  ],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/ws': {
        target: 'ws://127.0.0.1:5580',
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
