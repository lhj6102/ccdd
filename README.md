# CCDD

**Critic 중계 브로커와 Artifact Runner를 하나의 npm 패키지로 실행합니다.**

현재 작업 폴더에서 리뷰를 요청하면 CCDD가 Agent·테스트 런타임·Human 실행기에 연결하고 판정과 근거를 저장합니다. Git commit과 상주 daemon 없이 사용합니다. Artifact Runner는 요청에 선언된 Artifact를 Agent·Human 각각의 관측 도구에 연결합니다.

## 시작하기

Node.js 24 이상이 필요합니다. Agent 리뷰는 Pi Agent Core와 Pi AI 라이브러리로 실행하며, 요청한 Provider·모델을 사용할 인증이 필요합니다. 전체 소스와 테스트는 strict TypeScript로 작성하고 JavaScript로 빌드합니다.

```sh
npm ci
npm run build
node dist/src/cli.js doctor --repo /path/to/project --json
node dist/src/cli.js run --repo /path/to/project --copy --critic tests-spec --wait --json
```

npm 패키지를 설치했다면 `node dist/src/cli.js` 대신 `ccdd`를 사용합니다. 실제 Agent 진단과 리뷰는 계정 사용량을 소비합니다.

## Agent Provider와 인증

Agent profile은 Pi의 정확한 Provider·모델 ID와 reasoning을 명시합니다. 예:

```json
{"kind":"agent","provider":"openai-codex","model":"gpt-6-astra","reasoning":"medium"}
```

`@earendil-works/pi-agent-core`와 `@earendil-works/pi-ai` 0.85.1을 라이브러리로 사용합니다. Pi 의존성은 Agent 실행기 내부에 있고 Broker·Human·Runtime은 Pi 세션을 사용하지 않습니다. Provider 호출과 Agent 도구 루프를 Pi에 맡기며, CCDD가 판정 스키마·필수 Artifact 관측·workspace 무결성을 검증합니다.

Provider API key 환경변수는 Pi의 Provider별 규칙을 따릅니다. 파일 인증은 명시적으로 연결합니다.

```sh
ccdd doctor --repo /path/to/project --pi-auth-file /outside/repo/pi-auth.json --json
ccdd run --repo /path/to/project --copy --pi-auth-file /outside/repo/pi-auth.json --wait
```

Pi 파일 형식은 Provider ID별 credential 객체입니다. 예를 들어 API key는 `{"anthropic":{"type":"api_key","key":"..."}}`, OAuth는 `{"openai-codex":{"type":"oauth","access":"...","refresh":"...","expires":1234567890000}}` 형태입니다. 토큰은 해당 로그인 도구에서 발급받으며, repo와 리뷰 상태에 저장하지 않습니다.

기존 Codex 인증을 사용할 때도 경로를 직접 지정합니다.

```sh
ccdd doctor --repo /path/to/project --codex-auth-file "$HOME/.codex/auth.json" --json
```

이 연결은 유효한 access token만 읽으며 공유 refresh token을 Pi에 전달하거나 파일을 변경하지 않습니다. Pi 인증 파일도 현재는 읽기 전용으로 연결합니다. 만료됐거나 5분 안에 만료될 OAuth는 거부하며, 발급 도구에서 인증을 갱신한 뒤 다시 실행해야 합니다. 인증을 자동 승계하거나 로그인·갱신을 대신하지 않습니다.

환경변수 `CCDD_PI_AUTH_FILE`·`CCDD_CODEX_AUTH_FILE`로 경로를 지정할 수도 있습니다. worker에는 경로만 저장하고, Human 결과 제출이나 `resume`은 원래 실행 설정을 다시 사용합니다. Provider API key 환경변수는 실행·재개 프로세스에서 사용할 수 있어야 합니다.

미지원 Provider·모델·reasoning을 다른 설정으로 대체하지 않습니다. 기존 `provider: "codex"`는 Pi의 `openai-codex`로 명시적으로 바꿔야 합니다. Pi 0.85.1은 `openai`와 `openai-codex`의 `gpt-6-astra`를 지원합니다. Astra reasoning은 `low`·`medium`·`high`·`xhigh`·`max`를 그대로 적용하며, `off`·`minimal`·`ultra`는 거부합니다. 새 데모는 `openai-codex / gpt-6-astra / medium`을 명시합니다. 현재 지원 범위는 [Pi 공식 문서](https://github.com/earendil-works/pi/tree/main/packages/ai)를 참고하고, 실제 접근은 `doctor`로 확인하세요.

## 리뷰 입력 선택

`run`은 `--copy` 또는 `--lock` 중 하나를 명시해야 합니다. 두 옵션을 동시에 사용할 수 없습니다.

| 옵션 | 입력 | 수정 정책 |
| --- | --- | --- |
| `--copy` · 권장 | 현재 repo 전체의 복사본 | 복사가 끝나면 원본을 수정할 수 있습니다. |
| `--lock` | 현재 workspace 전체 | 리뷰 중 변경이 검출되면 `ERROR`로 실패합니다. |

커밋 여부와 ignore 규칙에 관계없이 모든 파일이 대상입니다. `.git`, 의존성 디렉터리, 새 파일도 포함합니다. 상대경로·내용·파일 유형·실행 권한으로 계산한 SHA-256이 같은 복사본은 동시에 여러 리뷰에서 재사용합니다. 판정은 매번 실행하며, 입력 공유가 판정 재사용을 의미하지 않습니다.

공유 복사본은 읽기 전용입니다. 테스트 출력은 `CCDD_OUTPUT_DIR`, 임시 파일은 `CCDD_TMP_DIR` 또는 `TMPDIR`에 작성합니다. CCDD의 상태·로그·복사본·리뷰 출력은 repo 밖에 저장합니다. 기본 경로는 `~/.local/state/ccdd/<repo 식별자>`이며, `--state-dir` 또는 `CCDD_STATE_HOME`으로 변경합니다.

`--lock`은 쓰기를 강제로 막는 기능이 아닙니다. 파일 이벤트와 메타데이터, 내용 검증으로 변경을 감시합니다. 감시할 수 없는 환경에서는 실행을 거부합니다. 원본을 수정한 후 내용을 되돌려도 변경으로 검출되면 실패합니다. 자세한 범위와 제한은 [workspace 계약](docs/contracts.md)을 참고하세요.

## Artifact 도구 설정

도구 이름은 `{toolName}_{artifactName}`입니다. `artifactName`은 `artifacts`의 정의 키이며, 타입에 선언한 동작별 설명의 `{artifactName}`에 치환됩니다.

```json
"artifactTypes": {
  "markdown": {
    "viewer": "text",
    "agentTools": {
      "read": {"description": "{artifactName}의 문서 내용을 줄 단위로 읽는다."}
    },
    "humanTools": {
      "read": {"description": "{artifactName}을 화면에서 읽는다."},
      "open": {
        "description": "{artifactName}을 기본 프로그램으로 연다.",
        "command": "/usr/bin/open",
        "args": ["{artifactPath}"]
      }
    }
  },
  "code": {
    "viewer": "files",
    "agentTools": {
      "list": {"description": "{artifactName}의 파일 목록을 조회한다."},
      "read": {"description": "{artifactName}의 소스 텍스트를 줄 단위로 읽는다."}
    },
    "humanTools": {"list": {}, "read": {}}
  }
}
```

`tests`에 연결된 Agent `read` 도구는 이름이 `read_tests`, 설명이 “tests의 소스 텍스트를 줄 단위로 읽는다.”가 됩니다. 타입 이름은 repo에서 자유롭게 정의합니다. 등록된 builtin 항목을 `{}`로 쓰면 기본 설명이 적용됩니다.

`agentTools`와 `humanTools`는 독립된 도구 목록입니다. 생략하거나 `{}`로 비우면 해당 리뷰어에게 도구가 제공되지 않으며, 그 Artifact를 해당 종류의 Critic에 포함한 새 요청은 거부됩니다. 선택한 Critic의 모든 Artifact에 적용되며 Runtime은 별도의 실행 계약을 사용합니다. 기존 `tools` 설정은 과거 기록 열람을 위해 지원하지만, 새 요청에는 대상별 목록을 명시해야 합니다.

위의 `open`은 macOS 예시입니다. 설치된 프로그램의 실행 파일과 고정 인자를 타입에 등록하며, `{artifactPath}`는 해당 리뷰의 Artifact 경로로 치환됩니다. 특정 앱을 지정하려면 `args`에 `"-a", "TextEdit", "{artifactPath}"`처럼 작성합니다. 도구는 기본 10초 안에 실행을 마쳐야 하며 `timeoutMs`로 최대 120초까지 지정할 수 있습니다. 프로그램을 열고 반환하는 실행기를 사용하세요. 프로그램 실행 성공과 사람의 검토 완료는 별개입니다.

```js
read_spec({startLine: 1, lineCount: 80})
list_tests({})
read_tests({path: "rank.test.mjs", startLine: 10, lineCount: 30})
```

기본 Viewer 동작 중 단일 파일에는 `read`, 디렉터리에는 `list`·`read`를 등록할 수 있습니다. 디렉터리 `read`에는 Artifact 내부의 파일 경로가 필요하며, 단일 파일 `read`에는 `path`를 넣지 않습니다. Human 프로그램 실행 도구는 이와 별도로 등록합니다. 입력에 `tool` 구분자를 넣는 구조도 아닙니다.

읽기는 1번 줄부터 시작하고 기본 80줄, 최대 500줄을 요청할 수 있습니다. 응답의 `nextStartLine`으로 이어 읽습니다. 한 번에 반환하는 내용은 64KiB 이내이며, 줄과 UTF-8 문자를 중간에서 자르지 않습니다. 한 줄 자체가 제한을 넘으면 오류를 반환합니다. 디렉터리 목록은 기존 `offset`·`limit` 방식으로 페이지를 넘깁니다.

```sh
ccdd artifact REQUEST_ID tests --file rank.test.mjs --start-line 10 --line-count 30
```

## 실행과 기록

```sh
ccdd run --copy --critic tests-spec --wait --json
ccdd status RUN_ID --wait --json
ccdd list
ccdd request REQUEST_ID
ccdd artifact REQUEST_ID spec
ccdd cancel RUN_ID
ccdd status RUN_ID --state-dir /outside/repo/state
```

원본 폴더가 삭제된 복사본 리뷰도 `--state-dir`만 지정하면 기록 조회와 Human 응답을 이어갈 수 있습니다.

각 Run은 독립된 실행 프로세스를 가집니다. 요청 CLI가 종료되거나 대기 시간이 초과돼도 실행 프로세스는 계속 작업합니다. `--wait`의 종료 코드는 `0=GREEN`, `1=RED`, `2=ERROR`, `3=대기 시간 초과`입니다. `--wait`를 생략한 종료 코드 0은 접수 성공입니다.

`--critic`은 선택한 Critic 하나만 독립적으로 평가합니다. 생략하면 전체 선형 체인을 실행합니다. 단독 GREEN은 선택한 기준의 통과이며 전체 체인 통과가 아닙니다. RED의 근거를 반영해 파일을 수정하고 새 요청을 보내면 됩니다. 새 commit은 필요하지 않습니다.

[Builder 사용법](docs/builder-workflow.md) · [요청 계약](docs/requester-contract.md)

## Human 리뷰

`--human-inbox`는 repo 밖의 `human-inbox.jsonl`을 명시적인 알림 수단으로 등록합니다. Human 실행에는 최소 하나의 알림 수단이 필요하며, 알림 전달 실패는 `ERROR`입니다.

```sh
ccdd run --copy --critic human-review --human-inbox
ccdd request REQUEST_ID
ccdd artifact REQUEST_ID spec
ccdd human-claim REQUEST_ID --reviewer reviewer-a
ccdd human-result REQUEST_ID --reviewer reviewer-a --result-file /outside/repo/result.json
```

결과 파일은 `{"verdict":"GREEN","summary":"검토 결과","evidence":["spec.md의 확인 근거"]}` 형식입니다. `--copy`는 알림이 전달되면 대기 상태를 저장하고 실행 프로세스를 종료할 수 있습니다. 이후 별도 명령으로 결과를 제출하면 필요한 후속 리뷰가 실행됩니다. `--lock`은 Human 대기 중에도 변경 감시 프로세스를 유지합니다.

모니터에서도 Human 카드를 열어 **리뷰 맡기 → 도구 실행 → 성공·실패 판정 제출**을 진행할 수 있습니다. Claim한 브라우저만 해당 도구와 제출 버튼을 사용할 수 있습니다. 판정에는 요약과 최소 하나의 근거가 필요합니다. 서버를 재시작해도 같은 브라우저에서 이어갈 수 있으며, 브라우저 쿠키를 삭제하면 해당 브라우저의 담당 식별자가 사라집니다.

## Artifact 도구 검사

```sh
ccdd tools check --repo /path/to/project
ccdd tools check --artifact spec --for human
ccdd tools check --artifact spec --for human --tool open --execute
ccdd tools check --artifact tests --for agent --tool read --execute --args '{"path":"rank.test.mjs","startLine":1,"lineCount":30}'
```

기본 검사는 도구 정의·Artifact 경로·실행 파일 준비 여부를 확인합니다. `--execute`는 지정한 도구를 실제로 호출하며, Human `open` 도구라면 프로그램이 열립니다. 실제 실행에는 Artifact·리뷰어 종류·도구를 모두 지정합니다. `--copy`가 기본이며, `--lock`도 지원합니다.

검사 결과에는 성공 여부와 실패 원인이 표시됩니다. 리뷰 기록이나 판정은 생성하지 않으며 Provider도 호출하지 않습니다. 데스크톱 프로그램을 연 복사본은 앱이 계속 읽을 수 있도록 보관합니다. 프로젝트 전체의 Provider·실행기 준비 상태는 기존 `ccdd doctor`로 검사합니다.

## CLI 데모

```sh
npm run demo:prepare
CCDD_CODEX_AUTH_FILE="$HOME/.codex/auth.json" npm run demo
node dist/src/cli.js run --demo --scenario why-change --copy --critic spec-why --wait
node dist/src/cli.js run --demo --scenario runtime-failure --copy --critic implementation-tests --wait
node dist/src/cli.js run --demo --scenario fixed --copy --wait
```

새 데모는 `~/.local/share/ccdd/demo-v7`에 Git 없는 네 개의 수정 가능한 작업 폴더를 만듭니다. 기존 작업 폴더를 다시 초기화하지 않습니다. 별도 위치를 쓰려면 `--demo-dir PATH`를 지정합니다.

```text
why.md → [Spec이 Why에 부합하는가] → spec.md
       → [Tests가 Spec에 부합하는가] → tests/
       → [실제 테스트 런타임] → implementation/
```

시연 주제는 중요한 미완료 작업을 우선 제안하는 함수입니다. 목적 변경, 구현 불일치, 수정 완료를 실제 Agent 판정과 Node 테스트로 확인합니다. [시연 순서](docs/demo.md)

## 로컬 모니터

```sh
ccdd monitor
# 소스에서 실행: node dist/src/cli.js monitor
```

표시되는 로컬 주소를 브라우저에서 열면 됩니다. 기본 주소는 `http://127.0.0.1:4318`입니다. `--port`로 변경할 수 있습니다.

프로젝트를 선택하면 **요청·진행 중·성공·실패** 네 영역에 리뷰 카드가 나타납니다. 각 영역에서 이전 요청을 추가로 불러올 수 있어 최근 완료 기록이 많아도 대기 중인 리뷰가 가려지지 않습니다. 카드를 열면 판정·근거·진행 기록과 요청에 제공된 Artifact를 확인할 수 있습니다.

```sh
ccdd monitor --repo /path/to/project
ccdd monitor --state-dir /outside/repo/state
```

별도 저장 위치는 `--state-dir`로 연결합니다. Human 카드는 담당 전에는 요청 영역에, claim 후에는 진행 중 영역에 표시합니다. 상세에서 등록된 Human 도구를 실행하고 GREEN·RED를 제출합니다. 후속 리뷰는 독립된 작업자로 재개되므로 모니터를 종료해도 계속 진행됩니다. 화면 조회만으로 저장된 상태나 판정을 변경하지 않습니다.

목록의 경과 시간은 접수 이후입니다. 기존 기록에는 입력 복사·검증 이전의 시간이 없으므로 해당 준비 시간은 포함하지 않습니다. Human의 담당 이후 시간은 실제 작업 시간이 아닌 담당 후 경과입니다.

## 검증

```sh
npm run typecheck
npm test
```

동시 복사본 공유, 복사 중 변경 거부, lock 변경·복원, 프로세스 간 소유권, Human 담당·도구·판정 제출, 도구 검사, 실제 테스트 실행, Provider 진단을 검증합니다. 모니터는 Node 내장 HTTP 서버와 Vue 3 화면을 사용하며, 빌드된 화면 파일이 npm 패키지에 포함됩니다. 이전 릴리스 문서와 영상은 당시 구현을 기록한 자료이며 현재 사용법은 이 문서를 따릅니다.
