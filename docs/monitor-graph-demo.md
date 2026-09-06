# GraphView 개발 검증용 프로젝트

`test/fixtures/monitor-graph`는 Agent·Human·Runtime 아이콘과 다중 Critic, 분기·합류를 확인하는 작은 합성 프로젝트입니다. 소스 체크아웃에서 사용하는 검증 입력이며 npm 패키지에는 포함되지 않습니다. 이 입력은 기존 모니터 화면과 과거 기록 호환을 확인하기 위해 legacy JSON Viewer 등록을 유지합니다. 새 TS 설정과 기본 Human 데스크톱 도구를 시연하려면 [v9 CLI 데모](demo.md)를 사용합니다. 기본 `prepare-demo`는 선형 Why → Spec → Tests → Implementation을 유지합니다.

| Critic | 종류 | 평가 대상 | 참조 |
| --- | --- | --- | --- |
| spec-why | Agent | spec | why |
| spec-human | Human | spec | why |
| tests-spec | Agent | tests | spec |
| notes-independent | Runtime | notes | why |
| implementation-tests | Runtime | implementation | tests, notes, spec |

아이콘은 저장된 실행의 `profile.kind`를 따릅니다. Spec·Tests의 의미 검토는 `openai-codex / gpt-6-astra / medium` Agent가 수행하고, 구현 검증은 실제 Node 테스트를 실행합니다. 파일 안에 테스트 코드가 있다는 이유로 Critic 종류를 Runtime으로 추측하지 않습니다.

저장소 루트에서 빌드한 뒤 실행합니다. 아래 인증 옵션은 기존 Codex 인증을 읽기 전용으로 연결하며 Agent 호출은 사용량을 소비합니다. 인증과 리뷰 상태는 검토 입력 밖에 둡니다.

```sh
npm run build
node dist/src/cli.js run --repo test/fixtures/monitor-graph --copy --human-inbox --codex-auth-file "$HOME/.codex/auth.json"
node dist/src/cli.js monitor --repo test/fixtures/monitor-graph
```

Graph에서 새 실행을 선택합니다. Spec의 Agent 아이콘과 Human 아이콘은 각각의 요청 상세를 엽니다. 이 legacy 입력의 Human 검토자가 화면에서 Why와 Spec을 읽고 claim·판정을 제출해야 Spec의 모든 Critic이 완료됩니다. 둘 다 GREEN이면 Tests의 Agent 검토가 시작되고, 필요한 Artifact가 모두 통과하면 구현 테스트가 실행됩니다. 사람의 판정을 자동으로 제출하거나 Agent 판정을 고정하지 않습니다.

설정을 바꾼 뒤에는 새 실행이 필요합니다. 이미 기록된 Runtime 요청은 과거 snapshot의 종류와 판정을 유지합니다.

2026-09-06 로컬 확인: 이 입력의 Spec Critic은 실제 Astra 호출과 Artifact 도구 읽기를 거쳐 GREEN을 반환했고 Agent 아이콘·요청 상세 연결을 확인했습니다. 해당 실행의 Human 판정은 대기 상태이며 Tests 검토는 아직 시작하지 않았습니다.
