# CCDD CLI 시연

Node 24 이상에서 core·Project·기본 도구의 [Release 설치](../README.md#시작하기)를 마친 프로젝트를 기준으로 합니다. Project의 CLI로 실행하고, 각 시나리오에는 설정이 import하는 core·기본 도구만 설치합니다. Agent 시나리오에는 Pi Provider 인증이 필요하며 profile은 openai-codex / gpt-6-astra / medium입니다. CLI만으로 시연할 수 있고 모니터는 선택 사항입니다.

```sh
export CCDD_DEMO_CORE_TARBALL="$PWD/vendor/ccdd/lhj6102-ccdd-2.0.0.tgz"
export CCDD_DEMO_TOOLS_TARBALL="$PWD/vendor/ccdd/lhj6102-ccdd-default-tools-2.0.0.tgz"
export CCDD_DEMO_DIR="$HOME/.local/share/ccdd/demo-2.0.0"
export CCDD_CODEX_AUTH_FILE="$HOME/.codex/auth.json" # 기존 Codex access token을 명시적으로 연결하는 예
npx ccdd prepare-demo --demo-dir "$CCDD_DEMO_DIR"
npx ccdd doctor --demo --demo-dir "$CCDD_DEMO_DIR" --scenario fixed --json
```

위 예시는 새 `demo-2.0.0` 폴더를 사용합니다. `--demo-dir`를 생략하면 기존 기본 경로인 `~/.local/share/ccdd/demo-v9`를 사용합니다. `v9`는 데모 형식 버전이며 CCDD 패키지 버전과 별개입니다. 이전 데모 폴더와 사용자 설정은 보존합니다. 네 시나리오는 Git 없는 별도 폴더이며 현재 파일을 직접 수정할 수 있습니다. 새 데모는 `ccdd.config.ts`에서 별도 기본 도구 라이브러리를 import하여 Agent CLI 읽기·목록과 Human 데스크톱 열기를 명시적으로 등록합니다. 기본 Critic은 Agent 2개·Runtime 1개이며 Human 도구 등록 자체로 Human 요청이 생성되지는 않습니다.

준비 과정은 명시한 로컬 tarball에서 의존성을 한 번 설치하고 각 시나리오 안에 물리적으로 복사합니다. npm 공개 게시를 가정하지 않으며 공개된 전이 의존성 설치에는 네트워크 또는 로컬 캐시가 필요할 수 있습니다. 네 프로젝트의 package lock·tarball·node_modules를 함께 보존하므로 이후 snapshot은 상위 프로젝트 없이 도구를 해석합니다. 기존 데모 재사용은 재설치하지 않으므로 새 Release를 시험할 때는 비어 있는 `--demo-dir`를 선택합니다.

| 시나리오 | Why / Spec / Tests / Implementation의 최대 개수 | 확인 |
| --- | --- | --- |
| baseline | 3 / 3 / 3 / 3 | 전체 정합성 |
| why-change | 2 / 3 / 3 / 3 | Spec↔Why 불일치 |
| runtime-failure | 2 / 2 / 2 / 3 | 실제 런타임 테스트 실패 |
| fixed | 2 / 2 / 2 / 2 | 수정 후 전체 재평가 |

```sh
npx ccdd run --demo --demo-dir "$CCDD_DEMO_DIR" --scenario why-change --lock --critic spec-why --wait
npx ccdd run --demo --demo-dir "$CCDD_DEMO_DIR" --scenario runtime-failure --copy --critic implementation-tests --wait
npx ccdd run --demo --demo-dir "$CCDD_DEMO_DIR" --scenario fixed --copy --wait
```

Agent 판정은 실제 Provider 응답이며 표의 기대 결과를 하드코딩하지 않습니다. Runtime은 실제 Node 테스트를 실행합니다. `--critic` 단독 판정과 전체 체인 판정을 구분합니다.

같은 fixed 폴더에 두 번 `run --copy`를 요청하면 서로 다른 Handle이 같은 `workspace.path`와 `snapshotHash`를 사용할 수 있습니다. 각 리뷰는 독립된 결과와 출력 디렉터리를 갖습니다.

```sh
npx ccdd list --demo --demo-dir "$CCDD_DEMO_DIR" --scenario fixed
npx ccdd status RUN_ID --demo --demo-dir "$CCDD_DEMO_DIR" --scenario fixed
```

`--lock` 도중 원본을 수정하면 입력 변경 ERROR가 됩니다. `--copy`가 준비된 뒤 원본을 수정해도 진행 중인 리뷰는 복사된 내용으로 계속 실행됩니다. 시연 중 `ccdd monitor --repo <시나리오 폴더>`를 별도로 실행하면 요청 상태를 관찰할 수 있습니다. 모니터를 닫아도 리뷰는 계속됩니다.

Agent Artifact 도구의 이름은 `read_spec`, `list_tests`, `read_tests`입니다. Human용 `open_spec`·`open_tests`는 파일이나 폴더를 데스크톱 앱으로 열며 텍스트를 대신 반환하지 않습니다. 기본 데스크톱 연결은 macOS용이며 다른 OS에서 Human 도구를 쓸 때는 실행 프로그램을 명시합니다. 데모의 markdown/code 타입에 동작별 설명 템플릿이 들어 있으며 `{artifactName}`이 실제 ID로 치환됩니다. 예를 들어 `read_tests({path: "rank.test.mjs", startLine: 1, lineCount: 80})`으로 테스트 파일을 줄 단위로 읽습니다.

## 소스에서 tarball 준비

Release 대신 수정 중인 소스를 시험하려면 CCDD 저장소에서 다음을 실행합니다. 이후 위의 tarball 환경변수만 생성한 파일의 절대경로로 바꾸면 됩니다.

```sh
npm ci
npm run build
mkdir -p /tmp/ccdd-local-packages
npm pack --ignore-scripts --pack-destination /tmp/ccdd-local-packages
npm pack --workspace @lhj6102/ccdd-default-tools --ignore-scripts --pack-destination /tmp/ccdd-local-packages
export CCDD_DEMO_CORE_TARBALL=/tmp/ccdd-local-packages/lhj6102-ccdd-2.0.0.tgz
export CCDD_DEMO_TOOLS_TARBALL=/tmp/ccdd-local-packages/lhj6102-ccdd-default-tools-2.0.0.tgz
```

위 명령은 현재 소스를 직접 pack합니다. 커밋에 고정된 소스를 전체 테스트·설치 검증까지 거쳐 준비하려면 `npm run release -- --commit <40자리 SHA> --dry-run --output-dir <빈 외부 디렉터리>`를 사용하고 그 출력 폴더의 두 tarball을 지정합니다. [로컬 배포 안내](releases.md#커밋을-지정하여-로컬에서-배포)에 전체 절차가 있습니다.

소스 CLI는 `npx ccdd` 대신 `node dist/src/cli.js`로 실행합니다. 실제 Agent 진단·리뷰는 Provider 사용량을 소비합니다. 로컬 Release 검증은 외부 LLM을 호출하지 않으므로 설치 환경의 인증·모델 접근 여부는 이 데모의 `doctor`로 확인합니다.
