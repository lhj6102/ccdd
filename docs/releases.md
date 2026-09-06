# Release 설치와 배포

CCDD는 비공개 GitHub Release에 설치용 tarball을 배포합니다. npm registry에는 게시하지 않습니다. 최신 설치 흐름은 [README](../README.md#시작하기), v1.0.0 변경 사항은 [릴리스 노트](releases/v1.0.0.md)에 있습니다.

## 배포 파일

| 파일 | 용도 |
| --- | --- |
| `lhj6102-ccdd-1.0.0.tgz` | CLI·Broker·Executors·Artifact Runner·빌드된 모니터 화면 |
| `lhj6102-ccdd-default-tools-1.0.0.tgz` | 선택적으로 등록하는 Agent 읽기·목록과 Human 데스크톱 도구 |
| `verification.json` | 해당 배포의 소스와 패키지 설치 검증 기록 |
| `SHA256SUMS` | 배포 파일의 SHA-256 체크섬 |

GitHub가 별도로 제공하는 Source code 압축 파일은 소스이며, 설치용으로 빌드한 tarball은 위의 `.tgz` 파일입니다. 기본 도구 라이브러리를 사용하는 프로젝트는 같은 Release의 두 패키지를 함께 설치합니다. 라이브러리 1.x는 본체 `>=1.0.0 <2`를 대상으로 합니다.

## 업그레이드

실행 중인 리뷰는 원래 snapshot과 구현을 사용합니다. 새 버전은 원본 프로젝트에 설치하고 이후 요청부터 사용합니다. 기존 리뷰 상태·복사본·관측 기록은 삭제하거나 변환하지 않습니다.

1. Release의 파일을 프로젝트 안의 새 폴더에 다운로드하고 체크섬을 확인합니다.
2. `npm install --ignore-scripts <core.tgz> <default-tools.tgz>`로 로컬 의존성을 갱신합니다. 사용자 도구만 쓰면 core만 설치합니다.
3. [설정 변경 사항](releases/v1.0.0.md#기존-설정에서-이전)을 반영하고 `npx ccdd tools check`로 등록한 도구를 확인합니다.
4. 실제 Agent를 쓸 환경에서 `npx ccdd doctor`로 인증·Provider·모델 접근을 확인한 뒤 새 리뷰를 요청합니다. 실행 중인 모니터는 새 CLI로 다시 시작합니다.

`tools check --execute`는 선택한 도구를 실제로 실행합니다. `doctor`는 실제 Provider를 호출하며 계정 사용량을 소비합니다. Release CI의 성공이 사용자의 인증·모델 권한이나 데스크톱 프로그램 설치를 보장하지는 않습니다.

기존 데모를 다시 준비해도 그 안의 패키지를 자동 업그레이드하지 않습니다. 편집한 데모는 유지하고 `--demo-dir`로 새 빈 폴더를 지정하세요. [데모 안내](demo.md)에 Release tarball을 사용하는 전체 명령이 있습니다.

## 자동 배포

[release.yml](../.github/workflows/release.yml)이 `main`에 머지되면 자동 배포가 활성화됩니다. 이후 버전·패키지·Release 관련 파일이 `main`에서 변경되면 아직 게시되지 않은 패키지 버전으로 GitHub Release를 만듭니다. PR에서는 쓰기 권한 없이 검증하고 Release를 게시하지 않습니다. 필요하면 Actions의 **Run workflow**로 `main`에서 수동 실행할 수 있습니다.

검증은 Node 24와 Ubuntu에서 의존성 설치, 빌드·전체 테스트, 두 tarball 생성, 별도 프로젝트의 설치·실행 검사를 수행합니다. 통과한 파일만 게시 작업으로 전달합니다. 검증 작업은 `contents: read`, 게시 작업만 `contents: write`를 가지며 추가 Provider 인증키는 필요하지 않습니다.

`main`에서 게시된 같은 버전이 있으면 재빌드와 덮어쓰기를 건너뜁니다. PR 검증은 계속 수행합니다. 배포 파일을 수정하려면 두 패키지 버전을 함께 올려 새 Release를 만듭니다. 버전은 본체·기본 도구의 `package.json`과 lockfile에 일치하도록 반영하고, `docs/releases/v<버전>.md`에 릴리스 노트를 추가합니다. v1.0.0의 본문은 이 저장소의 [릴리스 노트](releases/v1.0.0.md)를 사용합니다.

OS 매트릭스 없이 Ubuntu에서 검증하며, 제한 시간은 검증 20분·게시 5분입니다. 작업 간 파일 보관은 1일로 제한합니다. 외부 LLM 호출, npm 게시, 주기적인 예약 실행은 없습니다. 실제 Actions 비용은 계정의 포함 사용량·요금제와 실행 시간에 따라 달라지며, 이 시간 제한이 매번 사용되는 실행 시간은 아닙니다.
