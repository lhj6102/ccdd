# Executors

Executors perform the actual reviews assigned by the Broker. They provide verdicts and evidence; the Broker manages request assignment and progress.

## Language

**Executor**:
The party that performs an evaluation under a review request's execution conditions. Runtime Critics, Agent Critics, and Human Critics use different execution methods.
_Avoid_: Broker, state manager

**Runtime Critic**:
An Executor that runs an evaluation procedure, such as test code, and returns its result as a verdict.
_Avoid_: Agent, implementation generator

**Agent Critic**:
An Executor that performs an Agent review using the Provider, model, and other conditions specified in the request.
_Avoid_: default AI, arbitrary model

**Provider**:
The external provider connected to run inference for the model requested by an Agent Critic.
_Avoid_: review Executor, Human Reviewer

**Human Critic**:
An execution method in which a person observes the input and submits a verdict.
_Avoid_: Agent session, automatic approval

**Human Reviewer**:
A person who receives a review request through a notification and submits a verdict and evidence for the request they have claimed.
_Avoid_: automatic approval, Agent verdict on a person's behalf

**Alarm Method**:
An explicitly registered delivery method for notifying a Human Reviewer of a waiting review. Human reviews require at least one.
_Avoid_: queue without registration

**Artifact Runner**:
The boundary connecting Artifacts referenced by a review payload and their types to Viewer entry points capable of observing those Artifacts.
_Avoid_: test Executor, Artifact generator

**Viewer Entry Point**:
An entry point providing one observation operation for an Artifact in a specific snapshot. Descriptions defined by the Artifact type explain its observation scope and operation to the reviewer.
_Avoid_: prompt preloaded with entire files, whole-Repo access

**Instruction Artifact Reference**:
A reference in review instructions to a specific Artifact supplied to the request and the observation tools available to that reviewer. It is meaningful within the observation scope defined by targets and dependencies; it is not itself an observation or verdict.
_Avoid_: Artifact body interpolation, access grant, tool execution

**Artifact Tool Definition**:
A definition of an observation operation that an Artifact type offers to a reviewer. It includes a description, accepted input, and behavior; preparing a definition is separate from actually observing an Artifact.
_Avoid_: tool call result, Critic verdict

**Default Artifact Tools**:
Observation tools supplied by CCDD for users to select and register in their projects. Merely having the library available does not give reviewers observation capabilities.
_Avoid_: automatically registered tools, mandatory Viewer

**Agent Tool**:
An observation operation that an Artifact type permits an Agent reviewer to use. The operation is bound to a specific Artifact supplied to the request.
_Avoid_: Human Tool, general-purpose Agent tool

**Human Tool**:
A viewing capability that an Artifact type provides to a human reviewer. Opening a viewer does not mean the person has completed a review or verdict.
_Avoid_: automatic verdict, Human Claim

**Tool Readiness**:
A check of whether the specified reviewer is ready to use an Artifact's registered tools. Confirming actual tool execution and judging Artifact quality are different outcomes.
_Avoid_: Verdict, review pass

**Review Result**:
A reviewer's GREEN or RED judgment of the observed Artifact, together with supporting evidence. Execution failure is not a verdict.
_Avoid_: successful execution, assumed pass

**Readiness Diagnostic**:
An observation of whether a review can start now under the requested execution conditions. It is not a quality verdict about an Artifact or a guarantee of later execution success.
_Avoid_: Critic pass, Health response, permanent authentication guarantee
