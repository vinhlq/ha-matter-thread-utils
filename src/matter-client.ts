// Thin client for the python-matter-server WebSocket API.
// First server message is a ServerInfo dict (no message_id); after that
// it's request/response keyed on message_id, plus async events.

import type {
  ServerInfo,
  WSMessage,
  NodeInfo,
  MatterSoftwareVersion,
} from './types';

type Status = 'connecting' | 'connected' | 'error' | 'disconnected';
type StatusListener = (state: Status, info?: ServerInfo) => void;
type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export class MatterClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private nextId = 0;

  serverInfo: ServerInfo | null = null;
  onStatusChange: StatusListener | null = null;

  constructor(private url: string, private log: (msg: string) => void) {}

  connect(): Promise<ServerInfo> {
    return new Promise<ServerInfo>((resolve, reject) => {
      let settled = false;
      try {
        this.ws = new WebSocket(this.url);
      } catch (err) {
        reject(err as Error);
        return;
      }

      this.ws.onopen = () => this.log('WebSocket opened, waiting for server info…');

      this.ws.onmessage = (event: MessageEvent<string>) => {
        let data: WSMessage;
        try {
          data = JSON.parse(event.data) as WSMessage;
        } catch (err) {
          this.log(`Bad JSON: ${(err as Error).message}`);
          return;
        }

        // Server hello: no message_id, but has sdk_version inline
        if (!this.serverInfo && data.sdk_version) {
          this.serverInfo = data as unknown as ServerInfo;
          this.onStatusChange?.('connected', this.serverInfo);
          settled = true;
          resolve(this.serverInfo);
          return;
        }

        // Request response
        if (data.message_id && this.pending.has(data.message_id)) {
          const p = this.pending.get(data.message_id)!;
          this.pending.delete(data.message_id);
          if (data.error_code !== undefined) {
            p.reject(new Error(data.details || `matter-server error ${data.error_code}`));
          } else {
            p.resolve(data.result);
          }
          return;
        }

        if (data.event) this.log(`event: ${data.event}`);
      };

      this.ws.onerror = () => {
        this.log('WebSocket error');
        this.onStatusChange?.('error');
        if (!settled) reject(new Error('WebSocket error'));
      };

      this.ws.onclose = (ev: CloseEvent) => {
        this.log(`WebSocket closed (code ${ev.code})`);
        this.onStatusChange?.('disconnected');
        for (const p of this.pending.values()) p.reject(new Error('Connection closed'));
        this.pending.clear();
        this.serverInfo = null;
      };
    });
  }

  send<T = unknown>(command: string, args: Record<string, unknown> = {}): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Not connected to matter-server'));
    }
    return new Promise<T>((resolve, reject) => {
      const id = `req-${++this.nextId}`;
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws!.send(JSON.stringify({ message_id: id, command, args }));
    });
  }

  // High-level helpers

  commissionWithCode(code: string): Promise<NodeInfo> {
    return this.send<NodeInfo>('commission_with_code', { code });
  }

  getNodes(): Promise<NodeInfo[]> {
    return this.send<NodeInfo[]>('get_nodes');
  }

  /** Returns the available update info or null if up-to-date. */
  checkNodeUpdate(nodeId: number): Promise<MatterSoftwareVersion | null> {
    return this.send<MatterSoftwareVersion | null>('check_node_update', {
      node_id: nodeId,
    });
  }

  /** Triggers the OTA flow on matter-server (acts as provider, downloads from DCL, announces). */
  updateNode(nodeId: number, softwareVersion: number | string): Promise<void> {
    return this.send<void>('update_node', {
      node_id: nodeId,
      software_version: softwareVersion,
    });
  }

  /** Generic device command — escape hatch for clusters/commands without a helper. */
  deviceCommand(args: {
    nodeId: number;
    endpointId: number;
    clusterId: number;
    commandName: string;
    payload: Record<string, unknown>;
  }): Promise<unknown> {
    return this.send('device_command', {
      node_id: args.nodeId,
      endpoint_id: args.endpointId,
      cluster_id: args.clusterId,
      command_name: args.commandName,
      payload: args.payload,
    });
  }
}
