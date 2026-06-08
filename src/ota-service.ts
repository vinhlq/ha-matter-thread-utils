// Pure logic layer — no DOM, no element references.
// Handles RPC calls to matter-server, HTTP uploads, and attribute helpers.

import type { MatterClient } from './matter-client';
import type {
  NodeInfo,
  MatterSoftwareVersion,
  FirmwareUploadFields,
  FirmwareUploadResult,
} from './types';

// BasicInformation cluster attribute paths (endpoint/cluster/attribute)
export const ATTR_VENDOR_NAME       = '0/40/1';
export const ATTR_VENDOR_ID         = '0/40/2';
export const ATTR_PRODUCT_NAME      = '0/40/3';
export const ATTR_PRODUCT_ID        = '0/40/4';
export const ATTR_SW_VERSION        = '0/40/9';
export const ATTR_SW_VERSION_STRING = '0/40/10';

export interface NodeVersionInfo {
  versionNum: number | null;
  versionStr: string;
  /** Ready-to-display label, e.g. "2.0.0 (v2)" or "unknown" */
  label: string;
}

export interface LocalUploadInputs {
  vid: string;
  pid: string;
  softwareVersion: string;
  softwareVersionString: string;
  minApplicableSoftwareVersion: string;
  releaseNotesUrl: string;
}

export class OtaService {
  constructor(
    private readonly client: MatterClient,
    private readonly log: (msg: string) => void,
  ) {}

  // ---- node list ----

  async getNodes(): Promise<NodeInfo[]> {
    return this.client.getNodes();
  }

  // ---- DCL update ----

  /** Returns null when the node is already up to date. */
  async checkNodeUpdate(node: NodeInfo): Promise<MatterSoftwareVersion | null> {
    this.log(`▶ Checking DCL for Node ${node.node_id} updates`);
    const result = await this.client.checkNodeUpdate(node.node_id);
    if (!result) {
      this.log(`✓ Node ${node.node_id} is up to date`);
    } else {
      this.log(`✓ Update available: ${result.software_version_string} (v${result.software_version})`);
    }
    return result;
  }

  async applyDclUpdate(node: NodeInfo, update: MatterSoftwareVersion): Promise<void> {
    this.log(`▶ OTA update Node ${node.node_id} → v${update.software_version}`);
    await this.client.updateNode(node.node_id, update.software_version);
    this.log(`✓ OTA update finished for Node ${node.node_id}`);
  }

  // ---- local firmware upload ----

  async uploadFirmware(file: File, fields: FirmwareUploadFields): Promise<FirmwareUploadResult> {
    const form = new FormData();
    form.append('file', file, file.name);
    form.append('vid', String(fields.vid));
    form.append('pid', String(fields.pid));
    form.append('softwareVersion', String(fields.softwareVersion));
    form.append('softwareVersionString', fields.softwareVersionString);
    form.append('minApplicableSoftwareVersion', String(fields.minApplicableSoftwareVersion));
    form.append('maxApplicableSoftwareVersion', String(fields.maxApplicableSoftwareVersion));
    if (fields.releaseNotesUrl) form.append('releaseNotesUrl', fields.releaseNotesUrl);

    const response = await fetch('/api/upload-firmware', { method: 'POST', body: form });
    const result = await response.json() as FirmwareUploadResult;
    if (!result.ok) throw new Error(result.error ?? 'Upload failed');
    return result;
  }

  async applyLocalUpdate(node: NodeInfo, softwareVersion: number): Promise<void> {
    this.log(`▶ Starting OTA update Node ${node.node_id} → v${softwareVersion}`);
    await this.client.updateNode(node.node_id, softwareVersion);
    this.log(`✓ OTA complete for Node ${node.node_id}`);
  }

  /** Waits for matter-server to disconnect and then reconnect after a restart. */
  waitForReconnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const deadline = setTimeout(
        () => reject(new Error('Timed out waiting for matter-server to restart (90 s)')),
        90_000,
      );

      // Phase 1: wait for disconnect (serverInfo → null).
      // Phase 2: wait for reconnect (serverInfo truthy again).
      let disconnected = !this.client.serverInfo;

      const check = () => {
        if (!disconnected) {
          disconnected = !this.client.serverInfo;
          setTimeout(check, 500);
          return;
        }
        if (this.client.serverInfo) {
          clearTimeout(deadline);
          resolve();
          return;
        }
        setTimeout(check, 800);
      };

      setTimeout(check, 500);
    });
  }

  // ---- attribute helpers ----

  nodeVersionInfo(node: NodeInfo): NodeVersionInfo {
    const versionNum = readNum(node.attributes[ATTR_SW_VERSION]);
    const versionStr = readStr(node.attributes[ATTR_SW_VERSION_STRING]);
    let label: string;
    if (versionStr && versionNum !== null) label = `${versionStr} (v${versionNum})`;
    else if (versionStr)                   label = versionStr;
    else if (versionNum !== null)          label = `v${versionNum}`;
    else                                   label = 'unknown';
    return { versionNum, versionStr, label };
  }

  nodeDisplayName(node: NodeInfo): string {
    const productName = readStr(node.attributes[ATTR_PRODUCT_NAME]);
    const vendorName  = readStr(node.attributes[ATTR_VENDOR_NAME]);
    const productId   = readNum(node.attributes[ATTR_PRODUCT_ID]);
    if (productName) return productName;
    if (vendorName && productId) return `${vendorName} / 0x${productId.toString(16).toUpperCase()}`;
    if (vendorName) return vendorName;
    return 'unknown';
  }

  /** Extract VID/PID/currentVersion from a node for pre-filling the upload form. */
  nodeUploadDefaults(node: NodeInfo): { vid: number | null; pid: number | null; currentVersion: number | null } {
    return {
      vid: readNum(node.attributes[ATTR_VENDOR_ID]),
      pid: readNum(node.attributes[ATTR_PRODUCT_ID]),
      currentVersion: readNum(node.attributes[ATTR_SW_VERSION]),
    };
  }

  /**
   * Validate and build FirmwareUploadFields from raw string inputs.
   * Returns null and logs the error if validation fails.
   */
  buildUploadFields(inputs: LocalUploadInputs, node: NodeInfo | null): FirmwareUploadFields | null {
    const vid = parseInt(inputs.vid, 10);
    const pid = parseInt(inputs.pid, 10);
    const softwareVersion = parseInt(inputs.softwareVersion, 10);
    const softwareVersionString = inputs.softwareVersionString.trim();
    const minApplicableSoftwareVersion = parseInt(inputs.minApplicableSoftwareVersion || '0', 10);
    const releaseNotesUrl = inputs.releaseNotesUrl.trim() || undefined;

    if (!vid || !pid) { this.log('Vendor ID and Product ID are required'); return null; }
    if (!softwareVersion) { this.log('New version number is required'); return null; }
    if (!softwareVersionString) { this.log('New version string is required'); return null; }

    const currentVersion = node
      ? (readNum(node.attributes[ATTR_SW_VERSION]) ?? softwareVersion - 1)
      : softwareVersion - 1;

    return {
      vid,
      pid,
      softwareVersion,
      softwareVersionString,
      minApplicableSoftwareVersion,
      maxApplicableSoftwareVersion: currentVersion,
      releaseNotesUrl,
    };
  }
}

// ---- shared attribute value readers (exported for use in the panel) ----

export function readNum(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (Array.isArray(v) && v.length === 1 && typeof v[0] === 'number') return v[0];
  return null;
}

export function readStr(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && v.length === 1 && typeof v[0] === 'string') return v[0];
  return '';
}
