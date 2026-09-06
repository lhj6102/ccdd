# Repo Requester → Broker

Requester는 현재 repo와 선택한 workspace 정책을 지정합니다. 브로커가 입력을 준비한 다음, 그 입력의 `ccdd.config.ts`(또는 이전을 위한 legacy `ccdd.config.json`)에서 명시적인 리뷰 요청을 구성합니다. Git commit을 요구하지 않습니다.

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
  artifactGroups: [{id, members}], // 그룹을 포함한 범위에만 존재
  artifactTypes, configManifest, payload, profile, target, deps
}
```

`target`은 평가 대상, `deps`는 참조 Artifact ID 배열이며 개별 Artifact와 그룹 ID를 모두 사용할 수 있습니다. 설정의 그룹은 `{kind:'group',members:[ID,...],basis?}`로 선언하고 타입·경로를 갖지 않습니다. 구성원은 독립 정의를 참조하며 다른 그룹도 허용합니다. 비어 있거나 중복·미등록된 구성원 및 구성 순환은 거부합니다.

`[target, ...deps]`를 구성원 순서대로 재귀적으로 펼쳐 중복을 제거한 leaf 목록이 `artifacts`입니다. 도달한 그룹은 선택적인 `artifactGroups: [{id,members}]`에 직렬화합니다. 그룹 없는 요청은 이 필드를 생략하여 기존 형태를 유지합니다. 멤버의 Critic이 가진 `deps`까지 따라가지는 않습니다. 복사본에 다른 파일이 있어도 Artifact Runner는 요청 범위의 도구만 제공합니다. 접수와 도구 재연결은 leaf 및 그룹 정보를 같은 snapshot의 정의와 대조합니다.

그룹 구성은 선행 평가 조건이 아닙니다. 그룹의 판정은 그룹을 직접 대상으로 삼은 Critic들만 집계하고 멤버의 판정과 서로 전파하지 않습니다. `deps`·`basis`와 실행 대기 규칙은 그룹에도 독립적으로 적용됩니다. 그룹과 이미지 도구는 v1.1.0에 포함되며 기존 개별 Artifact 설정과 요청 계약은 유지합니다.

`payload.instruction`은 계속 문자열이며 설정·envelope·저장 기록·HTTP 응답에서 원문을 유지합니다. Agent 프롬프트를 만들 때만 요청 범위의 `{ID}`를 실제 제공된 도구 목록으로 펼칩니다. 도구는 이름을 추측하지 않고 등록된 `artifactId`로 연결합니다.

```text
원문: {spec}이 {why}의 요구사항을 충족하는지 검토하세요.
Agent: {"artifact":"spec","tools":["read_spec"]}이 {"artifact":"why","tools":["read_why"]}의 요구사항을 충족하는지 검토하세요.
```

그룹 `{explosion}`은 제공된 leaf마다 실제 도구 이름을 연결합니다. 중첩·공유 멤버도 한 번만 포함합니다.

```json
{"artifactGroup":"explosion","members":[{"artifact":"effect","tools":["read_effect"]},{"artifact":"preview","tools":["view_image_preview"]}]}
```

Human 화면은 같은 참조를 버튼으로 표시하여 해당 Artifact의 Human 도구 선택 영역으로 연결합니다. 그룹 참조에서는 멤버별 도구를 선택합니다. 참조 클릭은 선택·포커스만 수행하며, 도구 실행은 기존 claim 및 명시적 실행 절차를 따릅니다. 모니터는 저장된 leaf와 그룹 정보를 검증하여 안전한 표시 데이터만 제공하며, 화면 조회나 참조 해석으로 설정 코드를 평가하거나 Artifact 본문을 읽거나 프로그램을 실행하지 않습니다.

정확한 Artifact ID만 참조합니다. JSON 객체처럼 중괄호로 묶인 구간, 중첩·이중 중괄호, `\{spec}`처럼 escape한 참조, `{unknown}` 또는 요청 범위 밖의 ID, `{spec.path}` 같은 표현식은 원문 그대로 유지하며 새로운 접수 오류를 만들지 않습니다. instruction을 일반 JSON 문서로 해석하지 않으므로 그 구간 밖의 따옴표나 배열 안에서도 `{ID}`는 참조이며, 문자 그대로 쓰려면 escape합니다. `target`·`deps`가 정한 관측 범위는 바뀌지 않습니다. 도구 설명의 `{artifactName}` 치환과 별개의 규칙이며, instruction용 예약변수나 치환 결과의 저장 필드를 추가하지 않습니다. 다른 payload 필드도 변경하지 않습니다.

선택 Critic 요청은 하나의 envelope만 만들고 참조의 선행 통과를 요구하지 않습니다. 전체 Graph Run은 참조 Artifact의 모든 필수 Critic이 GREEN이거나 명시적인 기준 Artifact이면 해당 Critic을 실행합니다. 독립적인 Critic들은 병렬 실행되며 Human 대기도 독립 분기를 멈추지 않습니다. 수정 후 재요청은 새로운 Handle과 입력 hash를 갖습니다. 같은 hash의 복사본은 공유할 수 있지만 결과는 별도로 평가합니다.

Human copy 대기는 영속 상태이며 프로세스 상주를 요구하지 않습니다. 결과 제출 명령이 다음 실행을 이어갑니다. Human lock 대기는 입력 감시 worker가 살아 있어야 합니다.

TS 타입의 `agentTools`·`humanTools`에는 `{ metadata, execute, preflight? }` 정의를 명시적으로 등록합니다. 저장 시 함수는 제외하고 설명·입력 스키마·결과/관측 계약과 구현 식별 정보를 `configManifest`에 고정합니다. `artifactTypes`는 직렬화 가능한 타입 식별 정보만 전달합니다. 과거 JSON 요청에는 `configManifest`가 없으며 기존 Viewer 계약으로 실행합니다. Artifact Runner가 설명의 `{artifactName}`을 실제 Artifact ID로 치환하고 `read_spec`, `list_tests`, `open_spec` 등의 도구를 구성합니다. 새 Agent/Human 요청은 포함된 모든 Artifact에 해당 종류의 도구가 있어야 하며, 비어 있거나 생략된 목록은 요청 전에 거부됩니다. `--critic`으로 선택한 경우 그 Critic만 검사합니다. 도구 인자는 각 metadata의 JSON Schema로 검증하며 임의의 동작 이름·텍스트/JSON/이미지/앱 열기 결과를 지원합니다. 기본 Agent Reader는 줄 단위 `startLine`·`lineCount`와 디렉터리 내부 `path`를 사용합니다. 기본 Human 도구는 등록된 데스크톱 앱을 엽니다. Artifact Runner가 snapshot 경로와 출력·임시 디렉터리·취소 신호를 연결하며, 실행·Human 재개 시 당시 manifest와 구현을 대조합니다. 기본 도구 라이브러리 설치나 import만으로는 등록되지 않습니다.


그룹 요청에서도 도구 등록과 필수 관측 검증은 모든 leaf에 적용됩니다. `tools check --artifact GROUP`은 멤버 도구를 펼쳐 준비 상태를 확인하고, `--execute`에서는 실행할 leaf를 명시합니다. 이미지 기본 도구는 `agentTools: {view_image: agent.image.view()}`로 등록하여 `view_image_<ID>`를 제공합니다. Pi의 read 구현으로 최대 4MiB의 실제 PNG/JPEG/WebP 이미지 블록을 반환하며 별도 LLM 호출은 없습니다. 파일에는 `{}`, 디렉터리에는 내부 `path`를 전달합니다. 텍스트·GIF·BMP·APNG는 실패하며 자동 축소·변환은 하지 않습니다.

Agent는 Pi 실행기로 전달합니다. 공통 요청·결과 타입은 `src/contracts.ts`에 있으며 Pi 라이브러리 타입을 Broker 계약으로 노출하지 않습니다. 기본 이미지 도구의 내부 Pi read 어댑터도 Agent 세션이나 Broker 상태를 소유하지 않습니다. 인증 파일의 경로는 실행 환경 설정이고 repo payload나 Artifact 정의에 credential을 넣지 않습니다.
