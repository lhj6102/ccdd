> Historical verification of v0.1/v0.2. This file describes the previous commit/server demo; use README.md and contracts.md for v0.3.

# 실제 시연 검증

2026-09-05, Node.js 24.15.0, Codex CLI 0.153.4와 `gpt-6-astra`로 실행했다. 브라우저에서 네 요청을 직접 제출했으며 요청 배열에는 커밋·Artifact 타입과 상대경로·payload·Provider Profile이 포함됐다.

| 스냅샷 | Spec → Why | Tests → Spec | Runtime → Implementation | 실행 결과 |
| --- | --- | --- | --- | --- |
| `530b86d3` 기준 | GREEN | GREEN | GREEN | GREEN |
| `9491804a` Why 변경 | RED | BLOCKED | BLOCKED | RED |
| `1764e572` 구현 불일치 | GREEN | GREEN | RED | RED |
| `b2dc464e` 수정 완료 | GREEN | GREEN | GREEN | GREEN |

- 실제 Agent 평가 **7회**에서 요청 범위의 MCP Viewer 호출을 확인했다. `read_why`, `read_spec`, `list_tests`, `read_tests` 호출 근거를 기록했다.
- Runtime은 실제 Node 테스트를 실행했다. 기준·수정 완료에서는 6개 모두 통과했고, 구현 불일치에서는 최대 2개 제한 테스트가 실패했다.
- 브라우저 JavaScript 오류는 **0개**였다.
- 브로커 프로세스를 정상 종료하고 다시 시작한 뒤, 네 실행의 ID·커밋·결과·근거·이벤트 전체가 이전 기록과 정확히 같음을 비교했다.
- 자동 검증 **25개**가 통과했다. 스냅샷 격리, 경로 범위, 명시적 요청 변조 거부, 실제 런타임, Provider 실패·취소, 영속성, Human 알림 실패·claim·결과 제출, HTTP 경계를 포함한다.
- 별도 npm tarball 설치에서도 CLI와 UI 파일, Codex 실행 경로, 동일한 네 커밋 생성을 검증했다. [패키지 검증](packaging-validation.md).

영상은 실제 브라우저 조작을 녹화했다. Agent 대기 구간만 6배속으로 편집하고 자막에 표시했다. 판정·테스트 출력·증거를 대체하거나 성공으로 바꾸지 않았다. 마지막 장면은 브로커 재시작 후 복원된 실제 화면이다. 한국어 자막이 있으며 음성은 없다.

[비공개 Release](https://github.com/lhj6102/ccdd/releases/tag/v0.1.0-demo)에서 MP4, npm 패키지, 실제 결과 `verification.json`, 재시작 비교 `restart-verification.json`을 내려받을 수 있다. JSON에는 최종 평가와 도구 호출 근거만 포함하며 인증 정보와 비공개 추론은 포함하지 않는다.
