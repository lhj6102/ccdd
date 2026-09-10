# Release 설치와 배포

CCDD는 GitHub Release tarball과 공개 npm registry 배포를 지원합니다. 두 배포 명령은 지정한 커밋을 로컬에서 빌드·검증하며 GitHub Actions를 사용하지 않습니다. npm 설치는 첫 게시가 완료된 버전부터 사용할 수 있습니다. 최신 설치 흐름은 [README](../README.md#시작하기), v2.0.1 이름 변경과 이전 방법은 [릴리스 노트](releases/v2.0.1.md)에 있습니다.

## 배포 파일

v2.0.0부터 정의 전용 core와 Project 실행 패키지를 분리합니다. v2.0.1부터 아래 `@ccdd` 패키지 이름과 파일명을 사용하며 세 패키지의 버전을 맞춰 배포합니다. 과거 배포 파일은 `lhj6102-ccdd-*` 이름을 유지합니다. 기존 v1.1.0은 core와 기본 도구 두 패키지 구성입니다.

| 파일 | 용도 |
| --- | --- |
| `ccdd-core-<version>.tgz` | Artifact·Critic·관계·도구 정의 전용 SDK |
| `ccdd-project-<version>.tgz` | pull 검증·CLI·Broker·Executors·Artifact Runner·모니터 |
| `ccdd-default-tools-<version>.tgz` | 선택적으로 등록하는 Agent 읽기·목록·이미지 관측과 Human 데스크톱 도구 |
| `verification.json` | 해당 배포의 소스와 패키지 설치 검증 기록 |
| `SHA256SUMS` | 배포 파일의 SHA-256 체크섬 |

GitHub가 별도로 제공하는 Source code 압축 파일은 소스이며, 설치용으로 빌드한 tarball은 위의 `.tgz` 파일입니다. 기본 도구 라이브러리를 사용하는 프로젝트는 같은 Release의 core·Project·기본 도구를 함께 설치합니다. Project와 기본 도구 2.x는 core `>=2.0.0 <3`를 대상으로 합니다.

## 업그레이드

실행 중인 리뷰는 원래 snapshot과 구현을 사용합니다. 새 버전은 원본 프로젝트에 설치하고 이후 요청부터 사용합니다. 기존 리뷰 상태·복사본·관측 기록은 삭제하거나 변환하지 않습니다.

1. Release의 파일을 프로젝트 안의 새 폴더에 다운로드하고 체크섬을 확인합니다.
2. `npm install --ignore-scripts <core.tgz> <project.tgz> <default-tools.tgz>`로 로컬 의존성을 갱신합니다. 사용자 도구만 쓰면 core와 Project를 설치합니다. 정의만 쓰는 경우 core만 필요합니다.
3. v2.0.1에서는 [npm 패키지 이름과 import 이전](releases/v2.0.1.md#이전)을 반영합니다. v1에서는 [Project 이전과 판정 재사용](releases/v2.0.0.md#v1에서-이전)도 확인하고 `npx ccdd-project config check`와 `npx ccdd-project tools check`로 검사합니다. v1.0.0 이전에서 이전한다면 [기존 설정 변경](releases/v1.0.0.md#기존-설정에서-이전)도 반영합니다.
4. 실제 Agent를 쓸 환경에서 `npx ccdd doctor`로 인증·Provider·모델 접근을 확인한 뒤 새 리뷰를 요청합니다. 실행 중인 모니터는 새 CLI로 다시 시작합니다.

`tools check --execute`는 선택한 도구를 실제로 실행합니다. `doctor`는 실제 Provider를 호출하며 계정 사용량을 소비합니다. 배포 검증의 성공이 사용자의 인증·모델 권한이나 데스크톱 프로그램 설치를 보장하지는 않습니다.

기존 데모를 다시 준비해도 그 안의 패키지를 자동 업그레이드하지 않습니다. 편집한 데모는 유지하고 `--demo-dir`로 새 빈 폴더를 지정하세요. [데모 안내](demo.md)에 Release tarball을 사용하는 전체 명령이 있습니다.

## 커밋을 지정하여 로컬에서 배포

CCDD 소스 저장소에서 배포할 **40자리 커밋 SHA**를 명시합니다. Node 24 이상, Git, npm과 패키지 의존성을 설치할 네트워크 또는 로컬 캐시가 필요합니다. 게시는 기존 GitHub CLI(`gh`) 로그인을 사용하며 `origin` 저장소에 지정한 커밋이 있는지 확인합니다.

```sh
# COMMIT_SHA를 배포할 40자리 커밋 SHA로 바꿉니다.
npm run release -- --commit COMMIT_SHA --dry-run --output-dir /tmp/ccdd-v2.0.1-check
npm run release -- --commit COMMIT_SHA --output-dir /tmp/ccdd-v2.0.1-release
```

두 명령은 각각 실행할 수 있습니다. `--dry-run`은 전체 검증과 배포 파일 생성까지 수행하고 GitHub 인증을 요구하지 않습니다. 게시는 `--dry-run`을 뺀 명령으로 실행하며 해당 커밋을 다시 검증합니다. `--output-dir`는 선택 사항이고, 지정하면 저장소 밖의 비어 있는 디렉터리를 사용해야 합니다. 위 예시도 아직 사용하지 않은 경로를 선택하세요.

명령은 임시 clone을 만들고 지정한 커밋을 detached checkout합니다. 그곳에서 `npm ci`, 빌드·전체 테스트, 세 tarball 생성, 별도 프로젝트의 실제 설치·도구 실행·Runtime 검증을 수행합니다. 현재 작업 폴더의 미커밋 변경은 배포에 포함하지 않습니다. 검증이 통과하면 그 커밋에 버전 태그를 만들고 파일을 GitHub Release에 올립니다. 소스 커밋과 검증 환경은 `verification.json`, 파일 무결성은 `SHA256SUMS`에 기록됩니다.

이미 게시된 같은 버전은 수정 없이 건너뜁니다. 태그가 다른 커밋을 가리키면 거부하며 태그를 이동하지 않습니다. 같은 커밋의 Draft가 남아 있으면 명령을 다시 실행해 게시를 재시도할 수 있습니다. 게시된 배포 파일을 변경하려면 세 패키지 버전을 함께 올리고 새 커밋으로 배포합니다.

core·Project·기본 도구의 `package.json`과 lockfile 버전을 일치시키고, 해당 커밋에 `docs/releases/v<버전>.md`를 포함하세요. 그 문서가 Release 본문으로 사용됩니다. v2.0.1은 [이 릴리스 노트](releases/v2.0.1.md)를 사용합니다.

빌드와 검증은 명령을 실행한 컴퓨터에서 수행하며 GitHub Actions를 사용하지 않습니다. 위 GitHub 배포 명령은 npm registry에 게시하지 않습니다. 두 배포 경로 모두 외부 LLM을 호출하지 않으므로 Actions 실행 시간이나 Provider 사용량이 발생하지 않으며, 로컬 실행 시간과 의존성 다운로드가 필요합니다.

## npm 공개 배포

세 패키지를 `https://registry.npmjs.org/`에 `public` 접근과 `latest` 태그로 게시합니다. GitHub 저장소 공개 범위와는 별개로, 게시된 npm 패키지 파일은 누구나 다운로드할 수 있습니다. `@ccdd` 조직의 게시 권한이 있는 npm 계정이 필요합니다. 개인 계정 `lhj6102`로 로그인한 것만으로 `@ccdd` 범위를 사용할 수 있는 것은 아닙니다.

```sh
nvm use # nvm 사용 시 .nvmrc의 Node 24 선택
npm run release:npm:check
# npm 배포 설정이 포함된 커밋의 40자리 SHA를 사용합니다.
npm run release:npm -- --commit COMMIT_SHA --dry-run --output-dir /tmp/ccdd-npm-check

# 실제 게시 시 로컬 npm 인증과 필요에 따라 2FA를 사용합니다.
npm login --registry=https://registry.npmjs.org/
npm run release:npm -- --commit COMMIT_SHA --output-dir /tmp/ccdd-npm-release
```

`release:npm:check`는 Node·npm 버전, 로그인 계정, 이메일 확인 상태, 2FA 설정, `ccdd` 조직 역할을 읽기 전용으로 확인합니다. 계정 토큰이나 이메일 주소는 출력하지 않습니다. `Scope not found`이면 `ccdd` 조직 생성 또는 기존 조직 접근 권한을 먼저 확인해야 합니다. npm 웹사이트의 Add an Organization에서 이름 `ccdd`와 공개 패키지 무료 플랜을 선택할 수 있습니다. 이름 확보 가능 여부는 생성 화면에서 최종 확인합니다. [npm 조직 생성 안내](https://docs.npmjs.com/creating-an-organization/)를 참고하세요.

`release:npm`은 `release --npm`과 같습니다. 실제 게시는 빌드 전에 같은 환경 검사를 통과해야 합니다. 지정한 커밋을 임시 clone에서 설치·빌드·전체 테스트한 뒤, 세 tarball의 파일 목록·체크섬과 별도 프로젝트의 실제 설치·도구 실행·Runtime·검증 재사용을 검사합니다. 검증된 tarball 바이트를 그대로 `npm publish --ignore-scripts --access=public`에 전달합니다. GitHub 인증이나 Release 생성은 필요하지 않습니다. npm 인증은 게시 프로세스만 사용하고 빌드·테스트에는 전달하지 않습니다.

`--dry-run`도 같은 검증을 수행하고 마지막에 각 tarball의 `npm publish --dry-run`을 실행합니다. npm 공개 메타데이터와 의존성을 조회할 네트워크는 필요하지만 npm 로그인이나 registry 쓰기는 없습니다. 이 검사는 실제 계정의 게시 권한이나 2FA 성공을 보장하지 않습니다.

게시 전에 세 패키지의 해당 버전을 모두 조회합니다. 기존 버전의 SHA-512 integrity가 검증된 tarball과 같으면 건너뛰며, 다르면 어떤 패키지도 새로 게시하지 않고 종료합니다. core → Project → 기본 도구 순서로 게시하고 registry의 integrity를 확인합니다. 중간에 실패하면 같은 커밋으로 다시 실행해 남은 패키지를 게시할 수 있습니다. 출력 경로를 지정했다면 재시도에는 새 빈 경로를 사용하세요. 세 패키지 게시가 하나의 트랜잭션은 아니므로 완료 전에는 일부만 조회될 수 있습니다.

게시된 버전의 내용은 교체할 수 없습니다. GitHub와 npm에 같은 배포 파일을 제공하려면 세 패키지와 lockfile의 버전을 함께 올리고 새 릴리스 노트를 커밋한 뒤, 두 명령에 같은 커밋을 지정합니다. 기존 GitHub Release tarball은 `private: true`를 포함하므로 그대로 npm에 게시할 수 없습니다.

게시 후 버전을 확인하고 같은 버전의 패키지들을 설치할 수 있습니다.

```sh
npm view @ccdd/core version --registry=https://registry.npmjs.org/
npm view @ccdd/project version --registry=https://registry.npmjs.org/
npm view @ccdd/default-tools version --registry=https://registry.npmjs.org/
# VERSION을 위에서 확인한 세 패키지의 동일 버전으로 바꿉니다.
npm install --ignore-scripts @ccdd/core@VERSION @ccdd/project@VERSION @ccdd/default-tools@VERSION
```

npm 동작 기준: [publish와 버전 불변성](https://docs.npmjs.com/cli/v11/commands/npm-publish/), [공개 scoped 패키지](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/).
