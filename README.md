# CCDD

**Critic 중계 브로커와 Artifact Runner를 하나의 npm 패키지로 실행합니다.**

현재 작업 폴더에서 리뷰를 요청하면 CCDD가 Agent·테스트 런타임·Human 실행기에 연결하고 판정과 근거를 저장합니다. Git commit과 상주 daemon 없이 사용합니다. Artifact Runner는 요청에 선언된 Artifact만 읽는 Viewer 도구를 Agent에 제공합니다.

## 시작하기

Node.js 24 이상이 필요합니다. Agent 리뷰에는 요청한 모델을 사용할 수 있는 Codex 로그인이 필요합니다. 기존 로그인은 그대로 사용하며, 패키지는 Codex CLI 0.153.4를 포함합니다.

```sh
npm ci
node src/cli.mjs doctor --repo /path/to/project --json
node src/cli.mjs run --repo /path/to/project --copy --critic tests-spec --wait --json
```

npm 패키지를 설치했다면 `node src/cli.mjs` 대신 `ccdd`를 사용합니다. 실제 Agent 진단과 리뷰는 계정 사용량을 소비합니다.

## 리뷰 입력 선택

`run`은 `--copy` 또는 `--lock` 중 하나를 명시해야 합니다. 두 옵션을 동시에 사용할 수 없습니다.

| 옵션 | 입력 | 수정 정책 |
| --- | --- | --- |
| `--copy` · 권장 | 현재 repo 전체의 복사본 | 복사가 끝나면 원본을 수정할 수 있습니다. |
| `--lock` | 현재 workspace 전체 | 리뷰 중 변경이 검출되면 `ERROR`로 실패합니다. |

커밋 여부와 ignore 규칙에 관계없이 모든 파일이 대상입니다. `.git`, 의존성 디렉터리, 새 파일도 포함합니다. 상대경로·내용·파일 유형·실행 권한으로 계산한 SHA-256이 같은 복사본은 동시에 여러 리뷰에서 재사용합니다. 판정은 매번 실행하며, 입력 공유가 판정 재사용을 의미하지 않습니다.

공유 복사본은 읽기 전용입니다. 테스트 출력은 `CCDD_OUTPUT_DIR`, 임시 파일은 `CCDD_TMP_DIR` 또는 `TMPDIR`에 작성합니다. CCDD의 상태·로그·복사본·리뷰 출력은 repo 밖에 저장합니다. 기본 경로는 `~/.local/state/ccdd/<repo 식별자>`이며, `--state-dir` 또는 `CCDD_STATE_HOME`으로 변경합니다.

`--lock`은 쓰기를 강제로 막는 기능이 아닙니다. 파일 이벤트와 메타데이터, 내용 검증으로 변경을 감시합니다. 감시할 수 없는 환경에서는 실행을 거부합니다. 원본을 수정한 후 내용을 되돌려도 변경으로 검출되면 실패합니다. 자세한 범위와 제한은 [workspace 계약](docs/contracts.md)을 참고하세요.

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

## CLI 데모

```sh
npm run demo:prepare
npm run demo
node src/cli.mjs run --demo --scenario why-change --copy --critic spec-why --wait
node src/cli.mjs run --demo --scenario runtime-failure --copy --critic implementation-tests --wait
node src/cli.mjs run --demo --scenario fixed --copy --wait
```

데모는 Git 없는 네 개의 수정 가능한 작업 폴더를 만듭니다. 기존 작업 폴더를 다시 초기화하지 않습니다. 별도 위치를 쓰려면 `--demo-dir PATH`를 지정합니다.

```text
why.md → [Spec이 Why에 부합하는가] → spec.md
       → [Tests가 Spec에 부합하는가] → tests/
       → [실제 테스트 런타임] → implementation/
```

시연 주제는 중요한 미완료 작업을 우선 제안하는 함수입니다. 목적 변경, 구현 불일치, 수정 완료를 실제 Agent 판정과 Node 테스트로 확인합니다. [시연 순서](docs/demo.md)

관찰 서버는 상태·이력·디버그 UI와 Human 알림 어댑터로 **추가 가능**합니다. 현재 패키지와 데모에는 포함하지 않습니다.

## 검증

```sh
npm test
```

동시 복사본 공유, 복사 중 변경 거부, lock 변경·복원, 프로세스 간 소유권, 대기 시간 초과, Human 응답, 실제 테스트 실행, Provider 진단을 검증합니다. 브라우저와 서버 의존성은 없습니다. 이전 v0.1/v0.2 문서와 영상은 당시 구현을 기록한 자료이며 현재 사용법은 이 문서를 따릅니다.
