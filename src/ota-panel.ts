// Pure UI layer — owns all DOM element references, event wiring, and rendering.
// Delegates all async/business logic to OtaService.

import type { NodeInfo, MatterSoftwareVersion } from './types';
import { OtaService } from './ota-service';

type Vibrator = (pattern: number | number[]) => void;
type OtaSubMode = 'dcl' | 'local';

export class OtaPanel {
  // Shared controls
  private nodeSelect    = mustGet<HTMLSelectElement>('ota-node');
  private refreshBtn    = mustGet<HTMLButtonElement>('ota-refresh-btn');
  private currentVerEl  = mustGet<HTMLElement>('ota-current-version');

  // DCL sub-panel
  private dclPanel   = mustGet<HTMLElement>('ota-dcl-panel');
  private checkBtn   = mustGet<HTMLButtonElement>('ota-check-btn');
  private updateInfo = mustGet<HTMLElement>('ota-update-info');
  private updateBtn  = mustGet<HTMLButtonElement>('ota-update-btn');

  // Local firmware sub-panel
  private localPanel          = mustGet<HTMLElement>('ota-local-panel');
  private dropZone            = mustGet<HTMLElement>('ota-drop-zone');
  private fileInput           = mustGet<HTMLInputElement>('ota-file-input');
  private selectedFilenameEl  = mustGet<HTMLElement>('ota-selected-filename');
  private vidInput            = mustGet<HTMLInputElement>('ota-vid');
  private pidInput            = mustGet<HTMLInputElement>('ota-pid');
  private newVersionInput     = mustGet<HTMLInputElement>('ota-new-version');
  private newVersionStringInput = mustGet<HTMLInputElement>('ota-new-version-string');
  private minVersionInput     = mustGet<HTMLInputElement>('ota-min-version');
  private releaseUrlInput     = mustGet<HTMLInputElement>('ota-release-url');
  private uploadBtn           = mustGet<HTMLButtonElement>('ota-upload-btn');
  private progressEl          = mustGet<HTMLElement>('ota-upload-progress');

  // Upload complete dialog
  private completeDialog   = mustGet<HTMLDialogElement>('ota-complete-dialog');
  private completeMsg      = mustGet<HTMLElement>('ota-complete-msg');
  private completeCloseBtn = mustGet<HTMLButtonElement>('ota-complete-close');

  // State
  private nodes: NodeInfo[] = [];
  private pendingDclUpdate: MatterSoftwareVersion | null = null;
  private selectedFile: File | null = null;
  private subMode: OtaSubMode = 'dcl';

  constructor(
    private readonly service: OtaService,
    private readonly vibrate: Vibrator,
  ) {
    this.bindEvents();
  }

  // ---- event binding ----

  private bindEvents(): void {
    this.refreshBtn.addEventListener('click', () => void this.handleRefresh());
    this.nodeSelect.addEventListener('change', () => this.onNodeChange());

    for (const btn of document.querySelectorAll<HTMLButtonElement>('#ota-submode button')) {
      btn.addEventListener('click', () => this.switchSubMode(btn.dataset.sub as OtaSubMode));
    }

    // DCL
    this.checkBtn.addEventListener('click', () => void this.handleCheckUpdate());
    this.updateBtn.addEventListener('click', () => void this.handleApplyDclUpdate());

    // File drop zone
    this.dropZone.addEventListener('click', () => this.fileInput.click());
    this.dropZone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') this.fileInput.click();
    });
    this.fileInput.addEventListener('change', () => this.onFileSelected(this.fileInput.files?.[0]));
    this.dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      this.dropZone.classList.add('drag-over');
    });
    this.dropZone.addEventListener('dragleave', () => this.dropZone.classList.remove('drag-over'));
    this.dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      this.dropZone.classList.remove('drag-over');
      this.onFileSelected(e.dataTransfer?.files[0]);
    });

    this.uploadBtn.addEventListener('click', () => void this.handleUploadAndUpdate());

    // Complete dialog
    this.completeCloseBtn.addEventListener('click', () => this.completeDialog.close());
    this.completeDialog.addEventListener('click', (e) => {
      if (e.target === this.completeDialog) this.completeDialog.close();
    });
  }

  // ---- sub-mode switch ----

  private switchSubMode(mode: OtaSubMode): void {
    this.subMode = mode;
    for (const btn of document.querySelectorAll<HTMLButtonElement>('#ota-submode button')) {
      btn.classList.toggle('active', btn.dataset.sub === mode);
    }
    this.dclPanel.hidden   = mode !== 'dcl';
    this.localPanel.hidden = mode !== 'local';
    this.clearDclResult();
  }

  // ---- node list ----

  async refreshNodes(): Promise<void> {
    return this.handleRefresh();
  }

  private async handleRefresh(): Promise<void> {
    this.refreshBtn.disabled = true;
    try {
      this.nodes = await this.service.getNodes();
      this.renderNodeList();
      this.onNodeChange();
    } finally {
      this.refreshBtn.disabled = false;
    }
  }

  private renderNodeList(): void {
    this.nodeSelect.innerHTML = '';

    if (this.nodes.length === 0) {
      const opt = makeOption('', 'No commissioned nodes', true);
      this.nodeSelect.appendChild(opt);
      this.checkBtn.disabled = true;
      this.uploadBtn.disabled = true;
      return;
    }

    this.checkBtn.disabled = false;
    for (const node of this.nodes) {
      const name   = this.service.nodeDisplayName(node);
      const status = node.available ? '✓' : '✗ offline';
      this.nodeSelect.appendChild(makeOption(String(node.node_id), `Node ${node.node_id} · ${name} (${status})`));
    }
  }

  private selectedNode(): NodeInfo | null {
    const id = parseInt(this.nodeSelect.value, 10);
    if (Number.isNaN(id)) return null;
    return this.nodes.find((n) => n.node_id === id) ?? null;
  }

  private onNodeChange(): void {
    const node = this.selectedNode();
    this.clearDclResult();

    if (!node) {
      this.currentVerEl.textContent = '—';
      return;
    }

    this.currentVerEl.textContent = this.service.nodeVersionInfo(node).label;
    this.prefillLocalForm(node);
  }

  // ---- DCL update ----

  private clearDclResult(): void {
    this.updateInfo.textContent = '';
    this.updateInfo.hidden = true;
    this.updateBtn.hidden  = true;
    this.pendingDclUpdate  = null;
  }

  private async handleCheckUpdate(): Promise<void> {
    const node = this.selectedNode();
    if (!node) return;
    if (!node.available) return;

    this.clearDclResult();
    this.checkBtn.disabled  = true;
    this.checkBtn.textContent = 'Checking…';

    try {
      const update = await this.service.checkNodeUpdate(node);
      if (!update) {
        this.updateInfo.textContent = 'Up to date — no newer version on the Matter DCL.';
        this.updateInfo.hidden = false;
      } else {
        this.pendingDclUpdate = update;
        this.renderDclUpdate(update);
        this.vibrate(50);
      }
    } catch (err) {
      // error already logged by service; nothing to render here
    } finally {
      this.checkBtn.disabled    = false;
      this.checkBtn.textContent = 'Check for update';
    }
  }

  private renderDclUpdate(u: MatterSoftwareVersion): void {
    this.updateInfo.hidden = false;
    this.updateInfo.innerHTML = '';

    const summary = el('p');
    summary.innerHTML =
      `<strong>${esc(u.software_version_string)}</strong> (v${u.software_version})` +
      ` · source: ${esc(u.update_source)}`;
    this.updateInfo.appendChild(summary);

    if (u.firmware_information) {
      const fw = el('p', 'mono');
      fw.textContent = u.firmware_information;
      this.updateInfo.appendChild(fw);
    }

    if (u.release_notes_url) {
      const p = el('p');
      const a = document.createElement('a');
      a.href = u.release_notes_url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = 'Release notes ↗';
      p.appendChild(a);
      this.updateInfo.appendChild(p);
    }

    this.updateBtn.hidden = false;
    this.updateBtn.textContent = `Update to v${u.software_version}`;
  }

  private async handleApplyDclUpdate(): Promise<void> {
    const node = this.selectedNode();
    if (!node || !this.pendingDclUpdate) return;

    this.updateBtn.disabled   = true;
    this.checkBtn.disabled    = true;
    this.updateBtn.textContent = 'Updating… (may take minutes)';

    try {
      await this.service.applyDclUpdate(node, this.pendingDclUpdate);
      this.vibrate(200);
      this.clearDclResult();
      await this.handleRefresh();
    } catch (err) {
      this.vibrate([100, 50, 100]);
      this.updateBtn.textContent = `Update to v${this.pendingDclUpdate.software_version}`;
    } finally {
      this.updateBtn.disabled = false;
      this.checkBtn.disabled  = false;
    }
  }

  // ---- local firmware upload ----

  private prefillLocalForm(node: NodeInfo): void {
    const { vid, pid } = this.service.nodeUploadDefaults(node);
    if (vid !== null) this.vidInput.value = String(vid);
    if (pid !== null) this.pidInput.value = String(pid);
    this.minVersionInput.value = '0';
  }

  private onFileSelected(file: File | null | undefined): void {
    if (!file) return;
    this.selectedFile = file;
    this.selectedFilenameEl.textContent = `${file.name} (${formatBytes(file.size)})`;
    this.dropZone.classList.add('has-file');
    this.uploadBtn.disabled = false;
  }

  private async handleUploadAndUpdate(): Promise<void> {
    if (!this.selectedFile) return;
    const node = this.selectedNode();
    if (!node) return;

    const fields = this.service.buildUploadFields(this.rawInputs(), node);
    if (!fields) return;

    this.uploadBtn.disabled   = true;
    this.uploadBtn.textContent = 'Uploading…';
    this.setProgress('Uploading firmware file…');

    try {
      const result = await this.service.uploadFirmware(this.selectedFile, fields);

      this.setProgress('Waiting for matter-server restart…');
      await this.service.waitForReconnect();
      this.clearProgress();

      // Show dialog as soon as upload + restart succeed — OTA trigger is best-effort.
      this.vibrate(200);
      this.showCompleteDialog(node, result.softwareVersionString, result.softwareVersion);

      try {
        await this.service.applyLocalUpdate(node, result.softwareVersion);
      } catch { /* applyLocalUpdate logs its own errors */ }

      await this.handleRefresh();
    } catch (err) {
      this.vibrate([100, 50, 100]);
      this.clearProgress();
    } finally {
      this.uploadBtn.disabled   = false;
      this.uploadBtn.textContent = 'Upload & update';
    }
  }

  private rawInputs() {
    return {
      vid: this.vidInput.value,
      pid: this.pidInput.value,
      softwareVersion: this.newVersionInput.value,
      softwareVersionString: this.newVersionStringInput.value,
      minApplicableSoftwareVersion: this.minVersionInput.value,
      releaseNotesUrl: this.releaseUrlInput.value,
    };
  }

  private showCompleteDialog(node: NodeInfo, versionStr: string, versionNum: number): void {
    const name = this.service.nodeDisplayName(node);
    this.completeMsg.textContent =
      `Node ${node.node_id} (${name}) is updating to ${versionStr} (v${versionNum}). ` +
      `The device will reboot when the transfer completes.`;
    this.completeDialog.showModal();
  }

  private setProgress(msg: string): void {
    this.progressEl.textContent = msg;
    this.progressEl.hidden = false;
  }

  private clearProgress(): void {
    this.progressEl.hidden = true;
    this.progressEl.textContent = '';
  }
}

// ---- DOM helpers (panel-only) ----

function mustGet<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
}

function el(tag: string, className?: string): HTMLElement {
  const e = document.createElement(tag);
  if (className) e.className = className;
  return e;
}

function makeOption(value: string, text: string, disabled = false): HTMLOptionElement {
  const opt = document.createElement('option');
  opt.value = value;
  opt.textContent = text;
  opt.disabled = disabled;
  opt.selected = disabled;
  return opt;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c));
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}
