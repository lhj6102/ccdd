# CCDD

**CCDD는 Artifact·Critic·관계와 도구를 정의합니다. 프로젝트 검증과 실행 이력은 별도 Project 패키지가 담당합니다.**

| 패키지 | 책임 |
| --- | --- |
| `@ccdd/core` | `defineConfig`, `defineTool`, Artifact·Critic·stale 전략 타입. 실행 의존성과 DB가 없습니다. |
| `@ccdd/project` | 현재 검증 조회, 필요한 검증 의뢰, 실제 판정 이력, Broker·실행기·모니터. |
| `@ccdd/default-tools` | 프로젝트가 선택하여 명시적으로 등록하는 관측 도구. |

## 시작하기

Node.js 24 이상이 필요합니다. 공개 npm 배포를 지원하며, 첫 게시가 완료된 버전부터 리뷰 대상 프로젝트에 다음과 같이 설치할 수 있습니다. npm 게시 절차와 버전 확인은 [배포 안내](docs/releases.md#npm-공개-배포)를 참고하세요.

```sh
npm init -y
npm pkg set type=module
npm install --ignore-scripts @ccdd/core @ccdd/project @ccdd/default-tools
npx ccdd-project help
```

GitHub에 같은 버전의 Release가 게시된 경우 tarball로도 설치할 수 있습니다. 다음은 v2.0.1 게시 후의 설치 명령입니다. 다운로드에는 저장소 접근 권한이 있는 GitHub CLI 로그인이 필요합니다.

```sh
npm init -y
npm pkg set type=module
mkdir -p vendor/ccdd
gh release download v2.0.1 --repo lhj6102/ccdd --dir vendor/ccdd \
  --pattern '*.tgz' --pattern SHA256SUMS --pattern verification.json
(cd vendor/ccdd && shasum -a 256 -c SHA256SUMS)
npm install --ignore-scripts \
  ./vendor/ccdd/ccdd-core-2.0.1.tgz \
  ./vendor/ccdd/ccdd-project-2.0.1.tgz \
  ./vendor/ccdd/ccdd-default-tools-2.0.1.tgz
npx ccdd-project help
```

Linux에서는 `sha256sum -c SHA256SUMS`도 사용할 수 있습니다. v2.0.0까지의 `@lhj6102/ccdd*` 패키지에서는 import 이름도 변경해야 합니다. [v2.0.1 이전 안내](docs/releases/v2.0.1.md)를 참고하세요. 소스 저장소에서 개발할 때는 다음 명령을 사용합니다.

```sh
nvm use # nvm 사용 시 .nvmrc의 Node 24 선택
npm ci
npm run build
node dist/src/project/cli.js help
node dist/src/project/cli.js config check --repo /path/to/project
node dist/src/project/cli.js plan spec --recursive --repo /path/to/project
node dist/src/project/cli.js verify spec --recursive --wait --repo /path/to/project
node dist/src/project/cli.js status spec --repo /path/to/project
```

리뷰할 프로젝트에는 아래 예제처럼 `ccdd.config.ts`와 그 설정이 가리키는 파일을 둡니다. 설정이 import하는 core와 선택한 도구 라이브러리는 그 프로젝트에도 설치해야 합니다. 세 패키지를 설치하면 `npx ccdd-project`를 사용할 수 있습니다. 기본 도구 없이 custom 도구를 사용한다면 core와 Project를 설치합니다. 정의만 사용하는 프로젝트는 core만 설치할 수 있습니다.

`status`·`plan`은 현재 입력에 적용 가능한 실제 판정을 조회합니다. `verify`는 필요한 검증을 의뢰하며 기본 입력 정책은 copy입니다. `--recursive`가 없으면 선택한 Critic 중 실행 가능한 것부터 진행하고, 선행 검증이 필요한 항목은 미완료로 보고합니다. 검증 조회는 Provider나 리뷰 도구를 실행하지 않습니다. TS 설정의 평가는 명시적인 현재 입력 조회 시 일어납니다.

```ts
artifacts: {
  why: { type: 'markdown', path: 'why.md', basis: true },
  spec: { type: 'markdown', path: 'spec.md',
    stale: { kind: 'file-hash', paths: ['spec.md', 'references'] } },
}
```

기본 동일성 기준은 Artifact 경로의 파일 내용 hash입니다. `paths`로 별도 입력 경로들을 선언하거나 `{ kind: 'always' }`로 요청마다 검증하게 할 수 있습니다. 설정한 경로들은 Artifact의 의미에 영향을 주는 입력을 빠짐없이 포함해야 합니다.

Why → Spec → Tests → Implementation에서 Why가 바뀌면 Spec의 검증 입력이 바뀝니다. Spec이 내용 수정 없이 다시 PASS하면 Tests의 target·직접 deps hash는 그대로이므로 이전 실제 PASS를 재사용합니다. 하위 노드에 stale 상태를 전파하거나 저장하지 않고 조회마다 DAG를 재귀적으로 평가합니다.

상태 저장 위치는 repo 밖의 `~/.local/state/ccdd/<repo 경로 식별자>/broker.sqlite`입니다. 실제 판정과 검증 당시 입력 hash, 실행·티켓 이력을 저장합니다. `--state-dir` 또는 `CCDD_STATE_HOME`으로 변경할 수 있습니다. [프로젝트 검증 명령과 저장 계약](docs/project-validation.md)에 전체 UX와 종료 코드를 설명합니다.

`ccdd-project monitor`의 **현재 입력**에서 명시적으로 입력을 확인하고, Kanban·Graph에서 실행과 실제 판정을 볼 수 있습니다. 자동 GET 갱신은 설정을 평가하거나 리뷰 상태를 변경하지 않습니다. Graph의 재사용 항목은 원래 리뷰 요청으로 연결됩니다.

기존 `ccdd` 명령도 Project 패키지에 호환용으로 포함합니다. 아래의 `ccdd run`, `status RUN_ID`, Human·진단 명령은 기존 실행 계약을 유지합니다. 새 pull 검증은 `ccdd-project verify`를 사용합니다. 소스 개발에서 기존 CLI는 `node dist/src/cli.js`입니다.

## Artifact 의존 관계

Critic 설정은 `target`(평가 대상 하나)과 `deps`(참조 Artifact 배열)를 사용합니다. 같은 Artifact의 필수 Critic이 모두 통과하면 다음 검토가 시작됩니다. `basis: true`로 명시한 기준 Artifact를 제외하고 검토 없는 입력을 자동 통과시키지 않습니다. 기존 `dependsOn`·Critic의 `artifacts` 설정은 [설정 변경 안내](docs/artifact-graph.md)를 따라 변경하세요.

모니터에서 **Kanban / Graph**를 선택할 수 있습니다. Graph는 선택한 검증 실행의 Artifact 관계와 Critic별 판정을 보여주며, 노드에서 기존 Human 요청 상세로 이어집니다. 과거에 역할 정보 없이 저장한 실행은 Kanban에서 계속 확인할 수 있습니다.

개별 Artifact를 ID로 참조하여 그룹으로 묶을 수도 있습니다.

```ts
artifacts: {
  effect: { type: 'markdown', path: 'effect.md' },
  preview: { type: 'image', path: 'preview.png' },
  explosion: { kind: 'group', members: ['effect', 'preview'] },
}
```

그룹에는 타입·경로가 없으며 다른 그룹도 구성원으로 참조할 수 있습니다. `target`·`deps`·`basis`는 그룹에도 적용됩니다. 그룹 판정은 그 그룹을 평가하는 Critic만 집계하며 멤버 판정과 서로 전파하지 않습니다. 구성 관계는 실행 의존성이 아니므로, 이미지 평가 후 그룹을 검토하려면 그룹 Critic에 `deps: ['preview']`를 명시합니다. 관측 도구는 중복을 제거한 모든 leaf에 제공하고 기존 ID를 유지합니다. Agent는 각 leaf를 관측해야 합니다. 자세한 규칙은 [Artifact 그룹](docs/artifact-graph.md#artifact-그룹)을 참고하세요.

## Agent Provider와 인증

Agent profile은 Pi의 정확한 Provider·모델 ID와 reasoning을 명시합니다. 예:

```json
{"kind":"agent","provider":"openai-codex","model":"gpt-6-astra","reasoning":"medium"}
```

`@earendil-works/pi-agent-core`와 `@earendil-works/pi-ai` 0.85.1을 라이브러리로 사용합니다. Provider 호출과 Agent 도구 루프는 Agent 실행기 내부의 Pi가 맡으며, CCDD가 판정 스키마·필수 Artifact 관측·workspace 무결성을 검증합니다. 기본 이미지 도구도 내부 CLI에서 Pi의 read를 재사용하지만 세션이나 Provider 호출은 만들지 않습니다. Broker·Human·Runtime은 Pi 세션을 사용하지 않습니다.

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

설정은 `ccdd.config.ts`입니다. 프로젝트 `package.json`의 `type`은 `module`로 지정합니다(`npm pkg set type=module`). 설정 객체 또는 객체를 반환하는 동기·비동기 함수를 default export합니다. `@ccdd/core`는 가벼운 `defineConfig`, `defineTool`과 도구 타입을 제공하고, `@ccdd/default-tools`는 선택적으로 설치하는 구현 라이브러리입니다. import하거나 factory를 호출하는 것만으로 파일을 읽거나 프로그램을 실행하지 않습니다.

```ts
import { defineConfig } from '@ccdd/core';
import { agent, human } from '@ccdd/default-tools';

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

이미지 타입에는 `agentTools: { view_image: agent.image.view() }`를 등록합니다. `preview`에 연결하면 `view_image_preview`가 제공됩니다. 파일 Artifact에는 `{}`, 디렉터리에는 `{"path":"frames/preview.png"}`를 전달합니다. Pi read의 실제 이미지 결과만 사용하며 지원 범위는 PNG/JPEG/WebP, 최대 4MiB입니다. 텍스트·GIF·BMP·APNG는 실패하고 자동 축소·변환은 하지 않습니다. 이미지 읽기 자체는 모델을 호출하지 않으며, 그 결과를 리뷰하는 Agent 모델은 이미지 입력을 지원해야 합니다.

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

그룹 참조 `{explosion}`은 `{"artifactGroup":"explosion","members":[{"artifact":"effect","tools":["read_effect"]},{"artifact":"preview","tools":["view_image_preview"]}]}`처럼 구성원의 실제 도구 목록으로 펼칩니다. Human 화면에서는 해당 멤버의 도구를 고르는 버튼으로 표시합니다.

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

`ccdd tools check --artifact explosion --for agent`처럼 그룹을 선택하면 모든 leaf 도구를 중복 없이 검사합니다. `--execute`는 `--artifact preview --for agent --tool view_image --execute`처럼 leaf를 명시해야 합니다.

검사 결과에는 성공 여부와 실패 원인이 표시됩니다. 리뷰 기록이나 판정은 생성하지 않으며 Provider도 호출하지 않습니다. 데스크톱 프로그램을 연 복사본은 앱이 계속 읽을 수 있도록 보관합니다. 프로젝트 전체의 Provider·실행기 준비 상태는 `ccdd doctor`로 검사합니다. Provider 진단은 내부 nonce 도구로 연결을 확인하며 프로젝트 custom 도구를 대신 실행하지 않습니다.

## CLI 데모

설치한 CLI와 Release의 두 tarball로 네 가지 시나리오를 만들 수 있습니다. tarball 환경변수는 절대경로로 지정하고, 업그레이드할 때는 새 데모 폴더를 선택하세요.

```sh
export CCDD_DEMO_CORE_TARBALL="$PWD/vendor/ccdd/ccdd-core-2.0.1.tgz"
export CCDD_DEMO_TOOLS_TARBALL="$PWD/vendor/ccdd/ccdd-default-tools-2.0.1.tgz"
export CCDD_DEMO_DIR="$HOME/.local/share/ccdd/demo-2.0.1"
npx ccdd prepare-demo --demo-dir "$CCDD_DEMO_DIR"
npx ccdd run --demo --demo-dir "$CCDD_DEMO_DIR" --scenario why-change --copy --critic spec-why --wait
npx ccdd run --demo --demo-dir "$CCDD_DEMO_DIR" --scenario runtime-failure --copy --critic implementation-tests --wait
npx ccdd run --demo --demo-dir "$CCDD_DEMO_DIR" --scenario fixed --copy --wait
```

새 데모는 Git 없는 네 개의 수정 가능한 프로젝트를 만듭니다. tarball에서 의존성을 한 번 설치한 뒤 각 프로젝트에 물리적으로 복사하므로, 각 snapshot이 자신의 구현·의존성을 가집니다. 공개된 전이 의존성 설치에는 npm 접근 또는 로컬 캐시가 필요합니다. lifecycle script는 실행하지 않습니다. 각 프로젝트에 tarball·package lock도 보관합니다.

`--demo-dir`를 생략한 기본 경로는 기존과 같은 `~/.local/share/ccdd/demo-v9`입니다. 이 이름은 데모 형식 버전이며 패키지 버전과 별개입니다. 기존 데모는 편집한 파일과 설치된 패키지를 보존하며 재설치하지 않습니다. Release 업그레이드는 위처럼 새 폴더에서 준비합니다. 소스로 tarball을 만드는 절차와 전체 시연은 [데모 안내](docs/demo.md)를 참고하세요.

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

Graph의 그룹 노드는 자신의 판정과 구성원 수를 표시하며, 선택하면 멤버별 판정을 확인하고 해당 노드로 이동할 수 있습니다. 구성 관계는 Critic 의존 간선과 구분합니다. 모니터는 저장된 그룹 정보를 검증해 표시하고 설정 코드를 실행하지 않습니다.

목록의 경과 시간은 접수 이후입니다. 기존 기록에는 입력 복사·검증 이전의 시간이 없으므로 해당 준비 시간은 포함하지 않습니다. Human의 담당 이후 시간은 실제 작업 시간이 아닌 담당 후 경과입니다.

## 검증

```sh
npm run typecheck
npm test
```

동시 복사본 공유, 복사 중 변경 거부, lock 변경·복원, 프로세스 간 소유권, Human 담당·도구·판정 제출, 도구 검사, 실제 테스트 실행, Provider 진단을 검증합니다. 모니터는 Node 내장 HTTP 서버와 Vue 3 화면을 사용하며, 빌드된 화면 파일이 npm 패키지에 포함됩니다. 이전 릴리스 문서와 영상은 당시 구현을 기록한 자료이며 현재 사용법은 이 문서를 따릅니다.
