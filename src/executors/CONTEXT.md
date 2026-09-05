# Executors

브로커가 맡긴 리뷰를 실제로 수행하는 맥락이다. 실행기는 판정과 근거를 제공하고, 요청의 담당과 진행 상태는 브로커가 관리한다.

## Language

**Executor**:
리뷰 요청의 실행 조건을 충족해 평가를 수행하는 주체다. Code Runner, Agent Provider, Human이 서로 다른 실행 방식이다.
_Avoid_: 브로커, 상태 관리자

**Code Runner**:
테스트 코드 등의 평가 절차를 실행하고 그 결과를 판정으로 돌려주는 실행기다.
_Avoid_: Agent, 구현 생성기

**Agent Provider**:
요청에서 지정한 Provider와 모델 등의 조건으로 Agent 리뷰를 수행하는 실행기다.
_Avoid_: 기본 AI, 임의 모델

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
특정 스냅샷과 Artifact 범위에서 리뷰어가 필요한 부분을 관측할 수 있는 진입점이다. Agent에게는 사용할 수 있는 도구로 제공된다.
_Avoid_: 전체 파일을 미리 넣은 프롬프트, Repo 전체 접근

**Review Result**:
리뷰어가 관측한 Artifact에 대해 내린 GREEN 또는 RED 판정과 그 근거다. 실행 실패는 판정이 아니다.
_Avoid_: 실행 성공, 추측한 통과
