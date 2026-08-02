# 제한 도구 계약

모든 요청은 `serverId`와 관련 `buildId`/`agentSessionId`를 포함한다. 쓰기 요청은 고유 `idempotencyKey`가 필수다. 좌표 경계는 `min` 포함, `maxExclusive` 제외다.

- 읽기: `server.get_status`, `world.inspect_region`, `world.get_changes`, `entity.list_nearby`, `build.get_job`, `build.compare`
- 계획: `build.reserve_region`, `build.publish_blueprint`, `build.request_approval`, `build.update_blueprint`
- 제어: `build.start`, `build.apply_batch`, `build.pause`, `build.resume`, `build.cancel`, `build.rollback`, `build.release_region`

응답은 `{ ok, code, message, data, retryable }` 구조를 사용한다. `ok=false`이면 `retryable=true`인 제한적 오류만 동일 의미의 새 멱등 키로 재시도한다.
