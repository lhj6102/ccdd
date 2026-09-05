# Builder가 특정 Critic을 통과할 때까지 수정하기

Builder 생성과 수정 반복은 Requester가 맡습니다. CCDD는 선택한 Critic을 실행하고 판정과 근거를 돌려줍니다.

```sh
ccdd doctor --repo /path/to/repo --critic tests-spec --json
ccdd run --repo /path/to/repo --copy --critic tests-spec --wait --json
```

1. 현재 작업 폴더를 수정합니다. commit은 필요하지 않습니다.
2. `--copy`로 리뷰를 요청합니다. 복사 완료 후 원본을 수정할 수 있지만, 결과는 요청 당시 hash에 대한 판정입니다.
3. GREEN이면 선택한 기준을 통과한 것입니다. RED이면 `requests[0].result.evidence`를 읽고 수정한 뒤 새 Run을 만듭니다.
4. ERROR는 설정·연결·입력 변경·실행 실패를 해결합니다. 대기 시간 초과는 실패 판정이 아니므로 기존 Handle을 조회합니다.

```sh
ccdd status RUN_ID --repo /path/to/repo --wait --timeout-ms 600000
ccdd cancel RUN_ID --repo /path/to/repo
```

`--wait`: 0=GREEN, 1=RED, 2=ERROR, 3=대기 시간 초과. `--wait` 없는 `run`의 0은 접수 성공이며 독립 worker가 계속 실행합니다. `status` 조회를 위해 서버를 켤 필요가 없습니다.

복사 비용을 피하고 전체 작업 폴더의 수정을 멈출 수 있다면 `--lock`을 선택합니다. 리뷰 완료까지 에디터·builder·다른 프로세스가 입력을 변경하면 안 됩니다. 출력·임시 파일은 `CCDD_OUTPUT_DIR`와 `CCDD_TMP_DIR`에 기록합니다.

Builder에게 전달할 지시 예:

> 기능을 구현하고 `tests-spec` Critic을 통과하라. doctor로 해당 Critic의 실제 실행 준비를 확인하라. 수정한 현재 workspace에 `ccdd run --copy --critic tests-spec --wait --json`을 실행하라. RED이면 근거를 반영해 수정하고 새로 요청하라. ERROR와 대기 시간 초과를 통과로 취급하지 마라. 완료 보고에는 Critic ID, 입력 hash, Handle을 남겨라.
