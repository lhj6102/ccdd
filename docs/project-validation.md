# Project Validation CLI UX

CCDD config는 Artifact, Critic, 관계와 입력 동일성 기준을 정의한다. `@lhj6102/ccdd-project`의 `ccdd-project` 명령은 현재 검증 조회, 실제 검증 의뢰와 이력을 담당한다. 기존 `ccdd` 실행 파일은 같은 Project 패키지의 호환 인터페이스로 유지한다.

## 합의한 동작

- 현재 검증 충족 여부는 DAG를 따라 재귀적으로 조회한다. 개별 Artifact의 staleState를 저장하거나 하위 Artifact에 무효화를 전파하지 않는다.
- 실제 검증 이력과 마지막 검증 성공의 입력 식별 정보는 보관한다. Critic의 입력 동일성에는 해당 평가 조건, target과 직접 deps의 Artifact 동일성이 포함된다.
- 조회 단위의 memoization은 허용한다. 한 조회의 입력은 일관된 관측을 사용하며, 새 판정이 기록된 뒤 다시 판단할 때는 새 조회 컨텍스트를 사용한다.
- 개별 검증은 실행 가능한 선택 Critic부터 진행하고, 막힌 Critic을 미완료로 보고한다. 선행 Artifact의 검증을 자동으로 의뢰하지 않는다.
- recursive 검증은 필요한 선행 검증까지 포함한다. 선행 Artifact의 검증이 충족되면 다시 조회하여 후속 Critic의 과거 판정을 재사용할지 실제 검증을 의뢰할지 판단한다.
- 조회는 Provider 호출, Human 알림, 검토용 도구 실행, 리뷰 티켓 발급을 시작하지 않는다. 실제 검토와 Human 조작은 명시적인 실행 명령으로 요청한다.

## 핵심 명령

| 명령 | 사용자 질문과 결과 |
| --- | --- |
| `ccdd-project status` | 현재 프로젝트의 Artifact별 검증 충족 여부를 조회한다. |
| `ccdd-project status B` | B의 현재 판정, Critic별 재사용 근거와 미충족 이유를 조회한다. |
| `ccdd-project status --critic C` | 특정 Critic의 현재 입력에 적용 가능한 판정과 선행 조건을 조회한다. |
| `ccdd-project plan B` | B 개별 검증의 즉시 실행 가능, 재사용 가능, 선행 검증 필요 항목을 보여준다. 티켓은 발급하지 않는다. |
| `ccdd-project plan B --recursive` | 필요한 선행 검증까지 포함한 계획을 보여준다. 후속 검증은 선행 결과에 따라 재사용하거나 실행할 조건부 항목으로 표시한다. |
| `ccdd-project verify B` | B의 필요한 Critic 중 실행 가능한 것들을 의뢰하고 막힌 항목을 보고한다. |
| `ccdd-project verify B --recursive` | 필요한 선행 검증을 포함해 B의 검증을 의뢰한다. |
| `ccdd-project verify --critic C` | C만 의뢰한다. C의 deps 검증 조건은 적용하며 다른 Critic이나 선행 검증을 자동으로 추가하지 않는다. |
| `ccdd-project verify --critic C --recursive` | C와 C의 충족에 필요한 선행 Artifact 검증을 의뢰한다. C의 target을 평가하는 다른 Critic은 자동으로 포함하지 않는다. |
| `ccdd-project verify --all` | 프로젝트 전체를 대상으로 필요한 검증을 의뢰한다. |

`plan`도 `--critic C`와 `--all` 선택을 지원한다. Artifact 위치 인자, `--critic`, `--all`은 서로 배타적이다. `plan`과 `verify`는 대상을 명시해야 한다. `status`는 대상 생략 시 프로젝트 전체를 조회한다.

Artifact 검증은 해당 Artifact의 모든 필수 Critic을 범위로 삼는다. Critic 검증은 선택한 Critic만 대상으로 삼으므로 그 성공을 Artifact 전체의 PASS로 표시하지 않는다. Basis는 명시적으로 수용한 검증의 출발점으로 표시하고 실제 PASS 판정을 만들지 않는다. Critic이 없는 일반 Artifact도 자동 PASS가 되지 않는다.

## 실행 옵션

| 옵션 | 의미 |
| --- | --- |
| `--recursive` | 필요한 선행 Artifact 검증까지 범위를 확장한다. 하위 Artifact 검증은 추가하지 않는다. |
| `--force` | 선택한 대상 Critic들의 기존 판정을 재사용하지 않고 다시 검토한다. 선행 조건은 유지하며 recursive로 포함된 선행 검증은 필요할 때만 수행한다. |
| `--wait` | 접수한 검증의 결과를 기다린다. 대기 시간 초과는 검증 취소를 뜻하지 않는다. |
| `--timeout-ms N` | 클라이언트의 대기 시간을 지정한다. |
| `--copy`, `--lock` | 검토 입력을 고정하는 방법. 새 `verify`의 기본값은 copy이며 lock은 명시적으로 선택한다. 기존 `ccdd run`의 필수 옵션 계약은 별개다. |
| `--json` | 자동화 호출에 사용할 구조화된 결과를 반환한다. |
| `--repo PATH`, `--state-dir PATH` | 프로젝트와 외부 검증 이력 저장 위치를 지정한다. |

`plan --force`는 같은 옵션으로 실행했을 때의 계획을 보여준다. 유효한 과거 PASS를 전부 재사용해 새 검증이 필요 없으면, `verify`는 원래 판정의 참조와 함께 재사용 결과를 반환하고 새 리뷰 티켓을 만들지 않는다.

`--recursive`를 지정하지 않은 요청은 누락된 선행 검증을 미래에 자동 수행하겠다는 예약이 아니다. 실행할 수 있는 선택 Critic이 완료되면 미완료 항목을 명시한다. 사용자는 선행 검증을 완료한 뒤 다시 요청하거나 recursive 검증을 요청할 수 있다.

## A → B 예시

A를 평가하는 `a-check`, A에 의존해 B를 평가하는 `b-against-a`, deps가 없는 `b-alone`이 있다. A는 stale이고 두 B Critic에 현재 재사용할 수 있는 PASS가 없는 경우를 가정한다.

```text
$ ccdd-project plan B
B: 일부 실행 가능
  b-alone       실행 가능
  b-against-a   선행 검증 필요: A / a-check
실행 가능 1 · 선행 검증 필요 1 · 재사용 0

$ ccdd-project verify B
b-alone의 리뷰 요청을 접수했습니다.
b-against-a는 의뢰하지 않았습니다: A / a-check 검증 필요.
B 전체 검증은 아직 미완료입니다.

$ ccdd-project verify B --recursive
필요한 a-check와 b-alone의 리뷰 요청을 접수합니다.
b-against-a는 선행 검증 대기 항목으로 표시합니다.
A 검증이 충족되면 다시 조회하여 판정 재사용 또는 리뷰 요청을 결정합니다.
```

위 출력은 동작을 설명하기 위한 예시다. 실제 실행 결과를 기록한 것이 아니다. 두 `verify` 예시는 같은 초기 조건에서의 대안이며, 순서대로 실행해 이미 통과한 `b-alone`을 다시 실행한다는 뜻이 아니다.

A의 완료만으로 선행 조건을 충족하지 않는다. 현재 입력에 대한 필수 검증이 통과해야 하며 RED 또는 실행 오류이면 해당 의존 검증은 진행할 수 없다. 독립된 Critic의 실행과 이미 기록된 실제 판정은 유지한다.

## 실행 이력과 Human 조작

Review Request를 사용자가 말하는 리뷰 티켓의 단위로 유지한다. 실행 중인 요청의 담당·진행 상태는 실제 실행 기록이며 Artifact의 파생 staleState와 구분한다.

| 명령 계열 | 역할 |
| --- | --- |
| `ccdd-project history [B]` | 실제 판정 이력과 입력 식별 정보, 현재 재사용 중인 판정의 원본을 확인한다. `--critic C` 선택도 지원한다. |
| `ccdd-project run list` | 접수된 실행 묶음을 조회한다. |
| `ccdd-project run show RUN_ID [--wait]` | 특정 실행 묶음의 입력, 요청 범위, 진행과 미완료 항목을 확인한다. 현재 소스의 판정과 구분한다. |
| `ccdd-project run resume RUN_ID [--wait]` | 원래 입력과 범위의 재개 가능한 미완료 실행을 이어간다. |
| `ccdd-project run cancel RUN_ID` | 해당 실행의 미완료 작업을 취소한다. |
| `ccdd-project request list` | 개별 리뷰 티켓을 조회한다. `--run RUN_ID` 필터를 지원한다. |
| `ccdd-project request show REQUEST_ID` | 리뷰 지시, 고정된 입력, 실제 결과와 근거를 확인한다. |
| `ccdd-project request claim REQUEST_ID --reviewer ID` | Human 리뷰를 맡는다. |
| `ccdd-project request tool REQUEST_ID --reviewer ID --tool NAME --args JSON` | 담당 중인 Human 요청에 등록된 도구를 실행한다. |
| `ccdd-project request submit REQUEST_ID --reviewer ID --result-file PATH` | 실제 Human 판정과 근거를 제출한다. |

Human 도구 실행은 기존 요청의 고정된 입력과 등록 도구를 사용한다. 판정 제출은 기존 Broker의 담당 확인과 입력 무결성 조건을 유지한다.

## 보조 명령

- `graph [B]`: Artifact·Critic 정의와 관계를 확인한다.
- `config check`: 설정의 선언, 참조와 DAG 구조를 검사한다.
- `doctor`: 실제 실행 환경과 Provider 연결을 진단한다. 일반 상태 조회와 구분한다.
- `tools check`: 등록 도구를 확인하고 명시적인 `--execute`로 실제 동작을 진단한다.
- `monitor`: 현재 검증 조회, 이력과 명시적인 Human 조작을 제공하는 선택적 UI.

HTTP 모니터의 GET은 저장된 정의·관측·리뷰 정보의 읽기 경계를 유지한다. 현재 입력 관측을 준비하는 작업과 일반 GET을 구분하고, GET에서 config 평가, 검토용 도구 실행, 리뷰 상태 변경을 수행하지 않는다.

## 출력과 종료 의미

- `status`는 현재 검증 충족 여부를 보여준다. PASS, 미검토, 재검증 필요와 실제 RED의 근거를 구분한다. 실행 오류와 진행 중인 티켓은 `run show`로 확인한다.
- `plan`은 재사용 가능, 실행 가능, 선행 검증 필요를 Critic 단위로 보여준다. 이 계획은 조회 시점의 입력과 기록에 대한 설명이며, 나중의 실행은 다시 입력을 확보하고 판단한다.
- `verify`는 재사용한 판정, 접수한 리뷰, 미완료 항목을 따로 반환한다. 비동기 접수 성공을 Artifact의 PASS라고 표시하지 않는다.
- 특정 실행에서 일부 Critic만 성공했어도 요청 대상의 모든 조건이 충족되지 않으면 미완료로 보고한다.
- 현재 Artifact 조회와 Run 조회는 다른 질문이다. Run이 검토한 뒤 원본이 바뀌어도 그 Run의 실제 결과를 현재 원본의 PASS로 표시하지 않는다.

자동화를 위한 종료 코드는 `status`의 0=검증 충족, 1=미충족, 2=조회 오류다. `plan`은 유효한 계획을 만들면 차단 항목이 있어도 0, 계획을 만들 수 없으면 2를 반환한다. `verify --wait`와 `run show --wait`는 0=요청 범위 충족, 1=RED, 2=ERROR, 3=대기 시간 초과, 4=미완료로 구분한다. `--wait` 없는 새 실행의 0은 접수 성공이다. 실행 중인 범위가 있다면 최종 판정은 결과 조회에서 확인한다.

## 기존 CLI와의 차이

- 현재 `ccdd status RUN_ID`는 실행 이력을 조회한다. 새 명령은 `status B`와 `run show RUN_ID`로 현재 판정과 고정된 실행 기록을 구분한다.
- 현재 `ccdd run --critic C`는 선행 검증 조건을 우회하는 선택 Critic 실행이다. 새 `verify --critic C`는 선행 조건을 적용한다. 기존 명령의 의미를 조용히 바꾸는 호환 처리로 취급하지 않는다.
- 현재 전체 Graph Run은 같은 Run의 GREEN 결과를 요구한다. 새 명령의 재사용은 실제 이전 판정의 입력 동일성을 확인하고 원본 판정을 참조하는 별도 프로젝트 검증 책임이다.
- 기존 `ccdd` 실행 파일은 Project 패키지에 포함된다. 정의 전용 core 패키지에는 실행 파일과 실행 의존성이 없다.

## 입력 동일성과 상태 저장

Artifact의 기본 전략은 `{kind:'file-hash'}`이며 자신의 `path`를 재귀적으로 hash한다. `{kind:'file-hash',paths:['spec.md','references']}`는 이 기본 경로 집합을 대체한다. 파일 내용, 상대경로, 파일 유형, 실행 권한, 빈 디렉터리가 포함되며 선언한 추가 경로의 생성·삭제도 변경으로 판단한다. glob과 symlink는 허용하지 않는다. Artifact 의미에 영향을 주는 모든 입력을 선언해야 한다. 그룹은 구성원 내용의 동일성을 포함하지만 구성원 검증을 자동 선행 조건으로 삼지 않는다.

`{kind:'always'}`는 새 검증 요청마다 해당 Artifact를 사용하는 Critic을 다시 검토한다. 같은 요청 안에서 완료된 검토는 선행 조건을 충족할 수 있어 재귀 실행이 무한 반복되지 않는다. 모델·서비스 등 외부 조건이 바뀔 수 있는 검토도 필요한 경우 이 전략이나 `--force`를 사용한다.

같은 target·직접 deps hash라도 Critic의 profile·지시·도구 정의가 바뀌면 재검증한다. TS 설정의 함수는 import한 값을 참조할 수 있으므로 설정을 로드할 때 기록한 모듈 hash 전체를 보수적으로 포함한다. 공유 TS 설정 코드를 수정하면 일부 관련 없는 Critic도 재검증될 수 있다. 같은 입력의 판정이 여러 개이면 가장 최근 실제 판정을 적용하며, 나중의 RED를 과거 PASS가 덮지 않는다.

저장은 별도 Project 패키지가 repo 밖의 기본 `~/.local/state/ccdd/<정규화된 repo 경로 hash>/broker.sqlite`에 한다. `--state-dir` 또는 `CCDD_STATE_HOME`으로 위치를 바꿀 수 있다.

| 저장 정보 | 내용 |
| --- | --- |
| 실제 판정 | Critic ID, GREEN/RED, 근거, 완료 시각과 실제 요청 ID |
| 판정의 검증 입력 | 당시 target hash, 직접 deps hash, 유효 Critic 정의 hash |
| 실행·티켓 이력 | 고정 입력, 선택 범위, 담당·실행 상태, 완료한 실행이 사용한 판정 참조 |
| 입력·출력 파일 | `workspaces/<hash>` 입력 복사본, `runs/<runId>/<requestId>` 검토 출력 |

현재 Artifact의 staleState와 조회 결과는 저장하지 않는다. 최신 판정의 입력과 현재 입력을 비교하는 memoization은 한 조회 안에서만 존재한다. 이력이 없는 프로젝트의 `status`·`plan`은 DB도 생성하지 않는다. 기존 이력 중 검증 입력 hash가 없는 리뷰는 계속 열람할 수 있지만 재사용 근거로 추측하지 않는다.

완료한 Run의 판정 참조는 고정한다. 이후 다른 리뷰가 통과해도 당시의 미완료 Run이 소급하여 성공으로 바뀌지 않는다. terminal INCOMPLETE를 `run resume`해 누락된 선행 검증을 추가하지 않으며, 새 `verify` 또는 `verify --recursive`를 요청한다.

모니터의 현재 입력 화면은 사용자가 **현재 입력 확인**을 누를 때만 설정과 파일을 관측하는 인증된 POST를 보낸다. 결과는 관측 시각과 함께 브라우저에 표시한다. 자동 GET은 실행 기록을 관측하며, 현재 입력을 다시 확인하거나 판정을 생성하지 않는다.

## 구현 검증 기록

2026-09-07, Windows / Node 24.18.0에서 TypeScript·Vue 타입 검사와 production 빌드, 프로젝트 검증·DAG·그룹·모니터·배포 계약 관련 테스트 50개를 통과했다. 실제 Node 테스트 실행과 Human 제출 경로로 재귀 진행, 개별 미완료, 최신 RED, always, 입력 hash 변경과 이전 판정 재사용을 확인했다.

`npm run test:packages`는 세 tarball의 파일 경계를 검사하고, 기본 도구를 쓰는 구성과 사용자 도구만 쓰는 구성에 실제 production 설치를 수행한다. Runtime 설치는 검토할 입력 밖에 두고, 실제 설치한 SDK·선택한 텍스트 도구 파일은 검토 입력에 포함한다. 두 구성 모두 실제 도구 실행, 분리된 worker의 검증, 새 티켓 없는 PASS 재사용을 통과했다. Provider 판정을 대신 생성하거나 데스크톱 프로그램을 띄우는 검증은 아니다.

v2.0.0 배포 준비에서는 별도 Linux / Node 24.18.0의 격리된 clone으로 빌드·전체 테스트 302개와 세 tarball의 두 가지 production 설치·실행 검증을 모두 통과했다. 실패·취소·건너뛴 테스트는 0개다. 배포 커밋의 최종 검증 결과는 Release의 `verification.json`에 기록한다.

Windows 전체 테스트에는 Unix 경로·symlink 권한·프로세스 종료 가정으로 인한 실패가 남아 있다. 별도로, production 설치 폴더 전체와 모든 의존성을 검토 입력으로 삼은 copy 검증은 5분 안에 완료되지 않았다. 모든 입력을 검사하는 workspace 계약은 유지하며, 대규모 snapshot의 성능 개선은 이번 변경에 포함하지 않는다.
