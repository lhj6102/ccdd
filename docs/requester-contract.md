# Repo Requester → Broker

Repo Requester는 저장소의 지정 커밋에서 `ccdd.config.json`을 읽어 명시적인 리뷰 요청을 만든다. 브로커에 전달하는 요청에는 Artifact의 타입과 Repo 상대경로, 리뷰 스냅샷 커밋, 리뷰 payload 및 실행 조건이 함께 들어간다.

```js
import { prepareReviewRequests } from '../src/requester/index.mjs';

const reviewRequests = await prepareReviewRequests({
  repoPath,
  repoId: 'demo',
  snapshotCommit,
});

// POST /api/runs
const body = { snapshotCommit, requesterId: 'web-demo', reviewRequests };
```

`prepareReviewRequests`는 커밋을 읽기만 하며 작업 폴더를 바꾸거나 리뷰를 실행하지 않는다. 반환값은 Critic 의존 순서로 정렬된 다음 형태의 배열이다.

```json
{
  "repoId": "demo",
  "snapshotCommit": "<full commit hash>",
  "criticId": "spec-why",
  "title": "Spec이 Why에 부합하는가",
  "artifacts": [
    {"id": "why", "type": "markdown", "path": "why.md"},
    {"id": "spec", "type": "markdown", "path": "spec.md"}
  ],
  "artifactTypes": {"markdown": {"viewer": "text"}, "code": {"viewer": "files"}},
  "payload": {"instruction": "Compare {why} and {spec}."},
  "profile": {"kind": "agent", "provider": "codex", "model": "gpt-6-astra", "reasoning": "medium"},
  "dependsOn": null
}
```

`artifacts`는 요청에서 허용한 관측 범위다. `payload`는 그 범위에서 수행할 리뷰 지시이며 `{why}` 같은 표시는 Artifact ID를 가리킨다. Artifact Runner는 이 요청의 Artifact 메타데이터를 읽어 `read_why`, `read_spec` 같은 Viewer 도구를 만든다. 문서 전체를 미리 프롬프트에 넣는 방식이 아니다.

데모에서는 `GET /api/demo`의 각 `scenario.reviewRequests`로 준비된 요청을 브라우저 Requester에 전달한다. 브라우저는 선택한 스냅샷의 요청 배열을 `POST /api/runs`로 제출한다. 브로커는 등록된 Repo의 같은 커밋 정의와 대조해 Repo·커밋·Artifact·payload·Profile·의존 관계가 일치하는지 확인한 뒤, Handle과 진행 상태를 추가해 보관한다. 이 데모에서는 커밋과 다른 임의의 요청 재정의를 허용하지 않는다.

기존 커밋 전용 제출은 편의 경로로 유지할 수 있다. 그 경우도 같은 Repo Requester 어댑터를 거쳐 요청을 준비한다. 브로커와 실행기는 요청을 받은 뒤의 영속성·배정·평가를 각각 맡으며, 리뷰를 시작할 때 해당 스냅샷을 detached worktree로 재현한다.
