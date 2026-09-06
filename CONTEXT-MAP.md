# Context Map

## Contexts

- [Broker](src/broker/CONTEXT.md): 평가 요청, 진행 상태, 담당과 반환할 결과의 기준이 되는 맥락.
- [Executors](src/executors/CONTEXT.md): Runtime Critic, Agent Critic, Human Critic이 실제 리뷰를 수행하는 맥락.

## Relationships

- **Requester → Broker**: Repo와 workspace 정책을 지정하며, 준비된 입력의 Artifact 참조·리뷰 payload로 요청을 구성한다.
- **Broker ↔ Executors**: 브로커가 리뷰를 맡기고 실행기가 판정과 근거를 돌려준다.
- **Artifact Runner → Executors**: payload에 참조된 Artifact에 등록된 도구 정의를 연결하여 리뷰어가 사용할 관측 진입점을 제공한다.
- **도구 라이브러리 → 프로젝트 설정**: 기본 또는 사용자 관측 도구 정의를 제공한다. 프로젝트가 명시적으로 등록한 정의만 리뷰어에게 제공한다. 라이브러리 자체가 요청·실행 상태를 소유하지 않는다.
- **Broker → Requester**: 요청의 진행 상태와 결과를 원래 요청자에게 돌려준다.

두 맥락은 하나의 CCDD 제품 안에 존재한다. Artifact Runner는 요청과 관측 도구를 연결하는 경계다. 기본 도구 라이브러리는 선택 가능한 구현 모음이며 별도의 업무 맥락이나 실행 관리자 역할을 하지 않는다.

로컬 모니터는 선택적인 인터페이스다. 여러 프로젝트의 저장된 리뷰 상태를 보여주며, Human Reviewer의 명시적인 claim·도구 실행·판정 제출을 Broker에 전달한다. 리뷰 실행을 소유하지 않으며 상태 조회로 리뷰 기록을 변경하지 않는다.
