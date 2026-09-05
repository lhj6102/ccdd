# CCDD

**Critic 중계 브로커와 Artifact Runner를 하나의 npm 패키지로 실행하는 로컬 데모.**

Requester가 커밋 스냅샷과 리뷰 payload를 제출하면 브로커는 요청을 영속적으로 보관한다. 리뷰를 시작할 때 해당 스냅샷을 worktree로 재현하고, Artifact Runner가 요청에 포함된 Artifact의 Viewer 진입점을 Agent tools로 구성한다. Agent·테스트 런타임·Human 실행기는 실제 리뷰를 맡고, 결과는 원래 요청자의 Handle에 연결된다.

## 실행 준비 진단과 개별 Critic

`ccdd doctor`는 프로젝트가 요구하는 Provider·모델·reasoning으로 실제 응답과 Artifact MCP 읽기를 확인한다. `/api/health`는 브로커 생존 상태만 나타낸다.

```sh
# 소스 체크아웃에서 실행
node src/cli.mjs doctor --repo /path/to/project --commit HEAD --json
node src/cli.mjs run --commit FULL_COMMIT_HASH --critic tests-spec --wait --json
```

`--critic`은 선택한 Critic 하나만 독립적으로 실행한다. 단독 GREEN은 그 기준의 통과이며 전체 그래프 통과가 아니다. Builder는 `--wait`의 종료 코드 0(GREEN), 1(RED), 2(ERROR), 3(대기 시간 초과)와 JSON 근거를 사용해 수정·새 커밋·재요청을 반복할 수 있다. `doctor`의 READY는 진단 시점의 실행 준비 상태이며 리뷰 판정과 구분한다.

[Builder 사용 흐름과 명령 계약](docs/builder-workflow.md) · [v0.2.0 설치 패키지](https://github.com/lhj6102/ccdd/releases/tag/v0.2.0)

## 빠른 실행

필요한 도구: Node.js 24 이상, Git, 로그인된 Codex 계정. 프로젝트에 설치되는 Codex CLI는 0.153.4로 고정했다.

```sh
npm ci
npx codex login
npm run demo
```

브라우저에서 `http://127.0.0.1:4317`을 연다. 기존 Codex 로그인이 있으면 다시 로그인할 필요가 없다. 데모는 실제 Agent를 호출하므로 계정 사용량을 소비하며 모델 응답을 기다리는 시간이 있다.

```sh
npm test
node src/cli.mjs list
node src/cli.mjs run --commit COMMIT
node src/cli.mjs status RUN_ID
```

다른 프로젝트를 등록하려면 `node src/cli.mjs serve --repo /path/to/repo`를 사용한다. 그 프로젝트의 커밋에 `ccdd.config.json`과 Artifact가 있어야 한다. `--state-dir`, `--port`, `--codex` 옵션으로 로컬 실행 경로를 지정할 수 있다.

## 데모의 한 가지 그래프

```text
why.md
  └─ Agent: Spec이 Why에 부합하는가
       spec.md
         └─ Agent: Tests가 Spec에 부합하는가
              tests/
                └─ Runtime: 실제 테스트를 통과하는가
                     implementation/
```

전체 실행에서 각 Critic은 바로 앞선 평가 하나에만 의존한다. 첫 Critic의 기준인 Why는 이 예시의 출발점이다. 평가는 판정 대상과 바로 앞선 기준 Artifact를 읽으며, 다른 단계의 Artifact를 Agent에 넘기지 않는다.

시연 소재는 **중요하고 짧은 미완료 작업을 우선 제안하는 함수**다. `npm run demo`는 별도의 로컬 Git 저장소를 만들고 네 스냅샷을 커밋한다.

| 스냅샷 | 변경 | 확인할 내용 |
| --- | --- | --- |
| 기준 | Why·Spec·Tests·구현이 최대 3개에 일치 | 두 Agent 평가와 실제 테스트 실행 |
| Why 변경 | Why만 최대 2개로 변경 | Spec의 수치 불일치와 후속 평가 차단 |
| 구현 불일치 | Spec·Tests는 2개, 구현은 3개 | 문서·테스트 리뷰 후 실제 런타임 실패 |
| 수정 완료 | 구현도 최대 2개로 수정 | 새 커밋의 모든 평가 재실행 |

표는 시나리오의 의도다. 화면에 표시되는 판정은 고정 응답이 아니라 실제 Agent 응답과 테스트 종료 코드에서 생성한다. 이전 스냅샷의 통과를 새 스냅샷에 복사하지 않는다.

## 기능 경계

| 구성 요소 | 책임 |
| --- | --- |
| Repo Requester | 커밋의 Artifact 정의·payload·Profile을 명시적 요청으로 구성 |
| Broker | 요청·Handle·의존 상태·결과의 영속성, 리뷰 배정, Human claim |
| Executors | Code Runner, Agent Provider, Human의 서로 다른 실행 방식 |
| Artifact Runner | payload의 Artifact 참조를 스냅샷에 묶인 Viewer tools로 연결 |

Broker와 Executors는 별도 bounded context이며 배포는 하나의 npm 단위다. [용어 맵](CONTEXT-MAP.md)과 [구현 계약](docs/contracts.md)을 함께 관리한다.

### Artifact와 스냅샷

Artifact의 타입·Repo 상대경로 및 타입별 Viewer 정의는 `ccdd.config.json`에서 관리한다. 요청에는 Repo 식별자, 타입·상대경로, snapshot commit, 리뷰 payload와 실행 Profile이 들어간다. Config도 같은 커밋에서 읽는다.

리뷰마다 분리된 detached worktree를 만든다. Agent에는 payload가 참조하는 Artifact를 읽는 MCP tools만 구성한다. Viewer는 경로 이탈과 심볼릭 링크를 통한 범위 이탈을 거부한다. UI의 파일 보기도 같은 Artifact Runner를 사용한다.

### 실행과 판정

`GREEN`은 현재 스냅샷에서 통과했다는 판정, `RED`는 실제 평가에서 불일치를 찾았다는 판정이다. `ERROR`는 Provider 오류 등 실행 실패이며 RED와 구분한다. 전체 실행에서 선행 Critic이 GREEN이 아니면 후속 단계는 BLOCKED다. 개별 실행에서는 선택한 Critic만 Run에 포함되며 선행·후속 Critic은 실행 대상이 아니다.

브로커가 종료되어도 완료된 요청과 결과는 남는다. 중단된 실행은 재시작 시 ERROR로 표시하고 사용자가 새 요청을 제출해 다시 실행한다. 이 데모는 복잡한 분산 복구나 자동 재시도 정책까지 구현하지 않는다.

### Human

Human 리뷰는 최소 하나의 알림 방법을 등록해야 실행 가능하다. 로컬 Inbox를 알림 채널로 켜려면 다음과 같이 실행한다.

```sh
node src/cli.mjs serve --repo /path/to/repo --human-inbox
```

해당 Critic의 Profile을 `{"kind":"human"}`으로 설정한다. 요청은 알림 후 WAITING_HUMAN 상태에서 기다리며, 리뷰어가 claim한 후 판정과 근거를 제출한다. 데모의 기본 세 단계는 Agent·Agent·Runtime이므로 시연에 사용자의 개입이 필요하지 않다.

## 로컬 실행 범위

HTTP 서버는 loopback에만 연결하고 다른 웹사이트에서 오는 쓰기 요청을 거부한다. 등록한 로컬 저장소의 테스트 코드는 실제 프로세스로 실행한다. 임의의 외부 저장소를 안전하게 실행하는 컨테이너 보안 제품이나 공개 다중 사용자 서비스로 제공하는 범위는 아니다.

`.ccdd/` 아래에는 SQLite 상태, worktree, 데모 스냅샷과 로컬 실행 자료가 있다. 인증 정보와 이 로컬 상태는 Git에 올리지 않는다. 영상과 실제 검증 기록은 비공개 Release에서 제공한다.

- [시연과 검증 결과](docs/demo.md)
- [Requester 요청 계약](docs/requester-contract.md)
- [데모 영상 다운로드](https://github.com/lhj6102/ccdd/releases/tag/v0.1.0-demo)
