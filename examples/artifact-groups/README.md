# 이미지 기본 도구와 Artifact 그룹

`effect` 문서와 `preview` 이미지는 독립 Artifact입니다. `explosion`은 두 ID를 참조하는 그룹이며 경로와 타입이 없습니다. 문서·이미지의 개별 도구를 명시적으로 등록합니다. 이 예제는 실제 VFX 파일이 아닌 정적 샘플입니다.

- `preview-review`: 이미지 하나를 평가합니다. `view_image_preview`만 제공됩니다.
- `explosion-review`: 그룹을 평가합니다. `read_effect`와 `view_image_preview`가 제공됩니다. `preview`가 그룹 멤버이면서 `deps`여도 도구는 중복되지 않습니다.
- `explosion-human`: 그룹의 문서·이미지를 각각 데스크톱 앱에서 연 뒤 판정을 제출합니다.

전체 Run에서 두 그룹 Critic은 명시적인 `deps: ['preview']` 때문에 이미지 평가가 통과해야 시작합니다. 그룹에 속해 있다는 것만으로 선행 평가가 필요해지지는 않습니다. 그룹의 두 Critic이 모두 GREEN이면 `explosion`이 GREEN이며 `effect`는 미평가로 남습니다.

## 실행

이 기능을 포함한 소스 빌드의 두 tarball을 사용합니다. 이미 배포된 v1.0.0 tarball에는 이 새 기능이 없습니다. 소스 저장소에서 실행하고 예제는 저장소 밖으로 복사합니다.

```sh
npm run build
# 출력 디렉터리는 새 임시 경로입니다.
CCDD_EXAMPLE_ROOT=$(mktemp -d /tmp/ccdd-groups.XXXXXX)
mkdir "$CCDD_EXAMPLE_ROOT/packages"
npm pack --ignore-scripts --pack-destination "$CCDD_EXAMPLE_ROOT/packages"
npm pack --ignore-scripts --workspace @lhj6102/ccdd-default-tools --pack-destination "$CCDD_EXAMPLE_ROOT/packages"
cp -R examples/artifact-groups "$CCDD_EXAMPLE_ROOT/project"
cd "$CCDD_EXAMPLE_ROOT/project"
npm init -y
npm pkg set type=module
npm install --ignore-scripts "$CCDD_EXAMPLE_ROOT"/packages/*.tgz

# Provider 호출 없이 그룹 구성원의 도구 준비 상태를 확인합니다.
npx ccdd tools check --artifact explosion --for agent
# 실제 이미지 읽기는 개별 Artifact를 지정합니다.
npx ccdd tools check --artifact preview --for agent --tool view_image --execute

# 한 Critic만 검토: 이 경우 선행 판정 대기는 생략됩니다.
npx ccdd run --copy --critic explosion-review --codex-auth-file "$HOME/.codex/auth.json" --wait
```

실제 Agent 리뷰에는 이미지 입력을 지원하는 모델의 인증·접근 권한이 필요합니다. 다른 인증 방식은 본체 README를 참고하세요. 도구 검사는 모델을 호출하지 않습니다. 위 명령의 `--execute` 결과에는 실제 이미지의 base64 블록이 포함됩니다.

전체 Run과 Human 검토는 로컬 알림을 등록하여 시작합니다.

```sh
npx ccdd run --copy --human-inbox --codex-auth-file "$HOME/.codex/auth.json"
npx ccdd monitor
```

모니터에서 프로젝트·Run을 선택하고 Graph의 그룹 노드를 누르면 구성원을 확인할 수 있습니다. Human 요청을 맡은 다음 `{explosion}` 버튼을 눌러 각 멤버의 `open` 도구를 실행하고 판정과 근거를 제출합니다. 기본 데스크톱 열기는 macOS용이며 다른 운영체제에서는 명시적인 실행 프로그램을 등록합니다.

`view_image`는 Pi `read`의 이미지 결과를 재사용합니다. PNG/JPEG/WebP를 파일 내용으로 판별하며 최대 4MiB입니다. GIF/BMP/animated PNG, 텍스트 결과는 실패하며 자동 변환이나 축소는 하지 않습니다. 디렉터리 Artifact에 등록한 경우에는 `{"path":"frames/preview.png"}`처럼 내부 경로를 전달합니다.
