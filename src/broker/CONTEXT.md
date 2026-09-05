# Broker

브로커는 Requester의 리뷰 요청과 리뷰어의 판정을 연결하는 맥락이다. 어떤 스냅샷을 누가 평가하고 있으며, 어떤 결과를 요청자에게 돌려줄 수 있는지가 이 맥락의 언어다.

## Language

**Requester**:
리뷰를 요청하고 그 요청의 진행 상태와 결과를 받는 주체.
_Avoid_: Reviewer, 실행기

**Run**:
하나의 스냅샷에 대해 의존 순서대로 진행되는 리뷰 요청들의 묶음.
_Avoid_: Task, 프로젝트

**Review Request**:
평가 대상 Artifact, 평가 기준, 스냅샷과 실행 조건이 정해진 한 번의 리뷰 의뢰.
_Avoid_: Critic 정의, 작업 목록

**Snapshot**:
리뷰의 Artifact와 Critic 정의를 함께 고정한 저장소의 특정 시점.
_Avoid_: 현재 작업 폴더, 최신 소스

**Predecessor**:
현재 리뷰가 시작되기 전에 GREEN 판정을 받아야 하는 바로 앞 리뷰 요청.
_Avoid_: 공동 평가 기준, 병합 조건

**Verdict**:
리뷰어가 평가 기준의 충족 여부에 대해 내린 GREEN 또는 RED 판정.
_Avoid_: 실행 오류, 진행 상태

**Blocked Review**:
앞선 리뷰의 GREEN 판정이 없어 아직 시작할 수 없는 리뷰 요청.
_Avoid_: 실패한 리뷰, RED 판정

**Human Claim**:
사람 리뷰어 한 명이 대기 중인 리뷰의 결과 제출을 맡았다는 약속.
_Avoid_: 완료, 판정
