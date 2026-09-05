# 패키지 설치 검증

2026-09-05, Node 24.19.0과 npm 10.1.0에서 확인했다.

- `npm pack`으로 만든 tarball을 별도 임시 폴더에 `npm install <tarball> --omit=dev --ignore-scripts`로 설치했다. 런타임 패키지 3개가 설치됐다.
- 설치된 `ccdd help`와 `ccdd prepare-demo`가 정상 실행됐다.
- 설치본에 `public/index.html`, `public/app.js`, `public/styles.css`와 `scripts/prepare-demo.mjs`가 포함됐다.
- 설치된 Codex는 상위 `node_modules/@openai/codex/bin/codex.js`에서 해석됐으며, 실행 가능하고 버전은 `codex-cli 0.153.4`였다.
- 생성 상태, 작업 트리, 인증 정보와 녹화 출력은 패키지에 포함되지 않았다.
- npm에 게시하지 않았다. 이 검증에서는 실제 Agent 리뷰를 다시 요청하지 않았다.

## 스냅샷 재현성

설치된 CLI가 만든 데모 저장소와 별도 경로에 새로 생성한 데모 저장소의 네 커밋이 모두 같았다. 커밋 날짜, 작성자, SHA-1 형식과 서명 비활성화를 데모 생성기가 고정한다.

| 시나리오 | 커밋 |
| --- | --- |
| baseline | `530b86d335b4191900ea14e032b96d27a2d33a2e` |
| why-change | `9491804ac8f626a7137857b6e8376aa32130b2cc` |
| runtime-failure | `1764e57283520658a468dcf98c8df3f18746e360` |
| fixed | `b2dc464e26af160ffbef2b721336036f3a387884` |

이 해시는 이 데모의 Artifact와 Critic 정의에 대응한다. 해당 내용을 바꾸면 새 해시가 생성된다.
