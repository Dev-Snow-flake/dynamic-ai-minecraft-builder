# Security and production audit

Date: 2026-08-02

Production: `https://map.work-plus.kr`

## Final status

The web control plane, Gateway, Paper Bridge, Caddy route, BlueMap route, and packaged Minecraft textures are deployed and healthy. The production plugin remains fail-closed: `allow-world-writes: false` and `allowed-regions: []`.

## Resolved findings

### Critical

- Removed the spoofable browser `X-Role` authorization path. Every API and browser event socket now requires a server-issued HttpOnly session; roles are enforced on the Gateway.
- Added per-session CSRF protection for every state-changing API request.
- Replaced simulated build progress with a bounded Paper executor. The plugin accepts only fixed build methods and never arbitrary console commands or code.
- Added a two-phase execution protocol: Paper validates and persists the original diff, the Gateway records human approval, and only then can Paper start writing.
- Added exact world, cuboid, block allowlist, height, duplicate-coordinate, loaded-chunk, nearby-player, TPS, MSPT, total-block, and batch-size checks.
- Added original-state persistence, crash recovery, completion validation, reverse rollback, and external-change conflict preservation.

### High

- Removed the bridge development-secret fallback, required a 32-character secret, used constant-time comparison, and required `wss://` for non-loopback Gateways.
- Required bridge registration with the configured server ID before any status, response, or build event is accepted.
- Pauses before the next block write when the Gateway disconnects or an operator requests a pause.
- Added encrypted-at-rest OpenAI key storage using AES-256-GCM. Plaintext keys are never returned to the browser or stored in browser storage.
- Added login and AI request rate limits, trusted-proxy-aware client addressing, origin checks, bounded JSON bodies, and bounded WebSocket payloads.

### Medium and operational

- Moved Gateway state and encrypted keys to `/var/lib/dynamic-ai`, outside replaceable releases, with mode 0700/0600.
- Hardened the systemd unit with a dedicated `dynamic-ai` user, strict filesystem protection, private devices/tmp, no new privileges, empty capabilities, and kernel/control-group restrictions.
- Preserved existing plugin policy during deployments and secret rotation instead of overwriting allowed regions.
- Preserved packaged legal Minecraft textures during server builds; public source builds fall back without committing Mojang assets.
- Tightened the Velocity forwarding secret from mode 0664 to 0600.
- Added explicit cache, CSP, HSTS, referrer, permissions, and content-type headers at Caddy.
- Removed unused production dependencies; `npm audit --omit=dev` reports zero known vulnerabilities.

## Verification evidence

- TypeScript typecheck: pass.
- Automated tests: 12 pass, 0 fail.
- Production web build: pass.
- Paper plugin Gradle/Java 21 build: pass with no deprecation warning.
- Production login: Admin session issued successfully.
- Missing CSRF mutation: HTTP 403.
- Unauthenticated session API: HTTP 401.
- Paper Bridge: connected, 20 TPS, world `world`.
- Gateway systemd service: active with hardening enabled.
- Caddy configuration: valid.
- Main site, BlueMap, manifest, and a real block texture: HTTP 200.
- BlueMap visual QA: 375/768/1280px, no browser console warnings or errors.

## Intentional safety gates and remaining decisions

1. **No live block-write smoke test was run.** The owner has not selected a disposable cuboid. Enabling writes or choosing coordinates by assumption could damage the world, so production remains locked.
2. **The hosted Gateway is single-server.** The released JAR can be used with a self-hosted Gateway, but letting arbitrary servers use one central `map.work-plus.kr` instance safely requires per-server enrollment, unique tokens, tenant isolation, and server selection in the UI. A shared global plugin secret will not be published.
3. **The existing Paper process runs as root.** The new Gateway does not. Migrating the pre-existing Paper installation to a dedicated OS account affects its worlds, plugins, tmux workflow, and file ownership and should be scheduled as a separate maintenance operation.
4. BlueMap's own route retains the inline/eval CSP allowances required by its current client bundle. Those allowances are isolated to `/live-map/`; the control center uses a stricter CSP.

## Secret handling

No real API key, bridge secret, administrator password, forwarding secret, private key, Minecraft texture pack, world diff, or player data is included in source control. Any key pasted into chat should be considered exposed and revoked; it is not reused by this deployment.
