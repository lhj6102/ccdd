# Context Map

## Contexts

- [Broker](src/broker/CONTEXT.md): 평가 요청, 진행 상태, 담당과 반환할 결과의 기준이 되는 맥락.
- [Executors](src/executors/CONTEXT.md): Code Runner, Agent Provider, Human이 실제 리뷰를 수행하는 맥락.

## Relationships

- **Requester → Broker**: Repo와 스냅샷, Artifact 참조, 리뷰 payload를 포함한 요청을 제출한다.
- **Broker ↔ Executors**: 브로커가 리뷰를 맡기고 실행기가 판정과 근거를 돌려준다.
- **Artifact Runner → Executors**: payload에 참조된 Artifact의 Viewer 진입점을 리뷰어가 사용할 도구로 제공한다.
- **Broker → Requester**: 요청의 진행 상태와 결과를 원래 요청자에게 돌려준다.

두 맥락은 하나의 CCDD 제품 안에 존재한다. Artifact Runner는 요청과 관측 도구를 연결하는 경계다.
