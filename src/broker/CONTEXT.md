# Broker

브로커는 Requester의 리뷰 요청과 리뷰어의 판정을 연결하는 맥락이다. 어떤 스냅샷을 누가 평가하고 있으며, 어떤 결과를 요청자에게 돌려줄 수 있는지가 이 맥락의 언어다.

## Language

**Requester**:
리뷰를 요청하고 그 요청의 진행 상태와 결과를 받는 주체.
_Avoid_: Reviewer, 실행기

**Run**:
하나의 스냅샷과 정해진 평가 범위에 대한 리뷰 의뢰의 묶음.
_Avoid_: Task, 프로젝트

**Critic Run**:
선택한 Critic 하나만 평가하는 Run. GREEN은 선택한 Critic의 충족을 뜻하며 참조 Artifact나 다른 Critic의 충족을 뜻하지 않는다.
_Avoid_: Graph Run, 전체 검증

**Graph Run**:
정의된 Critic 전체를 Artifact 의존 관계에 따라 평가하는 Run. 모든 필수 리뷰가 GREEN일 때 전체 검증이 충족된다.
_Avoid_: Critic Run, 개별 평가

**Review Request**:
평가 대상 Artifact, 평가 기준, 스냅샷과 실행 조건이 정해진 한 번의 리뷰 의뢰.
_Avoid_: Critic 정의, 작업 목록

**Snapshot**:
리뷰의 Artifact와 Critic 정의를 포함하는 전체 입력 상태. 입력 내용의 hash로 식별되며, 리뷰 중 변경되지 않아야 한다.
_Avoid_: Git commit, 최신 소스

**Artifact Group**:
독립적으로 정의된 Artifact들을 참조하여 하나의 검토 단위로 묶은 것. 구성원의 식별자는 그룹 소속과 무관하게 유지되어 개별 참조할 수 있다.
_Avoid_: Artifact 복제, 디렉터리, 선행 Critic 목록

**Group Membership**:
어떤 Artifact가 그룹의 구성원이라는 관계. 그룹 구성은 검증 의존 관계와 구분하며, 소속 자체가 선행 검증을 요구하지 않는다.
_Avoid_: Dependency Artifact, 검증 순서, 자동 판정 전파

**Target Artifact**:
한 Critic이 판정하는 Artifact. 같은 Artifact를 여러 Critic이 서로 다른 기준으로 평가할 수 있다.
_Avoid_: 참조 Artifact, 생성 결과

**Dependency Artifact**:
Critic이 대상의 판정 근거로 참조하는 다른 Artifact. 전체 검증에서는 이 Artifact의 필수 평가가 통과해야 해당 Critic이 시작할 수 있다.
_Avoid_: 선행 Critic, 대상 Artifact

**Basis Artifact**:
별도의 Critic 판정을 요구하지 않는다고 명시한 검증의 출발점.
_Avoid_: 자동 통과, 검토 완료

**Artifact Validation**:
같은 스냅샷과 평가 범위에서 한 Artifact를 대상으로 하는 모든 필수 Critic의 판정을 종합한 상태. 개별 판정의 성공이나 미실행만으로 전체 통과가 되지 않는다.
_Avoid_: 파일의 영구적인 상태, 단일 Critic 판정

**Verdict**:
리뷰어가 평가 기준의 충족 여부에 대해 내린 GREEN 또는 RED 판정.
_Avoid_: 실행 오류, 진행 상태

**Blocked Review**:
참조 Artifact의 필수 검토가 충족되지 않아 아직 시작할 수 없는 리뷰 요청.
_Avoid_: 실패한 리뷰, RED 판정

**Human Claim**:
사람 리뷰어 한 명이 대기 중인 리뷰의 결과 제출을 맡았다는 약속.
_Avoid_: 완료, 판정

**Review Workspace**:
리뷰가 입력을 읽는 전체 작업 공간. 원본의 변경을 감시하거나 불변 복사본을 사용한다.
_Avoid_: Artifact 관측 범위, 리뷰 출력 공간

**Copied Workspace**:
원본에서 확보한 불변 리뷰 입력. 동일한 내용의 여러 리뷰가 함께 사용할 수 있다.
_Avoid_: 판정 캐시, Builder 작업 공간
