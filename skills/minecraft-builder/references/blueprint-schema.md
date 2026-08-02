# 청사진 규칙

청사진은 실행 스크립트가 아니라 불변 선언형 데이터다. `schemaVersion`, `blueprintId`, `buildId`, `planVersion`, `worldId`, `origin`, `bounds`, `intent`, `palette`, `phases`, `estimates`, `constraints`, `sourceSnapshotId`, `sourceRegionHash`가 필수다.

팔레트 값은 `minecraft:oak_stairs[facing=north,half=bottom]`처럼 정규화한다. 큰 배치 데이터는 팔레트 + RLE 파일로 분리하고 청사진에서는 `placementRef`로 참조한다.
