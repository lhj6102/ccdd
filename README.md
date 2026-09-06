# CCDD

**Critic 중계 브로커와 Artifact Runner입니다. 기본 관측 도구는 별도 라이브러리에서 선택하여 등록합니다.**

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

## Artifact 의존 관계

Critic 설정은 `target`(평가 대상 하나)과 `deps`(참조 Artifact 배열)를 사용합니다. 같은 Artifact의 필수 Critic이 모두 통과하면 다음 검토가 시작됩니다. `basis: true`로 명시한 기준 Artifact를 제외하고 검토 없는 입력을 자동 통과시키지 않습니다. 기존 `dependsOn`·Critic의 `artifacts` 설정은 [설정 변경 안내](docs/artifact-graph.md)를 따라 변경하세요.

모니터에서 **Kanban / Graph**를 선택할 수 있습니다. Graph는 선택한 검증 실행의 Artifact 관계와 Critic별 판정을 보여주며, 노드에서 기존 Human 요청 상세로 이어집니다. 과거에 역할 정보 없이 저장한 실행은 Kanban에서 계속 확인할 수 있습니다.

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

v0.9의 설정은 `ccdd.config.ts`입니다. 설정 객체 또는 객체를 반환하는 동기·비동기 함수를 default export합니다. `@lhj6102/ccdd`는 가벼운 `defineConfig`, `defineTool`과 도구 타입을 제공하고, `@lhj6102/ccdd-default-tools`는 선택적으로 설치하는 구현 라이브러리입니다. import하거나 factory를 호출하는 것만으로 파일을 읽거나 프로그램을 실행하지 않습니다.

```ts
import { defineConfig } from '@lhj6102/ccdd';
import { agent, human } from '@lhj6102/ccdd-default-tools';

export default defineConfig(() => ({
  artifactTypes: {
    markdown: {
      agentTools: { read: agent.text.read() },
      humanTools: { open: human.desktop.open() },
    },
    code: {
      agentTools: { list: agent.files.list(), read: agent.files.read() },
      humanTools: { open: human.desktop.open() },
    },
  },
  artifacts: {
    why: { type: 'markdown', path: 'why.md', basis: true },
    spec: { type: 'markdown', path: 'spec.md' },
  },
  critics: [{
    id: 'spec-why', title: 'Spec이 Why에 부합하는가', target: 'spec', deps: ['why'],
    profile: { kind: 'agent', provider: 'openai-codex', model: 'gpt-6-astra', reasoning: 'medium' },
    payload: { instruction: '{spec}이 {why}의 요구사항을 충족하는지 검토하세요.' },
  }],
}));
```

기본 도구도 `agent.text.read()`처럼 명시적으로 등록합니다. 자동 등록, 빈 객체의 기본값, 필수 `viewer: text|files`는 TS 설정에 없습니다. `agentTools`와 `humanTools`를 비우거나 생략하면 해당 종류의 Critic은 그 Artifact를 사용할 수 없습니다. 평가 대상과 참조 모두 적용하며 Runtime은 별도 실행 계약입니다.

기본 Agent 도구는 패키지에 포함된 Node CLI를 호출합니다. `text.read()`는 단일 파일, `files.list()`·`files.read()`는 디렉터리용입니다. 이름은 `read_spec`, `list_tests`처럼 `<toolName>_<artifactName>`이며 설명의 `{artifactName}`도 실제 Artifact ID로 치환합니다. 읽기는 1번 줄부터 기본 80줄, 최대 500줄을 요청하고 `nextStartLine`으로 이어 읽습니다. 원래 UTF-8·LF/CRLF와 완전한 줄을 보존하며 응답은 64KiB로 제한합니다.

기본 Human 도구는 텍스트를 반환하지 않고 snapshot의 파일·폴더를 데스크톱 프로그램으로 엽니다. `human.desktop.open({ app: 'TextEdit' })`처럼 앱을 지정할 수 있습니다. 기본 OS 연결은 macOS이며 다른 OS에서는 `command`와 고정 `args`를 명시합니다. 프로그램 열기 성공은 사람의 검토나 판정 완료가 아닙니다.

사용자 도구는 `{ metadata, execute(context, args), preflight? }`를 직접 작성합니다. `metadata`에 설명·입력 JSON Schema·결과 종류·관측 방식을 선언하고, CCDD가 실제 snapshot Artifact와 출력·임시 경로·취소 신호를 연결합니다. 함수·SDK·CLI를 선택할 수 있으며 텍스트·JSON·이미지·프로그램 열기 결과를 지원합니다. 기본 도구 라이브러리 없이 작성하는 [사용자 Reader 예제](examples/custom-text-reader/README.md)와 정확한 [도구 계약](docs/contracts.md)을 참고하세요.

설정과 import한 구현은 repo 안에서 해석합니다. 필요한 패키지를 **리뷰 대상 프로젝트의 `node_modules`에 실제 설치**해야 하며 상위 repo·전역 설치로 fallback하지 않습니다. 함수는 기록에 저장하지 않고 도구 명세와 구현 식별 정보를 저장합니다. 실행·Human 재개 시 동일 snapshot의 구현과 대조합니다. TS 설정은 신뢰하는 repo 코드이며 OS sandbox는 아닙니다.

기존 `ccdd.config.json`의 `viewer`·`read/list`·Human 명령 설정은 이전을 위한 호환 경로로 계속 지원합니다. 과거 기록을 새 도구로 바꾸지 않으며, JSON과 TS 설정이 함께 있으면 충돌 오류입니다. 신규 예제는 TS와 명시적 등록을 사용합니다.

### 지시사항의 Artifact 참조

`payload.instruction`에서 `{spec}`처럼 요청 범위의 Artifact ID를 참조할 수 있습니다. 위 예제는 Agent 프롬프트에서 다음과 같이 펼쳐집니다.

```text
{"artifact":"spec","tools":["read_spec"]}이 {"artifact":"why","tools":["read_why"]}의 요구사항을 충족하는지 검토하세요.
```

`tools`에는 해당 Artifact에 실제로 제공된 Agent 도구 이름이 들어갑니다. custom 도구를 등록했다면 그 이름을 사용합니다. Human 요청에서는 참조를 버튼으로 표시하고 연결된 Human 도구의 선택 영역으로 이동합니다. 참조 버튼만 눌러서는 도구가 실행되지 않으며, claim 후 실행할 도구를 명시적으로 선택합니다.

설정·저장된 요청·HTTP 응답의 `instruction` 문자열은 원문을 유지합니다. 다른 payload 필드도 바꾸지 않습니다. JSON 객체처럼 중괄호로 묶인 구간, 중첩·이중 중괄호, `\{spec}`처럼 escape한 참조, 알 수 없거나 요청 범위 밖인 ID, `{spec.path}` 같은 표현식은 그대로 둡니다. instruction을 일반 JSON 문서로 해석하지 않으므로 그 구간 밖의 따옴표나 배열 안에서도 `{spec}`은 참조입니다. 문자 그대로 쓰려면 escape합니다. 참조는 파일 본문을 삽입하거나 접근 범위를 늘리지 않습니다. 도구 설명의 `{artifactName}`은 그 도구에 연결된 ID를 치환하는 별도 규칙이며, instruction에 같은 이름의 예약변수를 추가하지 않습니다.

## 실행과 기록

```sh
ccdd run --copy --critic tests-spec --wait --json
ccdd status RUN_ID --wait --json
ccdd list
ccdd request REQUEST_ID
ccdd cancel RUN_ID
ccdd status RUN_ID --state-dir /outside/repo/state
```

TS 요청의 Human Artifact 도구는 모니터에서 claim한 뒤 호출합니다. `tools check --execute`는 현재 프로젝트에서 새 진단 입력을 만들어 검사하며 기존 요청의 snapshot을 여는 명령이 아닙니다. `ccdd artifact REQUEST_ID spec`은 legacy JSON 요청의 수동 텍스트 조회에만 사용합니다.

원본 폴더가 삭제된 복사본 리뷰도 `--state-dir`만 지정하면 기록 조회와 Human 응답을 이어갈 수 있습니다.

각 Run은 독립된 실행 프로세스를 가집니다. 요청 CLI가 종료되거나 대기 시간이 초과돼도 실행 프로세스는 계속 작업합니다. `--wait`의 종료 코드는 `0=GREEN`, `1=RED`, `2=ERROR`, `3=대기 시간 초과`입니다. `--wait`를 생략한 종료 코드 0은 접수 성공입니다.

`--critic`은 선택한 Critic 하나만 독립적으로 평가합니다. 생략하면 Artifact 의존 그래프 전체를 실행합니다. 단독 GREEN은 선택한 기준의 통과이며 다른 필수 Critic의 통과를 뜻하지 않습니다. RED의 근거를 반영해 파일을 수정하고 새 요청을 보내면 됩니다. 새 commit은 필요하지 않습니다.

[Builder 사용법](docs/builder-workflow.md) · [요청 계약](docs/requester-contract.md)

## Human 리뷰

`--human-inbox`는 repo 밖의 `human-inbox.jsonl`을 명시적인 알림 수단으로 등록합니다. Human 실행에는 최소 하나의 알림 수단이 필요하며, 알림 전달 실패는 `ERROR`입니다.

```sh
ccdd run --copy --critic human-review --human-inbox
ccdd request REQUEST_ID
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

기본 검사는 도구 정의·Artifact 경로와 등록된 `preflight`를 확인합니다. custom preflight가 없으면 등록 확인과 실제 실행 미검증을 구분하여 표시합니다. `--execute`는 지정한 도구를 실제로 호출하며, Human `open` 도구라면 프로그램이 열립니다. 실제 실행에는 Artifact·리뷰어 종류·도구를 모두 지정합니다. `--copy`가 기본이며, `--lock`도 지원합니다.

검사 결과에는 성공 여부와 실패 원인이 표시됩니다. 리뷰 기록이나 판정은 생성하지 않으며 Provider도 호출하지 않습니다. 데스크톱 프로그램을 연 복사본은 앱이 계속 읽을 수 있도록 보관합니다. 프로젝트 전체의 Provider·실행기 준비 상태는 `ccdd doctor`로 검사합니다. Provider 진단은 내부 nonce 도구로 연결을 확인하며 프로젝트 custom 도구를 대신 실행하지 않습니다.

## CLI 데모

두 패키지는 private 저장소에서 로컬 tarball로 준비합니다. npm 공개 게시를 전제로 하지 않습니다.

```sh
npm run build
mkdir -p /tmp/ccdd-local-packages
npm pack --ignore-scripts --pack-destination /tmp/ccdd-local-packages
npm pack --workspace @lhj6102/ccdd-default-tools --ignore-scripts --pack-destination /tmp/ccdd-local-packages
export CCDD_DEMO_CORE_TARBALL=/tmp/ccdd-local-packages/lhj6102-ccdd-0.9.0.tgz
export CCDD_DEMO_TOOLS_TARBALL=/tmp/ccdd-local-packages/lhj6102-ccdd-default-tools-0.9.0.tgz
node dist/src/cli.js prepare-demo
CCDD_CODEX_AUTH_FILE="$HOME/.codex/auth.json" npm run demo
node dist/src/cli.js run --demo --scenario why-change --copy --critic spec-why --wait
node dist/src/cli.js run --demo --scenario runtime-failure --copy --critic implementation-tests --wait
node dist/src/cli.js run --demo --scenario fixed --copy --wait
```

새 데모는 `~/.local/share/ccdd/demo-v9`에 Git 없는 네 개의 수정 가능한 프로젝트를 만듭니다. tarball에서 의존성을 한 번 설치한 뒤 각 프로젝트에 물리적으로 복사하므로, 각 snapshot이 자신의 구현·의존성을 가집니다. 공개된 전이 의존성 설치에는 npm 접근 또는 로컬 캐시가 필요합니다. lifecycle script는 실행하지 않습니다. 각 프로젝트에 tarball·package lock도 보관합니다.

기존 v9 프로젝트는 편집한 파일을 보존하며 다시 설치하지 않습니다. 과거 데모나 파일이 있는 다른 폴더를 덮어쓰지 않습니다. 별도 위치는 `--demo-dir PATH`로 지정합니다. 설치한 CCDD CLI에서도 동일한 두 tarball 환경변수로 `ccdd prepare-demo`를 사용할 수 있습니다.

```text
why.md → spec.md → tests/ → implementation/
          Agent     Agent      Runtime
```

시연 주제는 중요한 미완료 작업을 우선 제안하는 함수입니다. 목적 변경, 구현 불일치, 수정 완료를 실제 Agent 판정과 Node 테스트로 확인합니다. 기본 도구는 TS config에 명시적으로 등록되며 Human 도구는 데스크톱 열기로 구성됩니다. 기본 시나리오의 Critic은 Agent 2개·Runtime 1개입니다.

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
