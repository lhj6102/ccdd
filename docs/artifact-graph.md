# Artifact 의존성과 모니터 GraphView

Critic은 평가할 Artifact 하나를 `target`으로, 판단의 근거로 읽는 다른 Artifact들을 `deps` 배열로 선언합니다. `critics` 배열의 순서는 실행 순서가 아닙니다. `deps → target` 관계가 Artifact DAG를 만들며, 같은 Artifact를 여러 Critic이 평가할 수 있습니다.

```json
{
  "artifacts": {
    "why": {"type": "markdown", "path": "why.md", "basis": true},
    "spec": {"type": "markdown", "path": "spec.md"}
  },
  "artifactTypes": {
    "markdown": {
      "viewer": "text",
      "agentTools": {"read": {}},
      "humanTools": {"read": {}}
    }
  },
  "critics": [
    {
      "id": "spec-why",
      "title": "Spec이 Why를 충족하는가",
      "target": "spec",
      "deps": ["why"],
      "profile": {"kind": "agent", "provider": "openai-codex", "model": "gpt-6-astra", "reasoning": "medium"},
      "payload": {"instruction": "Why의 요구사항이 Spec에 보존됐는지 평가하세요."}
    },
    {
      "id": "spec-readability",
      "title": "Spec을 사람이 이해할 수 있는가",
      "target": "spec",
      "deps": [],
      "profile": {"kind": "human"},
      "payload": {"instruction": "구현자가 요구사항을 명확하게 이해할 수 있는지 평가하세요."}
    }
  ]
}
```

이 예시는 Human 알림을 등록한 뒤 실행합니다. 두 Critic 모두 Spec을 읽을 수 있으며 첫 Critic만 Why를 추가로 읽습니다. Agent/Human 도구 준비 검사는 `target`과 `deps` 전체에 적용됩니다. 런타임의 경로 제한도 같은 관측 범위를 사용합니다.

## 평가와 실행 규칙

- 한 Artifact를 대상으로 하는 모든 Critic이 필수입니다. 같은 Run에서 모두 GREEN일 때 Artifact가 GREEN입니다.
- `basis: true`는 외부에서 수용한 검증의 출발점입니다. GREEN 판정과 구분해 `BASIS`로 표시하며, 이 Artifact를 평가하는 Critic을 동시에 선언할 수 없습니다.
- Critic이 없는 일반 Artifact는 미평가입니다. 이를 `deps`로 사용하려면 Critic을 추가하거나 명시적으로 기준 Artifact로 지정해야 합니다.
- 전체 Graph Run은 각 Critic의 모든 참조 Artifact가 통과했거나 BASIS이면 실행합니다. 같은 대상을 평가하는 독립 Critic들은 병렬로 실행할 수 있습니다. Agent/Runtime 실행은 Run당 최대 4개이며 Human 알림과 대기는 별도로 진행합니다.
- 한 Critic의 RED 또는 실행 오류는 그 결과를 필요로 하는 검토를 BLOCKED로 남깁니다. 독립 분기는 계속 실행합니다. Run은 독립적인 작업과 Human 검토가 끝난 뒤 최종 RED/ERROR를 확정합니다.
- 취소, 작업 프로세스 종료, 입력 무결성 실패는 전체 Run의 미완료 요청을 ERROR로 종료합니다. 완료한 판정은 변경하지 않습니다.
- `--critic ID`는 참조 Artifact의 통과를 기다리지 않고 해당 Critic만 진단합니다. 나머지 Critic들은 이번 실행에 포함되지 않은 것으로 표시합니다. 같은 대상에 다른 필수 Critic이 있다면 하나의 GREEN으로 Artifact 전체가 GREEN이 되지 않습니다.
- 자기 참조, 중복 deps, 알 수 없는 Artifact, 순환 관계는 접수 전에 거부합니다.

## Kanban과 Graph

Kanban은 ReviewRequest를 요청·진행 중·성공·실패로 보여줍니다. Graph는 하나의 프로젝트와 검증 실행을 선택해 그 Run의 snapshot에 고정된 Artifact 정의와 판정을 보여줍니다. 프로젝트·실행을 선택한 상태는 View 전환 시 유지합니다.

Graph의 노드는 Artifact이며 각 Critic을 선 아이콘 하나로 표시합니다. Agent는 공통 Agent 아이콘, Human은 사람, Runtime은 터미널로 구분하며 같은 종류의 Critic도 각각 표시합니다. 아이콘 선은 요청·대기 회색, 리뷰 중 파랑, 성공 초록, 실패 빨강입니다. Human은 claim 이후 리뷰 중으로 표시합니다. 아이콘에 마우스를 올리거나 키보드로 초점을 맞추면 Critic 이름과 정확한 상태를 확인하고, 누르면 기존 요청 상세를 엽니다. 평가 실패와 실행 오류는 설명으로 구분하며, 이번 실행에 포함되지 않은 Critic은 점선과 비활성 상태로 표시합니다.

캔버스를 이동·확대하거나 전체 보기로 Artifact 관계를 살펴볼 수 있습니다. 상태 갱신 중에는 노드 위치와 확대 수준을 유지합니다. 동일한 Artifact 간선은 합치되 관계를 사용하는 Critic 목록을 보존합니다. 노드를 선택하면 평가 Critic들과 각자의 참조 Artifact를 확인할 수 있습니다. Human claim·도구 실행·판정 제출은 Kanban과 같은 요청 상세를 사용합니다.

세 실행 종류의 아이콘과 다중 Critic을 재현하는 입력은 [GraphView 개발 검증용 프로젝트](monitor-graph-demo.md)에 있습니다.

선행 평가가 실패해 시작하지 못한 Artifact를 실패로 표시하지 않습니다. Human 대기는 담당자가 없는 경우와 검토자가 맡은 경우를 구분합니다. 서로 다른 Run이나 snapshot의 성공 결과를 합치지 않으며, 단독 Critic 실행에도 전체 정의를 표시해 미실행 평가가 가려지지 않게 합니다. Graph 조회는 상태를 변경하거나 작업을 재개하지 않습니다.

## 기존 설정 변경

기존 Critic의 `dependsOn`과 `artifacts`를 제거하고 `target`과 `deps`를 작성합니다. 예전 `dependsOn`은 Critic ID였지만 새 `deps`는 Artifact ID입니다. 기존 관측 목록의 순서만으로 대상과 참조를 판별할 수 없으므로 자동 변환하지 않습니다. 두 역할은 Critic의 실제 평가 기준을 보고 결정합니다.

기존 Why → Spec → Tests → Implementation 데모는 다음과 같습니다.

| Critic | target | deps |
| --- | --- | --- |
| spec-why | spec | [why] |
| tests-spec | tests | [spec] |
| implementation-tests | implementation | [tests] |

Why는 `basis: true`로 선언합니다. 새 데모는 `demo-v8`에 생성하며 기존 데모·사용자 설정·복사본·리뷰 기록을 덮어쓰지 않습니다.

과거 요청은 Kanban과 요청 상세에서 계속 읽을 수 있습니다. Artifact 역할이 저장되지 않은 과거 실행은 Graph를 추측해 그리지 않고 사용할 수 없다는 안내를 표시합니다. 과거에 대기하던 Human 요청은 기존 snapshot의 도구 범위와 실행 계약으로 이어집니다.
