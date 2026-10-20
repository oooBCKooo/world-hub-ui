# World Hub UI

[简体中文](README.md)

An independent interface project for World Hub: communication topology, a manual bridge workbench, module body/configuration/data management, and community pages. World Hub runs independently. Programs can use its HTTP and WebSocket contracts without this interface.

[Hub project](https://github.com/oooBCKooo/world-hub) · [Interface conventions](docs/interface-ux.md#english) · [Manual workbench](docs/specs/manual-workbench.md)

## Changes in 0.1.1

The profile popover supports one global selection and multiple local profiles. Conflicts open the existing review instead of silently deactivating other local configurations. Duplicate group headers, filters and layout are corrected while original group identities remain available. Recommended with World Hub 0.22.0.

## Start

Requires Node.js 22.4 or later. No third-party runtime dependencies. The independent `world-hub-ui` npm package does not bundle or automatically install `world-hub`. Start World Hub separately, then install and start the interface:

```sh
npm install -g world-hub-ui
world-hub-ui --hub http://127.0.0.1:8790 --open
```

The terminal prints the actual UI URL. Use `--port 9000` for a fixed UI port; the default is an available system port. The UI reads the Hub's declared WebSocket path. Use `--bridge-path /bridge` explicitly when starting before the Hub or using a custom path.

The Hub and UI are separate processes. Closing this interface does not stop the Hub. This UI does not implicitly start, own, or upgrade it. Module operations use the Hub's management API.

## Communication boundary

The UI binds only to `127.0.0.1` and connects only to an explicitly configured HTTP loopback Hub origin. Its same-origin proxy forwards `/manage/api/**`, read-only `/status` and `/log`, and the configured bridge WebSocket path.

Browser requests are checked against the UI's Host, Origin, and Fetch Metadata before forwarding to the fixed Hub. The Hub still checks the original management operation token. There is no arbitrary URL proxy, cross-origin permission grant, automatic mutation retry, or bridge identity delegation. The browser's manual bridge sends its own hello and credentials.

`/debug` provides read-only communication diagnostics. The UI can remain open while the Hub is stopped; API requests then report that the Hub is unavailable.

## Community pages

`tools/workshop/public/` contains the independent community frontend, using the fixed `/workshop/` path. Community accounts do not control a local Hub.

Pass this directory explicitly to the World Hub Workshop backend or gateway's external static directory option. Node consumers can locate it through:

```javascript
import { workshopAssetsRoot } from 'world-hub-ui/workshop-assets';
```

Serve the frontend and Workshop API on the same origin to preserve cookie and CSRF checks. The local management CLI does not proxy public community accounts or read their credentials.

## Develop and verify

To run from source:

```sh
npm ci --ignore-scripts
node bin/world-hub-ui.mjs --hub http://127.0.0.1:8790 --open
npm test
npm run check
```

For an optional live contract test, set `WORLD_HUB_ENTRY` to the absolute path of an installed Hub's `bin/world-hub.mjs`, then run `node --test tests/proxy/hub-contract.test.mjs`. It owns a temporary Hub and verifies operation tokens, raw browser-bridge messages, and separate shutdown. Default tests require no other checkout.

`src/server.mjs` exports `createUIServer({ hub, port, bridgePath })`, returning `url`, `origin`, `bridgePath`, and asynchronous `close()`. It imports no Hub repository internals and does not require adjacent checkouts.

The management interface reads `transport.path`, `csrfToken`, and diagnostics from `/manage/api/state`, then uses the management resources under `/manage/api/`. These HTTP and WebSocket contracts belong to the Hub. Editing this UI does not change Hub persistence, ACL, or wire protocol.

MIT license.
