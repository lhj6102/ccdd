# CCDD CLI 시연

Node 24 이상과 Pi Provider 인증을 준비합니다. 새 데모 profile은 openai-codex / gpt-6-astra / medium입니다. 서버와 브라우저는 사용하지 않습니다.

```sh
npm ci
npm run build
mkdir -p /tmp/ccdd-local-packages
npm pack --ignore-scripts --pack-destination /tmp/ccdd-local-packages
npm pack --workspace @lhj6102/ccdd-default-tools --ignore-scripts --pack-destination /tmp/ccdd-local-packages
export CCDD_DEMO_CORE_TARBALL=/tmp/ccdd-local-packages/lhj6102-ccdd-0.9.0.tgz
export CCDD_DEMO_TOOLS_TARBALL=/tmp/ccdd-local-packages/lhj6102-ccdd-default-tools-0.9.0.tgz
export CCDD_CODEX_AUTH_FILE="$HOME/.codex/auth.json" # 기존 Codex access token을 명시적으로 연결하는 예
node dist/src/cli.js prepare-demo
node dist/src/cli.js doctor --demo --scenario fixed --json
```

데모 폴더는 기본적으로 `~/.local/share/ccdd/demo-v9`에 만들어집니다. `--demo-dir PATH`로 지정할 수도 있습니다. 이전 데모 폴더와 사용자 설정은 보존합니다. 네 시나리오는 Git 없는 별도 폴더이며 현재 파일을 직접 수정할 수 있습니다. 새 데모는 `ccdd.config.ts`에서 별도 기본 도구 라이브러리를 import하여 Agent CLI 읽기·목록과 Human 데스크톱 열기를 명시적으로 등록합니다. 기본 Critic은 Agent 2개·Runtime 1개이며 Human 도구 등록 자체로 Human 요청이 생성되지는 않습니다.

준비 과정은 명시한 로컬 tarball에서 의존성을 한 번 설치하고 각 시나리오 안에 물리적으로 복사합니다. npm 공개 게시를 가정하지 않으며 공개된 전이 의존성 설치에는 네트워크 또는 로컬 캐시가 필요할 수 있습니다. 네 프로젝트의 package lock·tarball·node_modules를 함께 보존하므로 이후 snapshot은 상위 프로젝트 없이 도구를 해석합니다. 기존 v9 데모 재사용은 재설치하지 않습니다.

| 시나리오 | Why / Spec / Tests / Implementation의 최대 개수 | 확인 |
| --- | --- | --- |
| baseline | 3 / 3 / 3 / 3 | 전체 정합성 |
| why-change | 2 / 3 / 3 / 3 | Spec↔Why 불일치 |
| runtime-failure | 2 / 2 / 2 / 3 | 실제 런타임 테스트 실패 |
| fixed | 2 / 2 / 2 / 2 | 수정 후 전체 재평가 |

```sh
node dist/src/cli.js run --demo --scenario why-change --lock --critic spec-why --wait
node dist/src/cli.js run --demo --scenario runtime-failure --copy --critic implementation-tests --wait
node dist/src/cli.js run --demo --scenario fixed --copy --wait
```

Agent 판정은 실제 Provider 응답이며 표의 기대 결과를 하드코딩하지 않습니다. Runtime은 실제 Node 테스트를 실행합니다. `--critic` 단독 판정과 전체 체인 판정을 구분합니다.

같은 fixed 폴더에 두 번 `run --copy`를 요청하면 서로 다른 Handle이 같은 `workspace.path`와 `snapshotHash`를 사용할 수 있습니다. 각 리뷰는 독립된 결과와 출력 디렉터리를 갖습니다.

```sh
node dist/src/cli.js list --demo --scenario fixed
node dist/src/cli.js status RUN_ID --demo --scenario fixed
```

`--lock` 도중 원본을 수정하면 입력 변경 ERROR가 됩니다. `--copy`가 준비된 뒤 원본을 수정해도 진행 중인 리뷰는 복사된 내용으로 계속 실행됩니다. 시연 중 `ccdd monitor --repo <시나리오 폴더>`를 별도로 실행하면 요청 상태를 관찰할 수 있습니다. 모니터를 닫아도 리뷰는 계속됩니다.

Agent Artifact 도구의 이름은 `read_spec`, `list_tests`, `read_tests`입니다. Human용 `open_spec`·`open_tests`는 파일이나 폴더를 데스크톱 앱으로 열며 텍스트를 대신 반환하지 않습니다. 데모의 markdown/code 타입에 동작별 설명 템플릿이 들어 있으며 `{artifactName}`이 실제 ID로 치환됩니다. 예를 들어 `read_tests({path: "rank.test.mjs", startLine: 1, lineCount: 80})`으로 테스트 파일을 줄 단위로 읽습니다.
