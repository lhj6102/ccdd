# Project Validation

Project Validation determines which past verdicts apply to current input and which further validations are needed. It connects CCDD's Artifact and Critic definitions to the contexts that perform actual reviews.

## Language

**Artifact Identity**:
The relationship that allows an Artifact observed at different times to be treated as the same review input. Performing another review of the Artifact does not by itself change its identity.
_Avoid_: review completion, verdict identity

**Validation Input**:
The review input defined by a Critic's evaluation conditions, target Artifact, and directly referenced Dependency Artifacts. A Dependency Artifact's review history is distinct from its content.
_Avoid_: permanent project-wide state, predecessor review execution records

**Validation Evidence**:
A record of an actual review's verdict and evidence, together with the review input to which that verdict applies.
_Avoid_: inferred PASS, unconditional guarantee for current input

**Reusable Verdict**:
An actual past verdict that can be applied again because its review input has been confirmed to match the current input. It does not mean a new review was performed.
_Avoid_: new verdict, automatically generated PASS

**Stale Validation**:
A determination that an earlier successful validation cannot apply now because of the current input or prerequisite validation conditions.
_Avoid_: permanent Artifact property, change command propagated to another Artifact

**Validation Query**:
A query that compares current input with validation evidence and recursively checks whether required predecessor Artifacts satisfy their validation requirements. The query itself creates no new review or verdict.
_Avoid_: validation execution request, lookup of stored stale flags

**Individual Validation**:
A request scope covering a selected Artifact or Critic without automatically including validation of predecessor Artifacts. Ready Critics proceed; Critics with unmet prerequisites are reported as incomplete.
_Avoid_: prerequisite bypass, whole-project validation

**Recursive Validation**:
A request scope that includes validation of the predecessor Artifacts needed to satisfy the selected validation. Reuse of an applicable verdict is decided from each review's input.
_Avoid_: rerunning every downstream Artifact, forcing every predecessor validation to rerun
