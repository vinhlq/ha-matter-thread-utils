import QrScanner from 'qr-scanner';
import { MatterClient } from './matter-client';
import { OtaService } from './ota-service';
import { OtaPanel } from './ota-panel';

// ---- elements ----
const statusEl = mustGet<HTMLElement>('status');
const logOutput = mustGet<HTMLElement>('log-output');
const commissionBtn = mustGet<HTMLButtonElement>('commission-btn');
const codeInput = mustGet<HTMLInputElement>('code-input');
const qrVideo = mustGet<HTMLVideoElement>('qr-video');
const serverInfoEl = mustGet<HTMLElement>('server-info');
const sdkEl = mustGet<HTMLElement>('server-sdk');
const threadEl = mustGet<HTMLElement>('server-thread');
const threadSyncBtn = mustGet<HTMLButtonElement>('thread-sync-btn');
const btEl = mustGet<HTMLElement>('server-bt');

type Mode = 'scan' | 'manual' | 'ota';

let qrScanner: QrScanner | null = null;
let commissioning = false;
let currentMode: Mode = 'scan';

function mustGet<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing required element #${id}`);
  return el as T;
}

function log(line: string): void {
  const ts = new Date().toLocaleTimeString([], { hour12: false });
  logOutput.textContent += `[${ts}] ${line}\n`;
  logOutput.scrollTop = logOutput.scrollHeight;
}

function setStatus(state: string, text: string): void {
  statusEl.className = state;
  statusEl.textContent = text;
}

function vibrate(pattern: number | number[]): void {
  if (navigator.vibrate) navigator.vibrate(pattern);
}

// ---- connect to matter-server ----
const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
// Use a path relative to the current page so the URL is correct both when
// served standalone (path = /) and behind HA ingress (path = /api/hassio_ingress/<token>/).
const wsBase = location.pathname.replace(/[^/]*$/, '');
const wsUrl = `${wsProto}//${location.host}${wsBase}ws`;
log(`Connecting to ${wsUrl}`);

const client = new MatterClient(wsUrl, log);
const otaService = new OtaService(client, log);
const ota = new OtaPanel(otaService, vibrate);

client.onStatusChange = (state, info) => {
  if (state === 'connected' && info) {
    setStatus('connected', `Ready (SDK ${info.sdk_version})`);
    sdkEl.textContent = info.sdk_version;
    threadEl.textContent = info.thread_credentials_set ? '✓ credentials set' : '✗ missing';
    btEl.textContent = info.bluetooth_enabled ? '✓ enabled' : '✗ disabled';
    serverInfoEl.hidden = false;

    if (!info.thread_credentials_set) log('WARNING: matter-server has no Thread credentials.');
    if (!info.bluetooth_enabled) log('WARNING: Bluetooth is disabled on matter-server.');

    // Pre-fetch nodes so the OTA tab is ready when opened.
    void ota.refreshNodes();
  } else if (state === 'error') {
    setStatus('error', 'Connection error');
  } else if (state === 'disconnected') {
    setStatus('error', 'Disconnected');
  }
};

threadSyncBtn.addEventListener('click', () => void (async () => {
  threadSyncBtn.disabled = true;
  threadSyncBtn.textContent = 'Syncing…';
  const ok = await otaService.restoreThreadCredentials();
  threadEl.textContent = ok ? '✓ credentials set' : '✗ missing';
  threadSyncBtn.disabled = false;
  threadSyncBtn.textContent = 'Sync';
})());

client.connect().catch((err: Error) => {
  log(`Connection failed: ${err.message}`);
  setStatus('error', 'Failed');
});

// ---- mode switching ----
for (const btn of document.querySelectorAll<HTMLButtonElement>('#mode-switcher button')) {
  btn.addEventListener('click', () => {
    const mode = btn.dataset.mode as Mode | undefined;
    if (!mode) return;
    switchMode(mode);
  });
}

function switchMode(mode: Mode): void {
  if (mode === currentMode) return;
  currentMode = mode;

  for (const b of document.querySelectorAll<HTMLButtonElement>('#mode-switcher button')) {
    b.classList.toggle('active', b.dataset.mode === mode);
  }
  for (const p of document.querySelectorAll<HTMLElement>('.panel:not(.info)')) {
    p.classList.toggle('active', p.id === `${mode}-panel`);
  }

  if (mode === 'scan') void startScanning();
  else stopScanning();

  if (mode === 'ota') void ota.refreshNodes();
}

// ---- QR scanning ----
async function startScanning(): Promise<void> {
  if (qrScanner) {
    try { await qrScanner.start(); }
    catch (err) { log(`Scanner start failed: ${(err as Error).message}`); }
    return;
  }
  try {
    const hasCamera = await QrScanner.hasCamera();
    if (!hasCamera) {
      log('No camera detected on this device');
      return;
    }
    qrScanner = new QrScanner(
      qrVideo,
      (result) => onQrDetected(result.data),
      {
        preferredCamera: 'environment',
        highlightScanRegion: true,
        highlightCodeOutline: true,
        maxScansPerSecond: 5,
      },
    );
    await qrScanner.start();
    log('QR scanner ready');
  } catch (err) {
    log(`Camera error: ${(err as Error).message} — use Enter Code instead`);
  }
}

function stopScanning(): void {
  qrScanner?.stop();
}

function onQrDetected(rawCode: string): void {
  if (commissioning) return;
  const code = (rawCode || '').trim();
  if (!code) return;
  log(`QR detected: ${code}`);
  vibrate(50);
  qrScanner?.stop();
  void commission(code).finally(() => {
    if (currentMode === 'scan') {
      qrScanner?.start().catch((err: Error) => log(`Scanner restart failed: ${err.message}`));
    }
  });
}

// ---- manual entry ----
commissionBtn.addEventListener('click', () => {
  const code = codeInput.value.trim();
  if (!code) { log('Enter a setup code first'); return; }
  void commission(code);
});

codeInput.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Enter') commissionBtn.click();
});

// ---- commission flow ----
async function commission(code: string): Promise<void> {
  if (commissioning) {
    log('A commissioning is already running, please wait');
    return;
  }
  if (!client.serverInfo) {
    log('Not connected to matter-server yet — try again in a moment');
    return;
  }

  commissioning = true;
  commissionBtn.disabled = true;
  commissionBtn.textContent = 'Commissioning…';
  setStatus('connecting', 'Commissioning…');
  log(`▶ Commissioning ${code}`);

  const t0 = Date.now();
  try {
    const result = await client.commissionWithCode(code);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const vendor = readScalar(result?.attributes?.['0/40/1']);
    const product = readScalar(result?.attributes?.['0/40/4']);
    log(`✓ SUCCESS in ${elapsed}s — Node ${result.node_id}` +
      (vendor !== null || product !== null
        ? ` (vendor ${vendor ?? '?'}, product ${product ?? '?'})`
        : ''));
    setStatus('connected', `Node ${result.node_id} added`);
    vibrate(200);
    // Update the OTA panel so the new node shows up.
    void ota.refreshNodes();
  } catch (err) {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    log(`✗ FAILED in ${elapsed}s — ${(err as Error).message}`);
    setStatus('error', 'Failed');
    vibrate([100, 50, 100]);
  } finally {
    commissioning = false;
    commissionBtn.disabled = false;
    commissionBtn.textContent = 'Commission';
  }
}

function readScalar(v: unknown): string | number | null {
  if (typeof v === 'string' || typeof v === 'number') return v;
  if (Array.isArray(v) && v.length === 1) {
    const x = v[0];
    if (typeof x === 'string' || typeof x === 'number') return x;
  }
  return null;
}

// ---- kick off ----
if (mustGet<HTMLElement>('scan-panel').classList.contains('active')) {
  void startScanning();
}
