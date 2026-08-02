---
name: minecraft-builder
description: Paper 월드를 제한된 MCP 도구로 조사하고, 버전이 있는 청사진을 게시해 사람 승인 후 안전하게 시공·검증·롤백하는 절차.
---

# Minecraft Builder

월드 변경보다 관찰, 미리보기, 사람 승인, 복구 가능성을 우선한다. 범용 서버 콘솔이나 임의 코드 실행은 사용하지 않는다.

## 필수 절차

1. `server.get_status`로 Bridge 연결, TPS, MSPT, 대상 월드를 확인한다.
2. 요청 범위를 최대 64×64×64 이내의 최소 경계로 정규화한다.
3. `world.inspect_region`과 `entity.list_nearby`로 스냅샷, 영역 해시, 플레이어 거리를 확보한다.
4. `references/building-policies.md`를 적용해 금지 영역·블록·작업량을 먼저 차단한다.
5. 청사진을 만들고 `scripts/validate_blueprint.ts`로 스키마를 검증한다.
6. 자재와 변경량을 계산하고 위험 요약과 3D 미리보기를 게시한다.
7. 정확한 `planVersion`에 대한 사람 승인을 기다린다. 수정된 버전은 재승인받는다.
8. 시공 직전 영역 해시, 예약, 정책, 플레이어 반경을 다시 검사한다.
9. 최대 250블록 배치와 고유 `idempotencyKey`로 단계별 시공한다.
10. 각 체크포인트에서 진행률과 MSPT를 확인한다. 위험하면 새 배치를 시작하지 않고 정지한다.
11. 완공 후 `build.compare`로 계획과 실제를 비교하고 누락·초과·불일치를 보고한다.
12. 성공 시 예약을 해제한다. 실패 시 `references/failure-recovery.md`에 따라 정지 또는 롤백한다.

## 절대 금지

- 승인 없는 쓰기 또는 승인된 버전과 다른 청사진 시공
- 허용 영역 밖 수정, 금지 블록 배치, 원본 diff 없는 쓰기
- `STALE_SNAPSHOT`, `PLAYER_NEARBY`, `TPS_TOO_LOW` 무시
- 멱등 키 재사용이나 체크포인트를 건너뛴 다음 단계 진행
- 복구 실패 또는 외부 변경 충돌을 숨기는 행위

## 참고 라우팅

- 도구 입력·출력: `references/tool-contracts.md`
- 청사진 형식: `references/blueprint-schema.md`
- 기본 제한: `references/building-policies.md`
- 오류와 복구: `references/failure-recovery.md`
- 기본 팔레트: `references/style-palettes.md`
