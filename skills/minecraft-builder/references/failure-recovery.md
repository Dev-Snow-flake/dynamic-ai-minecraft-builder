# 실패와 복구

- `STALE_SNAPSHOT`: 재조사, 새 버전 게시, 재승인
- `PLAYER_NEARBY`, `TPS_TOO_LOW`: 현재 배치 후 정지, 조건 회복 뒤 재검사
- `REGION_CONFLICT`: 다른 위치 또는 예약 만료까지 대기
- `PROHIBITED_BLOCK`: 팔레트를 수정하고 새 버전 게시
- `BRIDGE_DISCONNECTED`: 새 배치 금지, 재연결 후 sequence 재동기화
- `ROLLBACK_CONFLICT`: 자동 덮어쓰기 금지, 충돌 좌표를 운영자에게 보고

롤백은 가장 최근 체크포인트부터 역순으로 수행하고, 완료 뒤 원본 영역 해시를 비교한다.
