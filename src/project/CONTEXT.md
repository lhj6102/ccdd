# Project Validation

프로젝트 검증은 현재 입력에 어떤 과거 판정을 적용할 수 있으며 어떤 검증이 더 필요한지를 판단하는 맥락이다. CCDD의 Artifact·Critic 정의와 실제 리뷰를 수행하는 맥락을 연결한다.

## Language

**Artifact Identity**:
서로 다른 관측 시점의 Artifact를 같은 검토 입력으로 취급할 수 있다는 관계. 그 Artifact에 대한 평가가 새로 이루어졌다는 사실만으로 동일성이 바뀌지는 않는다.
_Avoid_: 검토 완료, 판정의 동일성

**Validation Input**:
한 Critic의 평가 조건, 대상 Artifact와 직접 참조하는 Dependency Artifact들로 정해지는 검토 입력. Dependency Artifact의 평가 이력 자체는 그 Artifact의 내용과 구분한다.
_Avoid_: 프로젝트 전체의 영구 상태, 선행 리뷰의 실행 기록

**Validation Evidence**:
실제로 수행한 검토의 판정과 근거, 그리고 그 판정이 적용되는 검토 입력의 기록.
_Avoid_: 추정한 PASS, 현재 입력에 대한 무조건적인 보증

**Reusable Verdict**:
현재 검토 입력과의 동일성이 확인되어 다시 적용할 수 있는 실제 과거 판정. 새로운 검토를 수행했다는 뜻은 아니다.
_Avoid_: 새 판정, 자동 생성한 PASS

**Stale Validation**:
현재 입력 또는 선행 검증 조건 때문에 기존의 검증 성공을 현재에 적용할 수 없다는 판단.
_Avoid_: Artifact의 영구 속성, 다른 Artifact에 전달하는 변경 명령

**Validation Query**:
현재 입력과 검증 근거를 대조하고 필요한 선행 Artifact의 검증 충족 여부를 재귀적으로 확인하는 질의. 질의 자체는 새로운 검토나 판정을 만들지 않는다.
_Avoid_: 검증 실행 요청, 저장된 stale 표시 조회

**Individual Validation**:
선택한 Artifact 또는 Critic의 검증을 의뢰하되 선행 Artifact의 검증을 자동으로 포함하지 않는 범위. 실행 가능한 Critic은 진행하며, 선행 조건이 충족되지 않은 Critic은 미완료로 보고한다.
_Avoid_: 선행 조건 우회, 프로젝트 전체 검증

**Recursive Validation**:
선택한 검증의 충족에 필요한 선행 Artifact의 검증까지 포함하는 의뢰 범위. 이미 적용 가능한 판정의 재사용 여부는 각 검토 입력에 따라 판단한다.
_Avoid_: 하위 Artifact 전체 재실행, 모든 선행 검증의 강제 재실행
