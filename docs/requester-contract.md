# Repo Requester → Broker

Requester는 현재 repo와 선택한 workspace 정책을 지정합니다. 브로커가 입력을 준비한 다음, 그 입력의 `ccdd.config.json`에서 명시적인 리뷰 요청을 구성합니다. Git commit을 요구하지 않습니다.

```js
const broker = createBroker({repoPath, stateDir, repoId: 'local', executors});
const run = await broker.submit({mode: 'copy', requesterId: 'builder-feature-a', criticId: 'tests-spec'});
// Separate request worker:
await broker.run(run.id);
```

`stateDir`는 repo 밖의 경로입니다. 제출과 실행은 분리되어 있고, CLI가 요청별 worker를 시작합니다. 상태 조회 클라이언트는 실행기를 소유하지 않습니다.

입력이 준비된 후 `prepareReviewRequests({repoPath: workspace.path, repoId, snapshotHash: workspace.hash, criticId})`가 만드는 요청은 다음 필드를 포함합니다.

```js
{
  repoId, snapshotHash, criticId, title,
  artifacts: [{id, type, path}],
  artifactTypes, payload, profile, target, deps
}
```

`target`은 평가 대상, `deps`는 참조 Artifact ID 배열입니다. `artifacts`는 `[target, ...deps]`에서 도출한 리뷰어의 관측 범위입니다. 복사본에 다른 파일이 있어도 Artifact Runner는 요청에 선언된 Viewer 도구만 제공합니다. payload의 `{why}` 등은 Artifact ID 참조입니다. 전체 문서를 미리 프롬프트에 넣지 않습니다.

선택 Critic 요청은 하나의 envelope만 만들고 참조의 선행 통과를 요구하지 않습니다. 전체 Graph Run은 참조 Artifact의 모든 필수 Critic이 GREEN이거나 명시적인 기준 Artifact이면 해당 Critic을 실행합니다. 독립적인 Critic들은 병렬 실행되며 Human 대기도 독립 분기를 멈추지 않습니다. 수정 후 재요청은 새로운 Handle과 입력 hash를 갖습니다. 같은 hash의 복사본은 공유할 수 있지만 결과는 별도로 평가합니다.

Human copy 대기는 영속 상태이며 프로세스 상주를 요구하지 않습니다. 결과 제출 명령이 다음 실행을 이어갑니다. Human lock 대기는 입력 감시 worker가 살아 있어야 합니다.

타입의 `agentTools`·`humanTools` 정의는 `artifactTypes`에 포함되어 입력 hash 및 요청과 함께 고정됩니다. Artifact Runner가 설명의 `{artifactName}`을 실제 Artifact ID로 치환하고 `read_spec`, `list_tests`, `open_spec` 등의 도구를 구성합니다. 새 Agent/Human 요청은 포함된 모든 Artifact에 해당 종류의 도구가 있어야 하며, 비어 있거나 생략된 목록은 요청 전에 거부됩니다. `--critic`으로 선택한 경우 그 Critic만 검사합니다. 도구 인자는 줄 단위 `startLine`·`lineCount`이며 디렉터리 읽기에는 내부 `path`가 필요합니다. Human 프로그램 실행 도구는 repo에 등록된 실행 파일·인자를 사용하고, `{artifactPath}`를 해당 리뷰의 Artifact 경로로 치환합니다.


Agent는 Pi 실행기로 전달합니다. 공통 요청·결과 타입은 `src/contracts.ts`에 있으며 Pi 라이브러리 타입을 Broker 계약으로 노출하지 않습니다. 인증 파일의 경로는 실행 환경 설정이고 repo payload나 Artifact 정의에 credential을 넣지 않습니다.
