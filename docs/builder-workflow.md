# Builder가 특정 Critic을 통과할 때까지 수정하기

CCDD는 리뷰 요청을 중계하고 판정·근거를 돌려준다. 기능을 만드는 builder subagent의 생성과 수정 반복은 Requester가 맡는다.

## 1. 프로젝트의 실행 준비 상태 진단

```sh
ccdd doctor --repo /path/to/project --commit HEAD --json
```

`doctor`는 지정 커밋의 Critic 정의와 Artifact를 읽고, 해당 프로젝트가 요구하는 실행기를 검사한다. Agent는 요청된 Provider·모델·reasoning으로 실제 호출한다. 임시 진단 Artifact를 MCP Viewer로 읽고 그 안의 무작위 값을 되돌려 받아, 인증·모델 접근·도구 연결이 실제로 동작하는지 확인한다. 동일한 Agent Profile은 한 번만 호출한다.

특정 Critic만 필요한 builder는 검사 범위를 좁힐 수 있다.

```sh
ccdd doctor --repo /path/to/project --commit HEAD --critic tests-spec --json
```

이미 실행 중인 브로커의 실행기·Human 알림 등록 설정을 그대로 진단하려면 다음과 같이 호출한다.

```sh
ccdd doctor --url http://127.0.0.1:4317 --commit FULL_COMMIT_HASH --critic tests-spec --json
```

`READY`는 **진단 시점의 실행 준비 상태**다. 요구사항을 충족했다는 Critic 판정은 리뷰로 확인한다. 실제 Provider 호출에는 사용량과 대기 시간이 발생한다. 인증·권한·네트워크 상태가 이후 바뀔 수 있으므로 리뷰 중 ERROR 처리도 유지한다.

진단은 브로커의 Run이나 GREEN/RED 판정을 만들지 않는다. Runtime 진단은 Node 실행과 테스트 경로 접근을 확인하며 프로젝트 테스트를 실행하지 않는다. Human 진단은 알림 방법 등록을 확인하며 알림을 발송하거나 사람의 응답 가능 여부를 추정하지 않는다. `/api/health`는 브로커 생존 상태만 반환하고 `readinessChecked:false`, `providerReady:null`을 명시한다.

## 2. 한 Critic만 제출하고 완료까지 기다리기

```sh
ccdd run --commit FULL_COMMIT_HASH --critic tests-spec \
  --requester builder-feature-a --wait --json
```

이 명령은 `tests-spec` 하나만 실행한다. 앞 단계 `spec-why`와 뒤 단계 Runtime은 이 Run의 대상에 포함되지 않는다. 해당 Critic의 원래 의존 정의와 Artifact 범위는 보존하며, 이 요청은 독립적으로 실행한다.

반환된 JSON에는 다음 정보가 들어간다.

```json
{
  "id": "review-handle",
  "snapshotCommit": "full-immutable-commit-hash",
  "scope": {"kind": "critic", "criticId": "tests-spec"},
  "status": "GREEN",
  "requests": [{"criticId": "tests-spec", "status": "GREEN", "result": {"verdict": "GREEN", "summary": "...", "evidence": ["..."]}}]
}
```

이 GREEN은 선택한 Critic의 판정이다. 전체 그래프의 통과를 의미하지 않는다. 화면과 이력에도 `선택 Critic 통과`로 표시한다. `--critic`을 생략하면 기존 직렬 전체 실행을 사용한다.

| 명령 결과 | 종료 코드 | Builder 처리 |
| --- | --- | --- |
| GREEN | 0 | 선택한 기준 충족; 맡은 작업의 다음 단계 진행 |
| RED | 1 | `requests[0].result.evidence`를 읽고 수정 |
| ERROR 또는 접수·통신 오류 | 2 | 설정·인증·연결·실행 오류 해결 |
| 완료 대기 시간 초과 | 3 | 기존 Handle로 상태 확인 |

`--wait`를 생략한 `run`의 종료 코드 0은 **접수 성공**이다. 판정을 기다리는 builder는 `--wait`를 사용한다. 기본 대기 제한은 600000ms이며 `--timeout-ms`로 조정한다. 대기 시간이 끝나도 브로커의 리뷰는 유지된다.

```sh
ccdd status REVIEW_HANDLE --wait --timeout-ms 600000
```

## 3. 수정 후 새 스냅샷으로 다시 요청하기

Builder는 RED의 근거를 반영해 수정하고, 수정한 내용을 새 커밋으로 고정한 뒤 같은 Critic에 새 요청을 보낸다. 각 시도는 독립된 Handle·worktree·판정으로 남으며 이전 결과를 덮어쓰거나 재사용하지 않는다. 현재 작업 폴더의 미커밋 변경은 리뷰 대상에 포함되지 않는다.

Requester가 builder에게 전달할 지시에는 적어도 다음이 들어가면 된다.

> 맡은 기능을 구현하고 `tests-spec` Critic을 통과하라. 시작 전에 해당 Critic의 doctor 진단을 확인하라. 수정본을 커밋하고 그 전체 커밋 해시로 `ccdd run --commit FULL_COMMIT_HASH --critic tests-spec --wait --json`을 호출하라. RED이면 근거에 따라 수정하고 새 스냅샷으로 재요청하라. ERROR나 대기 시간 초과는 통과로 취급하지 말고 원인을 확인하라. 완료 보고에 통과한 Critic ID, 커밋과 Handle을 남겨라.
