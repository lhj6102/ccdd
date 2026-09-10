# 사용자 정의 Reader

기본 도구 라이브러리 없이 `{ metadata, execute }`를 직접 등록하는 예제입니다. `customTextReader()`는 정의를 만들고, 실제 파일 읽기는 Agent가 `read_spec`·`read_why`를 호출할 때 수행합니다.

각 프로젝트가 자신의 의존성을 포함해야 하므로 이 폴더를 저장소 밖의 새 프로젝트로 복사한 뒤, [Release](https://github.com/lhj6102/ccdd/releases)의 core와 Project tarball을 설치합니다. 예제는 소스 저장소와 core 패키지의 `examples/custom-text-reader`에 포함됩니다. 상위 저장소에 설치된 CCDD를 그대로 참조하지 않습니다.

```sh
# CCDD 소스 저장소에서 예제를 복사합니다.
cp -R examples/custom-text-reader /tmp/ccdd-custom-reader
cd /tmp/ccdd-custom-reader
npm init -y
npm pkg set type=module
mkdir -p vendor/ccdd
gh release download v2.0.0 --repo lhj6102/ccdd --dir vendor/ccdd \
  --pattern '*.tgz' --pattern SHA256SUMS --pattern verification.json
(cd vendor/ccdd && shasum -a 256 -c SHA256SUMS)
npm install --ignore-scripts \
  ./vendor/ccdd/ccdd-core-2.0.0.tgz \
  ./vendor/ccdd/ccdd-project-2.0.0.tgz
npx ccdd tools check --artifact spec --for agent --tool read
npx ccdd tools check --artifact spec --for agent --tool read --execute --args '{"startLine":1,"lineCount":20}'
npx ccdd run --copy --critic spec-why --codex-auth-file "$HOME/.codex/auth.json" --wait
```

다운로드에는 저장소 접근 권한이 있는 GitHub CLI 로그인이 필요합니다. 이 예제는 core와 Project를 설치하며 기본 도구 라이브러리는 사용하지 않습니다. 소스 저장소에서 `npm run release -- --commit <40자리 SHA> --dry-run`으로 검증·생성한 같은 버전의 core·Project tarball로도 설치할 수 있습니다. 이 로컬 검증에는 GitHub 인증이 필요하지 않습니다. 이미 CCDD를 설치했다면 첫 `cp`의 원본을 `node_modules/@ccdd/core/examples/custom-text-reader`로 바꿉니다.

도구의 `preflight`는 생략했습니다. 기본 검사는 등록 확인과 실제 실행 미검증을 구분하며, `--execute`는 파일을 실제로 읽습니다. Agent 리뷰에는 유효한 Provider 인증이 필요합니다.

이 Reader는 구조를 보여주기 위한 작은 구현입니다. 파일을 메모리로 읽은 뒤 1MiB 이하인지 확인하며, 반환 텍스트는 64KiB로 제한합니다. 큰 파일은 스트리밍 리더가 적합합니다. UTF-8·CRLF와 마지막 줄바꿈을 보존하고, 빈 파일과 EOF 이후 읽기를 구분합니다. 실제 내용이나 빈 파일을 관측했을 때만 관측 receipt를 반환합니다.

Human 도구를 Agent Reader로 복제하지 않았습니다. 이 타입에는 Human 도구가 없으므로 Human Critic에 사용할 수 없습니다. 사람의 열람을 추가하려면 데스크톱 프로그램을 여는 사용자 도구를 작성하거나 `@ccdd/default-tools`의 `human.desktop.open()`을 명시적으로 등록합니다.
