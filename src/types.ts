// Shapes of matter-server WebSocket messages we care about.
// Many fields are loose `any` because attribute payloads vary by cluster.

export interface ServerInfo {
  fabric_id: number;
  compressed_fabric_id: number;
  schema_version: number;
  min_supported_schema_version: number;
  sdk_version: string;
  wifi_credentials_set: boolean;
  thread_credentials_set: boolean;
  bluetooth_enabled: boolean;
}

export interface NodeInfo {
  node_id: number;
  date_commissioned: string;
  last_interview: string;
  interview_version: number;
  available: boolean;
  is_bridge: boolean;
  attributes: Record<string, unknown>;
}

export interface MatterSoftwareVersion {
  vid: number;
  pid: number;
  software_version: number;
  software_version_string: string;
  firmware_information: string | null;
  min_applicable_software_version: number;
  max_applicable_software_version: number;
  release_notes_url: string | null;
  update_source: string;
}

// One WebSocket message — either request-response (message_id present)
// or a server-pushed event (event present).
export interface WSMessage {
  message_id?: string;
  result?: unknown;
  error_code?: number;
  details?: string;
  event?: string;
  // Server hello has these inline
  sdk_version?: string;
  thread_credentials_set?: boolean;
  bluetooth_enabled?: boolean;
}

export type AnnouncementReason = 0 | 1 | 2;

export interface FirmwareUploadFields {
  vid: number;
  pid: number;
  softwareVersion: number;
  softwareVersionString: string;
  minApplicableSoftwareVersion: number;
  maxApplicableSoftwareVersion: number;
  releaseNotesUrl?: string;
}

export interface FirmwareUploadResult {
  ok: boolean;
  softwareVersion: number;
  softwareVersionString: string;
  filename: string;
  error?: string;
}
