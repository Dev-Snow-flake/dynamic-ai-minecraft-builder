# Design Review: Quarry 운영 UI, AI 설계실, 실제 월드맵

Reviewed against: `DESIGN_BRIEF.md`

Philosophy: 창작 도구와 운영 관제의 결합

Date: 2026-08-02

## Evidence

| 화면 | 375px | 768px | 1280px |
| --- | --- | --- | --- |
| 보호 로그인 | `screenshots/login-375.png` | `screenshots/login-768.png` | `screenshots/login-1280.png` |
| 건축 작업 | `screenshots/dashboard-375.png` | `screenshots/dashboard-768.png` | `screenshots/dashboard-1280.png` |
| AI 설계 | `screenshots/ai-architect-375.png` | `screenshots/ai-architect-768.png` | `screenshots/ai-architect-1280.png` |
| 실제 BlueMap | `screenshots/world-map-375.png` | `screenshots/world-map-768.png` | `screenshots/world-map-1280.png` |

운영 URL과 인증 후 로컬 QA 세션에서 DOM, 콘솔, 반응형 레이아웃을 함께 확인했다. 운영 BlueMap 제목은 `BlueMap - overworld (overworld)`였고 375/768/1280px 모두 실제 렌더 타일을 표시했으며 콘솔 오류와 경고는 없었다.

## Outcome

출시를 막는 UI 결함은 남아 있지 않다. Refined Amber Ops 방향은 조용하고 기술적인 관제 도구라는 브리프에 부합한다. 데스크톱은 3열 현장 작업 공간, 태블릿은 승인 중심 단일 흐름, 모바일은 하단 탐색과 핵심 작업 우선 구조로 바뀌며 수평 오버플로가 없다.

검수 중 다음 오해 가능성을 수정했다.

- 초기 예시의 “안전 검사 통과”, “부지 예약 완료”, “활성 Agent” 표현을 모두 실행 불가 미리보기로 교체했다.
- Paper Bridge가 끊긴 상태의 0 TPS를 정상 온라인처럼 표시하던 상태점을 오프라인으로 교체했다.
- OpenAI 키가 환경변수로만 설정 가능하다는 오래된 안내를 관리자 암호화 저장소 안내로 수정했다.
- 실제 BlueMap 타일과 Three.js 리소스팩 텍스처 미리보기의 역할을 명확히 분리했다.

## Must Fix

없음.

## Should Fix

1. **BlueMap 청사진 경계 오버레이:** 실제 월드는 표시되지만 선택한 청사진 bounds가 BlueMap 좌표 위에 아직 그려지지 않는다. BlueMap marker set 연동이 다음 공간 맥락 개선 항목이다.
2. **자동 접근성 회귀 검사:** 입력 라벨, landmark, 포커스 표시, reduced-motion은 수동 확인했지만 axe 기반 CI와 승인 모달 포커스 트랩 테스트는 아직 없다.
3. **밝은 테마 스냅샷:** 이번 운영 증적은 주 사용 테마인 다크 테마 중심이다. 밝은 테마 대비 회귀 이미지를 CI에 추가할 가치가 있다.

## Could Improve

1. Three.js는 별도 lazy chunk로 분리됐지만 압축 전 553.67KB다. 첫 로그인 번들은 247.45KB이며 3D 화면을 열 때만 큰 청크를 받는다.
2. BlueMap 기본 회색 컨트롤을 Quarry amber/green 토큰으로 맞추면 두 화면의 시각적 연결감이 더 좋아진다.
3. AI 대화는 서버 전송 시 최근 12개로 제한되지만, 매우 긴 브라우저 세션을 위한 메시지 가상화도 추가할 수 있다.

## What Works Well

- 인증 전에는 관리자 로그인만 노출되고 월드 제어·API 키·이벤트 데이터는 보이지 않는다.
- AI 결과는 실제 월드에 바로 쓰이지 않고 실행 가능한 청사진과 사람 승인 단계로 게시된다.
- 월드명과 X/Y/Z 원점을 명시적으로 입력하며 승인 때 Paper가 영역·청크·플레이어·TPS·원본 diff를 재검사한다.
- API 키 미설정, 이미지 첨부, 생성 중, 오류, 게시 성공 상태가 텍스트와 아이콘으로 구분된다.
- 실제 리소스팩 블록 표면과 실제 BlueMap 월드가 가상 플레이스홀더 없이 렌더링된다.
- 모바일 핵심 버튼은 하단 탐색과 단일 열 흐름으로 접근 가능하고 데스크톱 정보 밀도도 유지된다.
