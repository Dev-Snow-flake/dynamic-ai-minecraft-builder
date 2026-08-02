# DynamicAiBridge

Java 21 Paper plugin for the Quarry Gateway. It opens only an outbound authenticated WebSocket and exposes a fixed command set:

- `server.get_status`
- `build.prepare`
- `build.start`
- `build.pause`
- `build.resume`
- `build.rollback`

There is no console-command or arbitrary-code endpoint.

`build.prepare` checks the configured world and cuboid, block allowlist, loaded chunks, player exclusion distance, TPS, MSPT, duplicate coordinates, world height, and total blocks, then persists the original diff. Only a later `build.start`, sent after the Gateway records approval, can change blocks. Placement and rollback run in bounded main-thread batches without physics updates.

Fresh installs are fail-closed: `allow-world-writes` is false and `allowed-regions` is empty. Configure both explicitly. Remote Gateway URIs must use `wss://`; loopback development may use `ws://127.0.0.1`.

Build with Java 21 and Gradle 9.6.1:

```powershell
gradle build --no-daemon --warning-mode all
```

The JAR is written to `build/libs/`. Set a unique secret with `DYNAMIC_AI_BRIDGE_SECRET` when possible; otherwise protect `plugins/DynamicAiBridge/config.yml` with operating-system file permissions.
