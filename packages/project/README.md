# @ccdd/project

CCDD 프로젝트 검증 도구. `@ccdd/core`는 정의만 제공하며 이 패키지가 검증 이력, CLI, Broker, 실행기와 선택적인 모니터를 제공합니다. 기본 도구는 별도 `@ccdd/default-tools` 패키지입니다.

Node.js 24 이상이 필요합니다. npm에 게시된 버전은 `npm install --ignore-scripts @ccdd/core @ccdd/project`로 프로젝트에 설치하고 `npx ccdd-project`로 실행합니다. 기본 도구를 사용할 경우 `@ccdd/default-tools`도 설치하세요.

```sh
ccdd-project status
ccdd-project plan implementation --recursive
ccdd-project verify implementation --recursive --wait
ccdd-project history implementation
ccdd-project run show RUN_ID
```

`verify ARTIFACT`는 실행 가능한 Critic만 의뢰하고 선행 조건이 막힌 Critic은 미완료로 보고합니다. `--recursive`는 필요한 선행 검증을 포함합니다. `--critic ID`로 특정 Critic을 선택해도 선행 조건을 확인합니다. 동일 입력의 실제 PASS는 원본 판정을 참조하여 재사용하며 티켓을 만들지 않습니다. `--force`는 선택한 Critic을 다시 검토합니다.

Artifact에 저장된 staleState는 없습니다. 판정 당시 target·직접 deps의 hash와 Critic 조건을 SQLite에 기록하고, 현재 판정은 DAG를 재귀적으로 조회해 계산합니다. `status`와 `plan`은 판정이나 티켓을 만들지 않습니다. 임시 memoization은 한 조회 안에서만 사용합니다.

상태 위치는 `~/.local/state/ccdd/<repo 경로 hash>`이며 `--state-dir` 또는 `CCDD_STATE_HOME`으로 지정합니다. SQLite, 입력 복사본과 검토 출력은 검토 대상 repo 밖에 있어야 합니다. 검증은 기본 copy, 명시적인 `--lock`으로 원본 입력 감시를 선택합니다.

`--json`은 구조화된 결과를 반환합니다. `verify --wait` 종료 코드는 0=범위 충족, 1=RED, 2=ERROR, 3=대기 시간 초과, 4=미완료입니다. 비동기 실행의 0은 접수 성공이며 대기 시간 초과는 실행을 취소하지 않습니다.

Human 리뷰는 `request claim`, `request tool`, `request submit`으로 처리합니다. `doctor`, `tools check`, `monitor`도 지원합니다. 상세한 옵션은 `ccdd-project help`를 확인하세요.

기존 `ccdd` 명령은 이 실행 패키지에 호환 CLI로 포함합니다. 기존 `ccdd run --critic`의 선행 조건 우회 의미는 유지되며, 새로운 프로젝트 검증은 `ccdd-project verify`를 사용합니다. 과거 결과 중 검증 입력 hash가 기록되지 않은 판정은 추측하여 재사용하지 않습니다.
