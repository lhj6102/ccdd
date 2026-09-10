# Broker

The Broker connects a Requester's review requests with reviewers' verdicts. Its language describes who is evaluating which snapshot and which results can be returned to the requester.

## Language

**Requester**:
The party that requests a review and receives its progress and result.
_Avoid_: Reviewer, Executor

**Run**:
A collection of review requests for one snapshot and a defined evaluation scope.
_Avoid_: Task, project

**Critic Run**:
A Run that evaluates only one selected Critic. GREEN means that Critic is satisfied, not that referenced Artifacts or other Critics are satisfied.
_Avoid_: Graph Run, complete validation

**Graph Run**:
A Run that evaluates all defined Critics according to Artifact dependencies. Complete validation is satisfied when every required review is GREEN.
_Avoid_: Critic Run, individual evaluation

**Review Request**:
One review assignment with defined target Artifacts, evaluation criteria, snapshot, and execution conditions.
_Avoid_: Critic definition, task list

**Snapshot**:
The complete input state, including the review's Artifact and Critic definitions. It is identified by a content hash and must remain unchanged during review.
_Avoid_: Git commit, latest source

**Artifact Group**:
A review unit that references independently defined Artifacts. Member identifiers remain independent of group membership and can be referenced individually.
_Avoid_: Artifact copy, directory, predecessor Critic list

**Group Membership**:
The relationship of an Artifact belonging to a group. Group composition is distinct from validation dependencies; membership alone does not require prior validation.
_Avoid_: Dependency Artifact, validation order, automatic verdict propagation

**Target Artifact**:
The Artifact judged by one Critic. Multiple Critics may evaluate the same Artifact against different criteria.
_Avoid_: referenced Artifact, generated output

**Dependency Artifact**:
Another Artifact that a Critic references as the basis for judging its target. In a full validation, this Artifact's required evaluations must pass before the Critic can start.
_Avoid_: predecessor Critic, target Artifact

**Basis Artifact**:
An explicitly accepted starting point for validation that requires no separate Critic verdict.
_Avoid_: automatic pass, completed review

**Artifact Validation**:
The aggregate status of all required Critics targeting one Artifact within the same snapshot and evaluation scope. One successful verdict or an unexecuted review does not establish a complete pass.
_Avoid_: permanent file state, single Critic verdict

**Verdict**:
A reviewer's GREEN or RED judgment of whether the evaluation criteria are satisfied.
_Avoid_: execution error, progress status

**Blocked Review**:
A review request that cannot start yet because required reviews of referenced Artifacts are not satisfied.
_Avoid_: failed review, RED verdict

**Human Claim**:
A commitment by one human reviewer to submit the result of a waiting review.
_Avoid_: completion, verdict

**Review Workspace**:
The complete workspace from which a review reads input. It either monitors the original for changes or uses an immutable copy.
_Avoid_: Artifact observation scope, review output workspace

**Copied Workspace**:
Immutable review input captured from the original. Reviews of identical content can share it.
_Avoid_: verdict cache, Builder workspace
