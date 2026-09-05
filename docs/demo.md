# CCDD v0.4 CLI 시연

Node 24 이상과 요청 모델을 사용할 수 있는 Codex 로그인을 준비합니다. 서버와 브라우저는 사용하지 않습니다.

```sh
node src/cli.mjs prepare-demo
node src/cli.mjs doctor --demo --scenario fixed --json
```

데모 폴더는 기본적으로 `~/.local/share/ccdd/demo-v4`에 만들어집니다. `--demo-dir PATH`로 지정할 수도 있습니다. 네 시나리오는 Git 없는 별도 폴더이며 현재 파일을 직접 수정할 수 있습니다.

| 시나리오 | Why / Spec / Tests / Implementation의 최대 개수 | 확인 |
| --- | --- | --- |
| baseline | 3 / 3 / 3 / 3 | 전체 정합성 |
| why-change | 2 / 3 / 3 / 3 | Spec↔Why 불일치 |
| runtime-failure | 2 / 2 / 2 / 3 | 실제 런타임 테스트 실패 |
| fixed | 2 / 2 / 2 / 2 | 수정 후 전체 재평가 |

```sh
node src/cli.mjs run --demo --scenario why-change --lock --critic spec-why --wait
node src/cli.mjs run --demo --scenario runtime-failure --copy --critic implementation-tests --wait
node src/cli.mjs run --demo --scenario fixed --copy --wait
```

Agent 판정은 실제 Provider 응답이며 표의 기대 결과를 하드코딩하지 않습니다. Runtime은 실제 Node 테스트를 실행합니다. `--critic` 단독 판정과 전체 체인 판정을 구분합니다.

같은 fixed 폴더에 두 번 `run --copy`를 요청하면 서로 다른 Handle이 같은 `workspace.path`와 `snapshotHash`를 사용할 수 있습니다. 각 리뷰는 독립된 결과와 출력 디렉터리를 갖습니다.

```sh
node src/cli.mjs list --demo --scenario fixed
node src/cli.mjs status RUN_ID --demo --scenario fixed
```

`--lock` 도중 원본을 수정하면 입력 변경 ERROR가 됩니다. `--copy`가 준비된 뒤 원본을 수정해도 진행 중인 리뷰는 복사된 내용으로 계속 실행됩니다. 관찰 서버는 향후 추가 가능한 기능으로만 남깁니다.

Artifact 도구의 이름은 `read_spec`, `list_tests`, `read_tests`입니다. 데모의 markdown/code 타입에 동작별 설명 템플릿이 들어 있으며 `{artifactName}`이 실제 ID로 치환됩니다. 예를 들어 `read_tests({path: "rank.test.mjs", startLine: 1, lineCount: 80})`으로 테스트 파일을 줄 단위로 읽습니다.
