import type { DatabaseSync } from 'node:sqlite';
import type { ReviewEnvelope, ReviewRequest, ReviewStatus, RunStatus } from '../contracts.js';
import type { RunRecord } from './index.js';
import { randomUUID } from 'node:crypto';
import { criticGates } from '../project/gates.js';
import { planProject } from '../project/query.js';
import { readEvidence } from '../project/store.js';
import { records } from './storage.js';
import { findCoalescibleRequest, coalescingEligibility } from './coalescing.js';
import type { ValidationInput } from '../project/types.js';

export const readinessTestHooks: { member?: () => void; status?: () => void } = {};
const terminal = new Set(['GREEN','RED','ERROR','INCOMPLETE']);
const blocked = (state: string) => state === 'RED' || state === 'BLOCKED';
const bucket = (state: string) => ({ QUEUED: 'queued', RUNNING: 'running', WAITING_HUMAN: 'waiting', ERROR: 'errors', RED: 'red', MISSING: 'missing', BLOCKED: 'missing', WAIT_DEPENDENCY: 'missing' }[state]);
type Member = { run_id: string; critic_id: string; ordinal: number; target: string; input_key: string; input_ref: string; envelope_ref: string | null; request_id: string | null; evidence_id: string | null; state: string; included: number };
export function createReadiness(db: DatabaseSync, store: ReturnType<typeof records>, options: { reconcile: (id: string) => void; deadlines: Map<string, number> }, event: (runId: string, requestId: string | null, type: string, message: string, data?: unknown) => void) {
  const header = (id: string) => { const row = db.prepare('SELECT data FROM runs WHERE id=?').get(id); return row ? JSON.parse(String(row.data)) : null; };
  const changeCount = (runId: string, state: string, delta: number) => { const key = bucket(state); if (key) db.prepare(`UPDATE run_counts SET ${key}=${key}+? WHERE run_id=?`).run(delta, runId); };
  const updateRun = (id: string) => {
    readinessTestHooks.status?.();
    const run = header(id); if (!run || terminal.has(run.status)) return;
    const counts = db.prepare('SELECT * FROM run_counts WHERE run_id=?').get(id)!;
    const status: RunStatus = Number(counts.running) ? 'RUNNING' : Number(counts.queued) ? 'QUEUED' : Number(counts.waiting) ? 'WAITING_HUMAN' : Number(counts.errors) ? 'ERROR' : Number(counts.red) ? 'RED' : Number(counts.missing) ? 'INCOMPLETE' : 'GREEN';
    if (run.status === status) return;
    run.status = status; if (terminal.has(status)) options.deadlines.delete(id); if (terminal.has(status)) run.completedAt = new Date().toISOString();
    db.prepare('UPDATE runs SET status=?,data=? WHERE id=?').run(status, JSON.stringify(run), id);
    event(id, null, 'run.status', `Run ${status}`, { status });
  };
  const publish = (member: Member, request: Record<string, any>) => {
    db.prepare('INSERT INTO request_changes(run_id,request_id,critic_id,status,result_ref,error,error_code) VALUES (?,?,?,?,?,?,?)').run(member.run_id, request.id, member.critic_id, request.status, request.semanticRef ?? null, request.error ?? null, request.errorCode ?? null);
  };
  const effectiveState = (member: Member, request: Record<string, any>) => {
    const gate = db.prepare('SELECT unmet,red FROM gate_counts WHERE run_id=? AND critic_id=?').get(member.run_id,member.critic_id);
    return request.runId !== member.run_id && Number(gate?.unmet ?? 0) ? Number(gate?.red ?? 0) ? 'BLOCKED' : 'WAIT_DEPENDENCY' : request.status;
  };
  const setMember = (member: Member, request: Record<string, any>) => {
    readinessTestHooks.member?.();
    const status = effectiveState(member, request);
    changeCount(member.run_id, member.state, -1); changeCount(member.run_id, status, 1);
    db.prepare('UPDATE run_members SET state=?,request_id=?,evidence_id=? WHERE run_id=? AND critic_id=?').run(status, request.id, request.status === 'GREEN' || request.status === 'RED' ? request.id : null, member.run_id, member.critic_id);
    if (request.runId !== member.run_id && !terminal.has(request.status)) db.prepare('INSERT OR REPLACE INTO shared_members VALUES (?,?,?,?)').run(member.run_id,member.critic_id,request.id,request.runId);
    else db.prepare('DELETE FROM shared_members WHERE run_id=? AND critic_id=?').run(member.run_id,member.critic_id);
    publish(member, { ...request, status, semanticRef: status === request.status ? request.semanticRef : null });
    return status;
  };
  let preparedTemplates: Map<string, ReviewEnvelope> | undefined;
  let preparedWorkspace: ReviewRequest['workspace'] | undefined;
  const createRequest = (member: Member): Record<string, any> => {
    const run = header(member.run_id); if (!run || !member.envelope_ref) throw new Error('Missing prepared request.');
    // Submission supplies the scalar header once; lease-expiry fallback resolves
    // only this one scoped envelope, never a whole Run.
    const envelope = preparedTemplates?.get(member.critic_id) ?? store.get<ReviewEnvelope>(member.envelope_ref);
    const gate = db.prepare('SELECT unmet,red FROM gate_counts WHERE run_id=? AND critic_id=?').get(member.run_id, member.critic_id);
    const gated = Number(gate?.unmet ?? 0) > 0;
    const workspace = preparedWorkspace ?? store.get<ReviewRequest['workspace']>(run.workspaceRef);
    const packed = { id: randomUUID(), runId: member.run_id, worktreePath: workspace.path,
      criticId: member.critic_id, target: member.target, title: envelope.title, snapshotHash: envelope.snapshotHash, deps: envelope.deps,
      profile: { kind: envelope.profile.kind, ...(envelope.profile.kind === 'agent' ? { provider: envelope.profile.provider, model: envelope.profile.model } : {}) },
      envelopeRef: member.envelope_ref, workspaceRef: run.workspaceRef, inputRef: member.input_ref, inputKey: member.input_key, inputVersion: 3,
      status: gated ? Number(gate?.red) ? 'BLOCKED' : 'WAIT_DEPENDENCY' : 'QUEUED', createdAt: new Date().toISOString(), startedAt: null, completedAt: null, claimedBy: null, claimedAt: null, notifiedAt: null,
      resultRef: null, semanticRef: null, error: null, blockedReason: gated ? `${Number(gate?.red) ? 'BLOCKED' : 'WAIT_DEPENDENCY'}: ${db.prepare("SELECT e.dependency,m.state FROM gate_edges e JOIN run_members m ON m.run_id=e.run_id AND m.critic_id=e.dependency WHERE e.run_id=? AND e.dependent=? AND m.state!='GREEN' LIMIT 16").all(member.run_id,member.critic_id).map(row=>`${row.dependency} (${row.state})`).join(', ')}` : null };
    db.prepare('INSERT INTO requests(id,run_id,ordinal,status,data) VALUES (?,?,?,?,?)').run(packed.id, member.run_id, member.ordinal, packed.status, JSON.stringify(packed));
    event(member.run_id, packed.id, 'request.queued', 'Fixed-input Critic is ready for execution.');
    return packed;
  };
  const adoptOrCreate = (member: Member) => {
    const run = header(member.run_id);
    const gate = db.prepare('SELECT unmet FROM gate_counts WHERE run_id=? AND critic_id=?').get(member.run_id, member.critic_id);
    const source = !run.project.force ? findCoalescibleRequest(db, member.critic_id, member.input_key, { ...options, ignoreGates: run.project.ignoreGates })?.request : null;
    const request = source ? JSON.parse(String(db.prepare('SELECT data FROM requests WHERE id=?').get(source.id)!.data)) : createRequest(member);
    setMember(member, request);
    if (source) event(member.run_id, source.id, 'request.coalesced', 'Waiting for an identical active review.', { sourceRunId: source.runId });
  };
  const gateMember = (member: Member, state: string) => {
    changeCount(member.run_id, member.state, -1); changeCount(member.run_id, state, 1);
    db.prepare('UPDATE run_members SET state=? WHERE run_id=? AND critic_id=?').run(state, member.run_id, member.critic_id);
    if (member.request_id) {
      const row = db.prepare('SELECT data,run_id FROM requests WHERE id=?').get(member.request_id);
      if (row && row.run_id === member.run_id) {
        const request = JSON.parse(String(row.data)); request.status = state;
        const blockers = db.prepare("SELECT e.dependency,m.state FROM gate_edges e JOIN run_members m ON m.run_id=e.run_id AND m.critic_id=e.dependency WHERE e.run_id=? AND e.dependent=? AND m.state!='GREEN' LIMIT 16").all(member.run_id, member.critic_id);
        request.blockedReason = state === 'QUEUED' ? null : `${state}: ${blockers.map(row => `${row.dependency} (${row.state})`).join(', ')}`;
        db.prepare('UPDATE requests SET status=?,data=? WHERE id=?').run(state, JSON.stringify(request), member.request_id); publish(member, request);
        for (const follower of db.prepare("SELECT m.* FROM run_members m JOIN runs r ON r.id=m.run_id WHERE m.request_id=? AND m.run_id!=? AND r.status NOT IN ('GREEN','RED','ERROR','INCOMPLETE')").all(member.request_id, member.run_id)) setMember(follower as unknown as Member, request);
      }
    }
  };
  const propagate = (member: Member, next: string) => {
    const edges = db.prepare('SELECT dependent FROM gate_edges WHERE run_id=? AND dependency=?').all(member.run_id, member.critic_id);
    for (const edge of edges) {
      db.prepare('UPDATE gate_counts SET unmet=unmet+?,red=red+? WHERE run_id=? AND critic_id=?').run(Number(next !== 'GREEN') - Number(member.state !== 'GREEN'), Number(blocked(next)) - Number(blocked(member.state)), member.run_id, edge.dependent);
      const gate = db.prepare('SELECT unmet,red FROM gate_counts WHERE run_id=? AND critic_id=?').get(member.run_id, edge.dependent)!;
      const dependent = db.prepare('SELECT * FROM run_members WHERE run_id=? AND critic_id=?').get(member.run_id, edge.dependent) as unknown as Member;
      if (Number(gate.unmet)) { if (dependent.state === 'WAIT_DEPENDENCY' || dependent.state === 'BLOCKED') { const state = Number(gate.red) ? 'BLOCKED' : 'WAIT_DEPENDENCY'; if (state !== dependent.state) { gateMember(dependent, state); propagate(dependent, state); } } continue; }
      if (dependent.state !== 'WAIT_DEPENDENCY' && dependent.state !== 'BLOCKED') continue;
      if (dependent.evidence_id) {
        const evidence = db.prepare('SELECT status FROM requests WHERE id=?').get(dependent.evidence_id)!;
        gateMember(dependent, String(evidence.status)); propagate(dependent, String(evidence.status));
      } else if (dependent.request_id) { const source = db.prepare('SELECT run_id,status FROM requests WHERE id=?').get(dependent.request_id)!; gateMember(dependent, source.run_id === dependent.run_id ? 'QUEUED' : String(source.status)); }
      else if (dependent.included) adoptOrCreate(dependent);
    }
  };
  return {
    header,
    initialize(run: RunRecord, prepared?: Awaited<ReturnType<typeof store.prepareRun>>) {
      const project = run.project!;
      preparedTemplates = new Map(project.templates.map(envelope => [envelope.criticId,envelope])); preparedWorkspace = run.workspace;
      try {
        const plan = planProject(project.snapshot, readEvidence(db), { selection: project.selection, recursive: project.recursive, force: project.force, ignoreGates: true, runId: run.id });
        const included = new Set(plan.includedCriticIds), templates = new Map(project.templates.map(envelope => [envelope.criticId, envelope]));
        const members = new Map<string, Member>();
        const counts = { queued: 0, running: 0, waiting: 0, errors: 0, red: 0, missing: plan.artifacts.filter(artifact => artifact.total === 0 && artifact.status !== 'BASIS').length };
        let ordinal = 0;
        for (const critic of plan.critics) {
          const envelope = templates.get(critic.id), state = critic.result?.verdict ?? 'MISSING';
          members.set(critic.id, { run_id: run.id, critic_id: critic.id, ordinal: ordinal++, target: critic.target, input_key: critic.input.key,
            input_ref: prepared?.inputs.get(critic.id) ?? store.put(critic.input), envelope_ref: envelope ? prepared?.envelopes.get(critic.id) ?? store.put(envelope) : null,
            request_id: null, evidence_id: critic.result?.requestId ?? null, state, included: included.has(critic.id) ? 1 : 0 });
        }
        const gateRows: (string | number)[][] = [], edgeRows: string[][] = [];
        if (!project.ignoreGates) {
          // Dependency-first SCC order permits one pass; no per-edge SELECT/update.
          for (const [dependent, dependencies] of criticGates(project.snapshot)) {
            const member = members.get(dependent); if (!member) continue;
            let unmet = 0, red = 0;
            for (const dependency of dependencies) {
              const other = members.get(dependency); if (!other) continue;
              edgeRows.push([run.id,dependent,dependency]);
              if (other.state !== 'GREEN') unmet++; if (blocked(other.state)) red++;
            }
            gateRows.push([run.id,dependent,unmet,red]);
            if (unmet) member.state = red ? 'BLOCKED' : 'WAIT_DEPENDENCY';
          }
        }
        for (const member of members.values()) { const key = bucket(member.state); if (key) counts[key as keyof typeof counts]++; }
        const batch = (table: string, width: number, rows: (string | number | null)[][]) => {
          for (let offset = 0; offset < rows.length; offset += 64) {
            const part = rows.slice(offset,offset+64);
            db.prepare(`INSERT INTO ${table} VALUES ${part.map(() => `(${Array(width).fill('?').join(',')})`).join(',')}`).run(...part.flat());
          }
        };
        batch('run_members',11,[...members.values()].map(member => Object.values(member)));
        batch('gate_edges',3,edgeRows); batch('gate_counts',4,gateRows);
        db.prepare('INSERT INTO run_counts VALUES (?,?,?,?,?,?,?)').run(run.id,counts.queued,counts.running,counts.waiting,counts.errors,counts.red,counts.missing);
        const relationRows = new Map(project.snapshot.config.relations.map(edge => [JSON.stringify([edge.target,edge.source]),[run.id,edge.target,edge.source]]));
        batch('run_dependencies',3,[...relationRows.values()]);
        for (const row of db.prepare('SELECT * FROM run_members WHERE run_id=? AND included=1 AND evidence_id IS NULL ORDER BY ordinal').all(run.id)) adoptOrCreate(row as unknown as Member);
        for (const row of db.prepare('SELECT * FROM run_members WHERE run_id=? AND evidence_id IS NOT NULL').all(run.id)) { const member = row as unknown as Member; const evidence = JSON.parse(String(db.prepare('SELECT data FROM requests WHERE id=?').get(member.evidence_id)!.data)); publish(member, { ...evidence, status: member.state, semanticRef: member.state === 'GREEN' || member.state === 'RED' ? evidence.semanticRef : null }); }
        updateRun(run.id);
      } finally { preparedTemplates = undefined; preparedWorkspace = undefined; }
    },
    transition(request: Record<string, any>) {
      // Only memberships affected by this request or matching input are visited.
      const members = db.prepare("SELECT m.* FROM run_members m JOIN runs r ON r.id=m.run_id WHERE m.request_id=? AND (r.status NOT IN ('GREEN','RED','ERROR','INCOMPLETE') OR m.run_id=?)").all(request.id,request.runId) as unknown as Member[];
      const affected = new Set<string>();
      for (const member of members) { const status = setMember(member, request); if (member.state !== status) propagate(member, status); affected.add(member.run_id); }
      if (request.status === 'GREEN' || request.status === 'RED') {
        const waiting = db.prepare("SELECT m.* FROM run_members m JOIN runs r ON r.id=m.run_id WHERE m.critic_id=? AND m.input_key=? AND m.request_id IS NULL AND r.status NOT IN ('GREEN','RED','ERROR','INCOMPLETE')").all(request.criticId, request.inputKey) as unknown as Member[];
        const input = store.get<ValidationInput>(request.inputRef);
        for (const member of waiting) {
          if (!input.reusable && member.run_id !== request.runId) continue;
          const status = effectiveState(member, request);
          changeCount(member.run_id, member.state, -1); changeCount(member.run_id, status, 1);
          db.prepare('UPDATE run_members SET state=?,evidence_id=? WHERE run_id=? AND critic_id=?').run(status, request.id, member.run_id, member.critic_id);
          publish(member, { ...request, status, semanticRef: status === request.status ? request.semanticRef : null });
          if (member.state !== status) propagate(member, status); affected.add(member.run_id);
        }
      }
      for (const id of affected) if (id === request.runId || db.prepare('SELECT 1 FROM run_owners WHERE run_id=?').get(id)) updateRun(id);
    },
    refresh(runId: string) {
      const pending = db.prepare("SELECT m.*,q.data FROM shared_members s JOIN run_members m ON m.run_id=s.run_id AND m.critic_id=s.critic_id JOIN requests q ON q.id=s.request_id WHERE s.run_id=? AND s.source_run_id!=?").all(runId, runId);
      for (const row of pending) {
        const request = JSON.parse(String(row.data)) as ReviewRequest;
        options.reconcile(request.runId);
        const current = db.prepare('SELECT data,status FROM requests WHERE id=?').get(request.id)!;
        if (terminal.has(String(current.status))) { this.transition(JSON.parse(String(current.data))); continue; }
        if (!coalescingEligibility(db, request, { ...options, ignoreGates: header(runId).project.ignoreGates })) adoptOrCreate(row as unknown as Member);
      }
      updateRun(runId);
    },
    updateRun,
  };
}
