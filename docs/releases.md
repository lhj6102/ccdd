# Release 설치와 배포

CCDD는 비공개 GitHub Release에 설치용 tarball을 배포합니다. npm registry에는 게시하지 않습니다. 최신 설치 흐름은 [README](../README.md#시작하기), v2.0.0 변경 사항은 [릴리스 노트](releases/v2.0.0.md)에 있습니다.

## 배포 파일

v2.0.0부터 정의 전용 core와 Project 실행 패키지를 분리합니다. 세 패키지의 버전을 맞춰 배포합니다. 기존 v1.1.0은 core와 기본 도구 두 패키지 구성입니다.

| 파일 | 용도 |
| --- | --- |
| `lhj6102-ccdd-<version>.tgz` | Artifact·Critic·관계·도구 정의 전용 SDK |
| `lhj6102-ccdd-project-<version>.tgz` | pull 검증·CLI·Broker·Executors·Artifact Runner·모니터 |
| `lhj6102-ccdd-default-tools-<version>.tgz` | 선택적으로 등록하는 Agent 읽기·목록·이미지 관측과 Human 데스크톱 도구 |
| `verification.json` | 해당 배포의 소스와 패키지 설치 검증 기록 |
| `SHA256SUMS` | 배포 파일의 SHA-256 체크섬 |

GitHub가 별도로 제공하는 Source code 압축 파일은 소스이며, 설치용으로 빌드한 tarball은 위의 `.tgz` 파일입니다. 기본 도구 라이브러리를 사용하는 프로젝트는 같은 Release의 core·Project·기본 도구를 함께 설치합니다. Project와 기본 도구 2.x는 core `>=2.0.0 <3`를 대상으로 합니다.

## 업그레이드

실행 중인 리뷰는 원래 snapshot과 구현을 사용합니다. 새 버전은 원본 프로젝트에 설치하고 이후 요청부터 사용합니다. 기존 리뷰 상태·복사본·관측 기록은 삭제하거나 변환하지 않습니다.

1. Release의 파일을 프로젝트 안의 새 폴더에 다운로드하고 체크섬을 확인합니다.
2. `npm install --ignore-scripts <core.tgz> <project.tgz> <default-tools.tgz>`로 로컬 의존성을 갱신합니다. 사용자 도구만 쓰면 core와 Project를 설치합니다. 정의만 쓰는 경우 core만 필요합니다.
3. v1 설정은 그대로 사용할 수 있습니다. [패키지 이전과 판정 재사용](releases/v2.0.0.md#v1에서-이전)을 확인하고 `npx ccdd-project config check`와 `npx ccdd-project tools check`로 검사합니다. v1.0.0 이전에서 이전한다면 [기존 설정 변경](releases/v1.0.0.md#기존-설정에서-이전)도 반영합니다.
4. 실제 Agent를 쓸 환경에서 `npx ccdd doctor`로 인증·Provider·모델 접근을 확인한 뒤 새 리뷰를 요청합니다. 실행 중인 모니터는 새 CLI로 다시 시작합니다.

`tools check --execute`는 선택한 도구를 실제로 실행합니다. `doctor`는 실제 Provider를 호출하며 계정 사용량을 소비합니다. 배포 검증의 성공이 사용자의 인증·모델 권한이나 데스크톱 프로그램 설치를 보장하지는 않습니다.

기존 데모를 다시 준비해도 그 안의 패키지를 자동 업그레이드하지 않습니다. 편집한 데모는 유지하고 `--demo-dir`로 새 빈 폴더를 지정하세요. [데모 안내](demo.md)에 Release tarball을 사용하는 전체 명령이 있습니다.

## 커밋을 지정하여 로컬에서 배포

CCDD 소스 저장소에서 배포할 **40자리 커밋 SHA**를 명시합니다. Node 24 이상, Git, npm과 패키지 의존성을 설치할 네트워크 또는 로컬 캐시가 필요합니다. 게시는 기존 GitHub CLI(`gh`) 로그인을 사용하며 `origin` 저장소에 지정한 커밋이 있는지 확인합니다.

```sh
# COMMIT_SHA를 배포할 40자리 커밋 SHA로 바꿉니다.
npm run release -- --commit COMMIT_SHA --dry-run --output-dir /tmp/ccdd-v2.0.0-check
npm run release -- --commit COMMIT_SHA --output-dir /tmp/ccdd-v2.0.0-release
```

두 명령은 각각 실행할 수 있습니다. `--dry-run`은 전체 검증과 배포 파일 생성까지 수행하고 GitHub 인증을 요구하지 않습니다. 게시는 `--dry-run`을 뺀 명령으로 실행하며 해당 커밋을 다시 검증합니다. `--output-dir`는 선택 사항이고, 지정하면 저장소 밖의 비어 있는 디렉터리를 사용해야 합니다. 위 예시도 아직 사용하지 않은 경로를 선택하세요.

명령은 임시 clone을 만들고 지정한 커밋을 detached checkout합니다. 그곳에서 `npm ci`, 빌드·전체 테스트, 세 tarball 생성, 별도 프로젝트의 실제 설치·도구 실행·Runtime 검증을 수행합니다. 현재 작업 폴더의 미커밋 변경은 배포에 포함하지 않습니다. 검증이 통과하면 그 커밋에 버전 태그를 만들고 파일을 GitHub Release에 올립니다. 소스 커밋과 검증 환경은 `verification.json`, 파일 무결성은 `SHA256SUMS`에 기록됩니다.

이미 게시된 같은 버전은 수정 없이 건너뜁니다. 태그가 다른 커밋을 가리키면 거부하며 태그를 이동하지 않습니다. 같은 커밋의 Draft가 남아 있으면 명령을 다시 실행해 게시를 재시도할 수 있습니다. 게시된 배포 파일을 변경하려면 세 패키지 버전을 함께 올리고 새 커밋으로 배포합니다.

core·Project·기본 도구의 `package.json`과 lockfile 버전을 일치시키고, 해당 커밋에 `docs/releases/v<버전>.md`를 포함하세요. 그 문서가 Release 본문으로 사용됩니다. v2.0.0은 [이 릴리스 노트](releases/v2.0.0.md)를 사용합니다.

빌드와 검증은 명령을 실행한 컴퓨터에서 수행하며 GitHub Actions를 사용하지 않습니다. 외부 LLM 호출이나 npm registry 게시도 없습니다. 따라서 이 배포 명령으로 Actions 실행 시간이나 Provider 사용량이 발생하지 않으며, 로컬 실행 시간과 의존성 다운로드가 필요합니다.
