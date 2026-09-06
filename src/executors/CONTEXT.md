# Executors

브로커가 맡긴 리뷰를 실제로 수행하는 맥락이다. 실행기는 판정과 근거를 제공하고, 요청의 담당과 진행 상태는 브로커가 관리한다.

## Language

**Executor**:
리뷰 요청의 실행 조건을 충족해 평가를 수행하는 주체다. Runtime Critic, Agent Critic, Human Critic이 서로 다른 실행 방식이다.
_Avoid_: 브로커, 상태 관리자

**Runtime Critic**:
테스트 코드 등의 평가 절차를 실행하고 그 결과를 판정으로 돌려주는 실행기다.
_Avoid_: Agent, 구현 생성기

**Agent Critic**:
요청에서 지정한 Provider와 모델 등의 조건으로 Agent 리뷰를 수행하는 실행기다.
_Avoid_: 기본 AI, 임의 모델

**Provider**:
Agent Critic이 요청한 모델의 추론을 수행하도록 연결하는 외부 제공자다.
_Avoid_: 리뷰 실행기, Human Reviewer

**Human Critic**:
사람의 관측과 판정 제출을 통해 리뷰를 수행하는 실행 방식이다.
_Avoid_: Agent 세션, 자동 승인

**Human Reviewer**:
알림을 통해 리뷰 요청을 전달받고, 담당한 요청에 판정과 근거를 제출하는 사람이다.
_Avoid_: 자동 승인, Agent 대리 판정

**Alarm Method**:
Human Reviewer에게 대기 중인 리뷰를 알리기 위해 명시적으로 등록한 전달 방법이다. Human 리뷰에는 최소 하나가 필요하다.
_Avoid_: 등록 없는 대기열

**Artifact Runner**:
리뷰 payload가 참조한 Artifact와 그 유형을 해당 Artifact를 관측할 수 있는 Viewer 진입점에 연결하는 경계다.
_Avoid_: 테스트 실행기, Artifact 생성기

**Viewer Entry Point**:
특정 스냅샷의 Artifact에 대해 하나의 관측 동작을 제공하는 진입점이다. Artifact 타입에 정의된 설명을 바탕으로 리뷰어에게 관측 범위와 동작을 안내한다.
_Avoid_: 전체 파일을 미리 넣은 프롬프트, Repo 전체 접근

**Instruction Artifact Reference**:
검토 지시사항에서 요청에 포함된 특정 Artifact와 그 리뷰어가 사용할 관측 수단을 가리키는 참조다. 참조는 평가 대상과 의존 관계가 정한 관측 범위 안에서 의미를 가지며, 관측이나 판정 자체를 뜻하지 않는다.
_Avoid_: Artifact 본문 삽입, 접근 권한 부여, 도구 실행

**Artifact Tool Definition**:
Artifact 유형이 리뷰어에게 제공할 관측 동작의 정의다. 동작의 설명, 받을 입력과 수행할 행위를 함께 가지며, 정의를 준비하는 것과 실제 Artifact를 관측하는 것은 별개다.
_Avoid_: 도구 호출 결과, Critic 판정

**Default Artifact Tools**:
사용자가 프로젝트에 선택하여 등록할 수 있도록 CCDD가 제공하는 관측 도구 모음이다. 도구 모음을 사용할 수 있다는 사실만으로 리뷰어에게 관측 수단이 주어지지는 않는다.
_Avoid_: 자동 등록 도구, 필수 Viewer

**Agent Tool**:
Artifact 타입이 Agent 리뷰어에게 허용한 관측 동작이다. 해당 동작은 요청에 포함된 특정 Artifact에 연결된다.
_Avoid_: Human Tool, Agent의 범용 도구

**Human Tool**:
Artifact 타입이 사람 리뷰어에게 제공하는 열람 수단이다. 열람 수단을 열었다는 사실은 사람의 검토나 판정 완료를 뜻하지 않는다.
_Avoid_: 자동 판정, Human Claim

**Tool Readiness**:
지정한 리뷰어가 Artifact의 등록된 도구를 사용할 준비가 되어 있는지에 대한 확인이다. 도구의 실제 실행 확인과 Artifact의 품질 판정은 서로 다른 결과다.
_Avoid_: Verdict, 리뷰 통과

**Review Result**:
리뷰어가 관측한 Artifact에 대해 내린 GREEN 또는 RED 판정과 그 근거다. 실행 실패는 판정이 아니다.
_Avoid_: 실행 성공, 추측한 통과

**Readiness Diagnostic**:
요청된 실행 조건으로 지금 리뷰를 시작할 준비가 되었는지 확인한 관측이다. Artifact에 대한 품질 판정이나 이후 실행의 성공 보장은 아니다.
_Avoid_: Critic 통과, Health 응답, 영구 인증 보증
