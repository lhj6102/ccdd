# 명시적으로 등록하는 Artifact 도구와 TS 설정 전환 계획

상태: v0.9.0 구현에 반영한 승인 계획. 2026-09-06, PR #9가 병합된 main을 기준으로 작성했다. 확정된 API·제약은 [현행 계약](../contracts.md), 검증 결과는 [v0.9.0 검증 기록](../v0.9.0-validation.md)에 정리한다. 과거 리뷰 snapshot과 판정은 변경하지 않는다.

## 목표와 범위

사용자는 `ccdd.config.ts`에서 도구를 만들어 등록한다. 도구 생성 함수는 메타데이터와 실행 함수를 가진 정의를 반환한다. 등록된 도구가 호출될 때 해당 snapshot의 Artifact를 연결하고 실행한다.

- 기본 도구는 별도 라이브러리에서 import하고 명시적으로 등록한다. 설치·import·도구 생성 자체는 등록이나 관측 실행을 일으키지 않는다.
- 기본 Agent 도구는 구조화된 호출을 CLI에 연결하여 관측 결과를 반환한다. 기본 Human 도구는 데스크톱 프로그램을 열어 사람이 관측하도록 한다.
- CLI 중심은 기본 도구의 권장 구현으로 해석한다. 사용자 도구는 같은 계약으로 함수·SDK 호출·CLI 연결을 선택할 수 있다. 모든 사용자 함수를 CLI로 강제하지 않는 안을 기본 계획으로 둔다.
- 현재 text/files, read/list로 제한된 확장 지점을 해제한다. 사용자 animation/VFX 도구가 새로운 메타데이터·인자·결과를 등록할 수 있어야 한다.
- Broker·Executors 경계, Pi Provider 연결, Artifact DAG, copy/lock, 개별 Critic 선택, Human 알림·claim·판정 제출은 유지한다.
- 첫 기본 도구 범위는 Agent 텍스트 읽기·파일 목록과 Human 파일·폴더 열기다. 특정 애니메이션 엔진용 Viewer 구현은 별도 후속 작업이다. 이미지 결과와 사용자 정의 도구를 통과시키는 공통 계약은 이번 전환에 포함한다.

## 패키지 구성

| 위치 / 패키지 | 책임 |
| --- | --- |
| 기존 root / `@lhj6102/ccdd` | Broker, Artifact Runner, Executors, 모니터, 가벼운 설정·도구 공개 API |
| `packages/default-tools` / `@lhj6102/ccdd-default-tools` | 사용자가 선택할 기본 도구 정의, Agent CLI 구현, Human 데스크톱 실행 구현 |

본체는 기본 도구 라이브러리를 runtime dependency로 가져오거나 재노출해 자동 결합하지 않는다. 기본 도구 라이브러리는 본체의 공개 도구 계약을 type import하고 호환되는 peerDependency를 명시한다. 개발·테스트는 같은 저장소의 workspace로 관리한다. 새 protocol 전용 패키지는 우선 추가하지 않는다.

본체에 `exports`와 타입 선언 진입점을 추가한다. 설정에서 SDK를 import할 때 Broker DB, Provider, 모니터 또는 프로그램 실행이 시작되어서는 안 된다. 두 패키지는 각각 tarball로 설치 검증하며 npm 공개 게시 여부는 이 계획에 포함하지 않는다.

```ts
import { defineConfig } from '@lhj6102/ccdd';
import { agent, human } from '@lhj6102/ccdd-default-tools';
import { sampleFrame } from './tools/animation.js';

export default defineConfig(() => ({
  artifactTypes: {
    markdown: {
      agentTools: { read: agent.text.read() },
      humanTools: { open: human.desktop.open() },
    },
    code: {
      agentTools: {
        list: agent.files.list(),
        read: agent.files.read(),
      },
      humanTools: { open: human.desktop.open() },
    },
    animation: {
      agentTools: { frame: sampleFrame() },
      humanTools: { open: human.desktop.open() },
    },
  },
  // artifacts, critics는 기존 target/deps 구조로 명시한다.
}));
```

`viewer: 'text' | 'files'`는 신규 설정의 필수 필드에서 제거한다. 도구별로 파일·디렉터리 등 지원 입력 조건을 검증한다. `read_spec`, `frame_walk`처럼 공개 이름은 기존의 `<toolName>_<artifactName>` 규칙을 유지한다. 빈 audience 도구 목록은 해당 종류의 Critic에 사용할 수 없다.

## 도구 계약과 저장 계약

도구 정의의 기본 구조는 `{ metadata, execute(context, args) }`다. metadata에는 설명, 실제 입력 스키마, 결과 계약, 관측 방식이 들어간다. 필요하면 실행 준비를 검사하는 선택적 `preflight`를 지원한다. description의 `{artifactName}` 치환도 유지한다.

입력 스키마는 한 곳에서 작성하고 실행 함수의 타입, Agent 도구 명세, Human 입력 폼, 실행 전 검증, `tools check`가 이를 함께 사용한다. TS 타입만으로 런타임 검증을 대신하지 않는다. 지원할 JSON Schema 범위와 미지원 항목의 오류를 명시한다.

실행 context는 연결된 Artifact, snapshot 내 경로, 허용된 내부 경로를 해석하는 수단, 리뷰별 출력·임시 디렉터리, 취소 신호를 제공한다. 도구 호출 오류와 리뷰 요청 상태를 구분한다. Human의 일반적인 앱 실행 실패는 오류를 보여주고 WAITING_HUMAN을 유지하여 재시도할 수 있게 한다. 입력 무결성 훼손이나 Critic 실행을 완료할 수 없는 오류는 요청 ERROR로 처리한다. 도구 결과를 Critic의 GREEN 판정으로 바꾸지 않는다. 외부 앱·명령의 설정은 도구 정의가 소유하고 리뷰어 호출 인자에서는 등록된 입력만 받는다.

함수는 JSON이나 DB에 넣지 않는다. 제출 시 설정을 한 번 평가하고 다음을 분리한다.

1. 저장할 명세: 버전, snapshot, audience·Artifact type·tool key, 설명·스키마·결과 계약, 구현과 실행 의존성의 식별 정보.
2. 실행 레지스트리: 해당 도구 식별자와 실제 함수를 연결한 프로세스 내 값.

Graph와 요청 envelope도 같은 설정 평가 결과에서 생성한다. Worker 및 Human 재개 시 기록된 snapshot의 config와 도구 구현을 다시 불러오고, 저장된 명세·호환 버전과 일치하는지 검사한다. 일치하지 않으면 최신 도구로 대체하지 않고 오류로 알린다. 리뷰 사이에 사용자 closure나 import cache의 변경 가능한 상태를 공유하지 않는다.

설정·기본 도구 버전·사용자 모듈을 snapshot 안에서 해석한다. 원본 repo, 상위 monorepo 또는 전역 설치로 몰래 fallback하지 않는다. 로더·빌드 캐시는 입력 밖에 둔다. 프로젝트 의존성은 실행 전에 실제 설치되어 있어야 하며, 데모도 이를 명시한다. TS 설정은 신뢰된 repo 코드이며 이 구조 자체를 OS 수준 sandbox로 표현하지 않는다.

## Agent와 Human 기본 동작

Agent의 `text.read()`는 패키지에 포함된 읽기 CLI를 감싼 도구다. 실행 파일과 고정 인자는 도구 구현이 결정하고, 검증된 인자와 Artifact 경로를 전달한다. Node 기반 기본 CLI는 실행 중인 Node와 패키지 내 배포 파일을 사용해 전역 명령 설치를 요구하지 않는다. CCDD는 범용 shell 도구를 추가하지 않는다. 기존 Reader의 UTF-8, CRLF, 빈 파일, EOF, 줄 단위 부분 읽기, 응답 제한을 유지한다.

Human의 기본 텍스트 열람은 등록한 데스크톱 앱 또는 OS 연결 프로그램으로 여는 동작이다. 기본 도구에 Agent용 read/list를 복제하지 않는다. 모니터의 버튼은 사람에게 프로그램을 열어주고 실행 결과를 알린다. 프로그램을 연 결과는 열람 완료·판정 완료와 구분한다. 앱을 계속 열어둘 수 있도록 입력 복사본을 유지하며 실행 출력·캐시는 리뷰별 디렉터리에 둔다. 데스크톱 연결은 실행기 호스트에서 수행하고, 처음 실제 검증 대상은 현재 macOS 환경으로 한다. 다른 OS는 어댑터와 검증 여부를 명시한다.

## 결과와 관측의 일반화

ToolResult는 텍스트·구조화 데이터·이미지·프로그램 열기 결과를 구분한다. 이미지가 JSON 문자열로만 전달되지 않도록 Pi와 MCP의 콘텐츠 어댑터를 함께 바꾼다. 모델이 결과 형식을 지원하지 않으면 명확한 오류를 반환한다. 이미지와 생성 파일은 입력 밖의 리뷰 출력 공간에서 검증·조회한다.

필수 관측은 `read_<artifactId>`와 줄 수의 조합에서 분리한다. 등록된 도구의 관측 계약과 검증된 성공 결과에 따라 Runner가 실제 연결된 Artifact의 관측을 기록한다. 목록 조회와 프로그램 열기만으로 내용 관측을 인정하지 않는다. 프레임 추출 도구는 유효한 프레임 결과를 반환했을 때 해당 범위를 기록할 수 있어야 한다. 기존 텍스트 도구는 빈 파일과 EOF의 의미를 유지한다. 기록은 관측 성공의 근거이며 Artifact의 품질 판정은 Critic이 맡는다.

## 모니터와 진단

- 모니터 GET은 저장한 도구 명세로 화면을 만든다. config import·사용자 함수 평가·앱 실행을 하지 않는다. 현재 상세 조회에서 registry를 생성하는 경로도 변경 대상이다.
- Human claim 이후의 명시적 POST에서만 snapshot 구현을 연결하여 도구를 호출한다. 기본 UI는 프로그램 열기 버튼을 중심으로 하고, 사용자 입력은 schema에서 가져온다. boolean·enum·number·배열/객체를 문자열이나 정수로 잘못 변환하지 않는다. 복잡한 입력에는 검증되는 JSON 입력을 제공한다.
- `tools check` 기본 동작은 명세·Artifact 접근·실행 준비 검사다. `--execute`에 Artifact·audience·tool·인자를 명시하면 실제 실행한다. custom preflight가 없으면 등록 확인과 실행 미검증을 구분한다.
- `doctor`는 일반 registry를 사용한다. Provider 왕복 검증은 내부 진단용 nonce 도구로 수행하되 프로젝트에 등록하거나 default-tools를 필수 의존성으로 만들지 않는다. 등록된 프로젝트 도구의 실제 동작 검사는 별도로 표시한다. 기본 검사로 Human 앱을 열지 않는다.

## 구현 순서와 단계별 완료 기준

| 단계 | 주요 변경 | 완료 기준 |
| --- | --- | --- |
| 1. 공개 계약 | `src/contracts.ts`, `src/artifacts/types.ts`, SDK exports, schema/result/관측 계약 | 기본 도구 패키지 없이 사용자 정의 도구 하나를 등록·검증·실행할 수 있음 |
| 2. TS 설정·재현 | config loader, requester, Broker 명세 저장, Worker/Human 재연결 | 함수 없는 저장 명세, 동일 snapshot 재개, 명세 불일치와 의존성 누락 거부 |
| 3. 기본 도구 라이브러리 | `packages/default-tools`, 읽기 CLI·데스크톱 launcher, 개별 패키징 | import·factory 무실행, 명시 등록한 도구만 노출, Agent/Human 기본 동작 구분 |
| 4. 통합 실행 | Artifact Runner, Pi/MCP, 관측 검사, tools check, doctor | 임의 이름·스키마·이미지 결과를 같은 실행 경로에서 처리, read/list 전용 분기 제거 |
| 5. Human 모니터 | 저장 명세 조회, schema 입력, 프로그램 열기 결과, legacy 열람 | GET 무실행, claim 후 도구 호출, 앱 열기와 판정 제출 분리, 재시작 후 재개 |
| 6. 이전·배포 검증 | TS 데모, 사용자 Reader 예시, 문서, 패키지 설치 회귀 | 두 tarball 실제 설치와 copy/lock, 실제 Agent·Human·Runtime 흐름 검증 |

단계 1–3에서 기본 텍스트 Agent와 데스크톱 Human 경로를 연결한 뒤 나머지 어댑터와 이전을 진행한다. 최종 완료는 패키지 분리 자체가 아니라 사용자 정의 도구가 전체 리뷰 흐름에서 동작하는 시점이다.

## 이전 정책

신규 기본 설정과 데모는 TS 및 명시적 import를 사용한다. v0.9에서는 이전을 위해 기존 JSON의 신규 요청도 허용하고, 과거 기록·대기 Human 재개는 legacy adapter로 유지한다. TS의 빈 객체에 JSON 기본값을 적용하지 않는다. 두 설정 파일이 함께 있으면 우선순위를 숨기지 않고 충돌 오류를 낸다.

과거 snapshot·결과를 자동 수정하거나 과거 Human read를 새 desktop open으로 재해석하지 않는다. 기존 passive Artifact 원문 조회와 Human에게 등록한 실행 도구도 구분한다. `AGENTS.md`와 현행 계약의 one npm package 표현은 실제 패키지 분리 구현 시 갱신한다. canonical Why → Spec → Tests → Implementation DAG는 유지한다.

## 검증과 인수 조건

1. 기본 라이브러리가 설치되지 않은 프로젝트에서 사용자 Reader와 비텍스트 도구를 등록할 수 있다. 아무 도구도 등록하지 않으면 해당 audience의 요청은 거부된다.
2. 기본 Agent Reader는 실제 CLI로 기존 줄 읽기 계약을 만족한다. 기본 Human 도구는 snapshot 파일을 실제 데스크톱 프로그램으로 열고 텍스트 반환 도구로 대체하지 않는다.
3. 텍스트를 가정하지 않는 custom 도구의 스키마 검증, 이미지 결과 전달, 관측 기록을 확인한다. 임의 도구 이름, 잘못된 인자, 잘못된 결과, 이미지 미지원 모델도 검증한다.
4. 실행 중 취소·시간 제한·하위 프로세스 정리, Artifact 내부 경로 제한, copy/lock 무결성과 출력 분리가 유지된다.
5. 모니터의 반복 GET에서 사용자 코드·CLI·앱이 실행되지 않는다. claim·CSRF·판정 제출과 Human 대기의 영속성이 유지된다.
6. 두 패키지를 각각 pack하여 개발 의존성 없는 새 프로젝트에 설치한다. snapshot 복사 뒤 원본을 사용할 수 없는 상태에서도 같은 도구와 버전으로 실행·Human 재개가 된다. 별도 프로젝트 사이에서 함수 상태가 섞이지 않는다.
7. `doctor`의 실제 Provider 진단과 `tools check`의 실행 여부를 구분한다. 실제 Agent 결과와 Runtime 테스트, 실제 Human 앱 실행을 확인하며 판정을 고정하지 않는다.

구현 결정: Node 24의 native TypeScript와 별도 프로세스를 사용하며 snapshot 내부 import만 해석한다. metadata·관측 결과·JSON Schema 지원 범위는 현행 계약과 테스트에 명시한다. 신규 JSON 요청은 v0.9의 전환 호환 경로로 유지하며 제거 시점은 별도 버전에서 결정한다.
