# ha-matter-thread-utils

A tiny TypeScript + Vite web app that commissions Matter devices and manages OTA
firmware updates via the local `matter-server` running on this Pi. Works from a
phone (QR scan) or any device with manual code entry. Bypasses the HA companion
app entirely — useful when the Android app hangs at "Checking connectivity to
thread network".

Commissioning runs through the Pi's Bluetooth + Thread radio; the phone or
browser is only used to submit setup codes and pick OTA targets.

## Layout

    matter-commissioner/
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.js
    ├── index.html
    └── src/
        ├── main.ts            # entry: wiring, mode switching, commissioning flow
        ├── matter-client.ts   # WebSocket client for python-matter-server
        ├── ota.ts             # OTA panel (check / apply update)
        ├── types.ts           # shared types (ServerInfo, NodeInfo, etc.)
        └── style.css

## Run

    cd /home/pi/hass/matter-commissioner
    npm install
    npm run dev

Vite prints a URL like `https://192.168.88.21:5173`. Open it from any device on
the same LAN — including your phone. The first time you'll see a self-signed
certificate warning (required so the camera API is exposed); accept it.

Scripts:

- `npm run dev` — Vite dev server, HTTPS on 0.0.0.0:5173
- `npm run typecheck` — `tsc --noEmit` (no transpile, just type validation)
- `npm run build` — typecheck + production bundle to `dist/`
- `npm run preview` — serve the production bundle

## UI

Three tabs across the top:

- **Scan QR** — point the phone camera at the Matter QR code.
- **Enter Code** — type the QR text (`MT:...`) or 11-digit pairing code.
- **OTA** — pick a commissioned node, check Matter DCL for newer firmware, apply.

The footer panel shows live matter-server status: SDK version, whether Thread
credentials are loaded, whether Bluetooth is enabled. The activity log shows
every command and its outcome.

## How it works

- Vite serves the app over HTTPS so phones expose `getUserMedia` for the QR
  scanner.
- A WebSocket proxy at `/ws` forwards to `ws://127.0.0.1:5580/ws` (matter-server)
  so the page can talk to matter-server over `wss://` without mixed-content
  errors.
- Commissioning sends a single `commission_with_code` WebSocket command;
  matter-server does BLE + Thread provisioning on the Pi and returns the new node.
- OTA sends `check_node_update` (queries the Matter DCL) and, if a new version
  exists, `update_node` (matter-server downloads firmware and announces itself as
  the OTA provider to the node).

## Required matter-server state

The matter-server must have:

- `thread_credentials_set: true` — handled by the `matter-thread-init.service`
  systemd unit.
- `bluetooth_enabled: true` — handled by `--bluetooth-adapter 0` in the compose
  file.

Both states are surfaced live in the **matter-server** section on connect.
