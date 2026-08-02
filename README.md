# Quarry — AI Minecraft Builder

Quarry connects a Paper server to an authenticated web control center. An operator can describe a build or attach a PNG/JPG/WEBP reference, review the generated block blueprint, approve it, watch real Paper block placement, pause it, and roll it back from the persisted original-block diff.

The hosted control center is `https://map.work-plus.kr`. The primary server uses its full BlueMap output at `/live-map/`; enrolled third-party servers use a bounded, loaded-chunk-only surface map read directly by the plugin.

## What is real

- `DynamicAiBridge` connects outbound from Paper to the Gateway over authenticated WebSocket.
- Server version, TPS, MSPT, memory, players, and loaded worlds come from Paper.
- AI output is a bounded block plan, never a direct server command.
- An approved executable plan is sent to the plugin. The plugin validates the world, configured region, block allowlist, loaded chunks, players, TPS, MSPT, and total size before writing.
- Original block states are persisted before the first write. Rollback restores them in reverse order and preserves unrelated external edits as conflicts.
- BlueMap renders the actual server world. The Three.js site preview uses textures extracted from the resource pack supplied by the server owner.
- Hosted servers without BlueMap return real top-surface block IDs from already-loaded chunks; the browser renders those cells without forcing chunk loads.

The bundled initial job is a preview-only example and cannot be approved. Create an executable blueprint in **AI 설계** first.

## Security defaults

- Every `/api/v1` route and browser event socket requires an HttpOnly, SameSite session cookie.
- Mutating requests require a per-session CSRF token.
- Viewer, Reviewer, Operator, and Admin roles are enforced on the server. Browser role headers are ignored.
- Login attempts and AI requests are rate-limited.
- Bridge secrets have no development fallback and are compared in constant time.
- Public enrollment creates a unique token per Paper installation and a 30-minute, one-use ownership code. Tokens, claim codes, and passwords are stored only as hashes.
- Sessions, events, jobs, encrypted API keys, map caches, and bridge commands are scoped to one `serverId`.
- OpenAI keys are accepted only in the Admin settings screen or `OPENAI_API_KEY`. Web-entered keys are AES-256-GCM encrypted at rest and never returned to the browser.
- A fresh plugin install has `policy.allow-world-writes: false` and no allowed regions. It cannot modify a world until the server owner explicitly configures both.
- The Gateway state and encrypted key live under `/var/lib/dynamic-ai`, outside replaceable application releases.

## Install the Paper plugin

The JAR is the complete Paper-side executor. It contains neither a public web server nor a shared OpenAI key.

1. Put `dynamic-ai-paper-bridge-<version>.jar` in the Paper `plugins/` directory.
2. Start Paper. The default configuration enrolls at `map.work-plus.kr` and prints a `srv_...` server ID, one-time ownership code, and claim URL.
3. Open that URL, choose a 16+ character administrator password, then sign in with the generated server ID.
4. Add your own OpenAI API key under **설정 → OpenAI API 키**. It is encrypted in this server's isolated key store.
5. To permit construction, stop Paper, add the exact writable cuboid to `policy.allowed-regions`, and set `policy.allow-world-writes: true` only after reviewing it.
6. Restart Paper. World writes remain disabled when the policy is left at its safe default.

Example policy:

```yaml
policy:
  allow-world-writes: true
  allowed-worlds: ["world"]
  allowed-regions:
    - world: "world"
      min: { x: -128, y: -64, z: -128 }
      max-exclusive: { x: 128, y: 320, z: 128 }
  allowed-blocks:
    - "minecraft:spruce_planks"
    - "minecraft:stone_bricks"
    - "minecraft:glass"
    - "minecraft:oxidized_copper"
  minimum-tps: 18.0
  maximum-mspt: 40.0
  maximum-total-blocks: 12000
  maximum-batch-blocks: 250
  player-exclusion-radius: 24
```

Plain `ws://` is accepted only for loopback. Remote Gateways require `wss://`.

## Run the full stack locally

Requirements: Node.js 22 or newer, Java 21, Gradle 9.6.1, and a Paper 1.21.11-compatible server.

```powershell
cd C:\Users\toltol\Desktop\dynamic_AI
npm ci
npm run dev
```

The web UI runs on `http://127.0.0.1:5173` and proxies the Gateway at `http://127.0.0.1:8787`.

Copy `.env.example` to an ignored `.env` file and set at least:

```text
BRIDGE_SHARED_SECRET=<long random value>
CONTROL_CENTER_PASSWORD=<long random value>
OPENAI_KEY_ENCRYPTION_SECRET=<separate long random value>
ALLOW_PUBLIC_SERVER_ENROLLMENT=true
```

Optional role passwords are `CONTROL_CENTER_OPERATOR_PASSWORD`, `CONTROL_CENTER_REVIEWER_PASSWORD`, and `CONTROL_CENTER_VIEWER_PASSWORD`. `CONTROL_CENTER_PASSWORD` is the Admin password.

After logging in, an Admin can enter an OpenAI API key under **설정 → OpenAI API 키**. The key is stored on the Gateway, not in localStorage or bundled JavaScript.

## Minecraft textures

Mojang texture files are not committed to this repository. Place a legally obtained, extracted Java Edition resource pack under `texture/<pack>/` so that the folder contains `pack.mcmeta` and `assets/minecraft/`, then run:

```powershell
npm run prepare:minecraft-assets
```

The script resolves blockstate/model/texture references and generates the seven preview materials under the ignored web asset directory. Without a supplied pack, the public-source build uses a color-only fallback; the production installation uses the real pack supplied by the server owner.

## Validation

```powershell
npm run typecheck
npm test
npm run build
```

Plugin build:

```powershell
gradle -p plugins/paper-bridge build --no-daemon --warning-mode all
```

GitHub Actions runs both build paths and publishes the plugin JAR as a workflow artifact.

## Production layout

```text
Cloudflare DNS/TLS
  -> Caddy on the public proxy
     -> /live-map/*  -> BlueMap on the Paper host
     -> everything else -> authenticated Node Gateway + React UI

Paper DynamicAiBridge
  -> HTTPS enrollment (first start) + outbound per-server authenticated WebSocket -> Gateway
```

The deployment helpers under `infra/deploy/` install the Gateway systemd unit, generate separate random secrets, build the plugin, and preserve service state outside the release directory. Existing Caddy sites are kept in the combined production Caddyfile.

## Important operational boundary

Never copy `plugins/DynamicAiBridge/credentials.json` between servers or publish it. A hosted plugin installation is isolated by its unique bridge token and claimed admin password; the service never ships a global Gateway secret. World writes additionally remain fail-closed until each Paper owner explicitly enables an allowed cuboid.

See [SECURITY.md](SECURITY.md) for vulnerability reporting.
