const $ = (selector, root = document) => root.querySelector(selector);
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const json = value => JSON.stringify(value, null, 2);
const terminal = new Set(['GREEN', 'RED', 'ERROR']);
const statusLabels = {GREEN:'GREEN',RED:'RED',ERROR:'ERROR',RUNNING:'리뷰 중',QUEUED:'실행 대기',BLOCKED:'선행 평가 대기',WAITING_HUMAN:'사람 리뷰 대기',IDLE:'요청 전'};
const classFor = status => String(status || 'IDLE').toLowerCase().replaceAll('_', '-');
const shortCommit = commit => String(commit || '—').slice(0, 8);
const state = {demo:null, selectedScenario:null, runs:[], run:null, selectedRequest:null, autoSelect:true, tab:'result', submitting:false, pollTimer:null, historyTimer:null, artifact:null, humanBusy:false, humanDrafts:{}, lastAnnouncement:''};
const icons = {
  document:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8l-5-5Z" stroke="currentColor" stroke-width="1.35"/><path d="M14 3v5h5M8 12h8M8 16h6" stroke="currentColor" stroke-width="1.35"/></svg>',
  test:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M8 3h8M9 3v6l-5.5 9.2A2 2 0 0 0 5.2 21h13.6a2 2 0 0 0 1.7-2.8L15 9V3M7 14h10" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/><circle cx="10" cy="17" r="1" fill="currentColor"/></svg>',
  code:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 16" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  arrow:'<svg width="25" height="14" viewBox="0 0 25 14" fill="none" aria-hidden="true"><path d="M2 7h20m-4-4 4 4-4 4" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  eye:'<svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z" stroke="currentColor" stroke-width="1.2"/><circle cx="12" cy="12" r="2.5" stroke="currentColor" stroke-width="1.2"/></svg>',
  check:'<svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="m2 6 2.5 2.5L10 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'
};
const graphDefaults = [
  {id:'why',artifact:'why.md',title:'Why',icon:'document'},
  {id:'spec',artifact:'spec.md',title:'Spec',criticTitle:'Spec이 Why에 부합하는가',icon:'document'},
  {id:'tests',artifact:'tests',title:'Tests',criticTitle:'Tests가 Spec에 부합하는가',icon:'test'},
  {id:'implementation',artifact:'implementation',title:'Implementation',criticTitle:'테스트 런타임 통과',icon:'code'}
];

async function api(path, options = {}) {
  const response = await fetch(path, {...options, headers:{'Accept':'application/json', ...(options.body ? {'Content-Type':'application/json'} : {}), ...options.headers}});
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : data.error?.message || data.message || `요청 실패 (${response.status})`);
  return data;
}

function notify(message, isError = true) {
  $('#notice').hidden = !message;
  $('#notice').textContent = message || '';
  $('#notice').classList.toggle('notice-info', !isError);
}
function statusBadge(status) {return `<span class="status status-${classFor(status)}" data-status="${escape(status || 'IDLE')}">${escape(statusLabels[status] || status || '요청 전')}</span>`;}
function engineLabel(request) {
  const kind = request?.profile?.kind;
  if (kind === 'runtime' || kind === 'code-runner') return 'Runtime';
  if (kind === 'human') return 'Human';
  return 'Agent';
}
function timeLabel(date) {const d = new Date(date); return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString('ko-KR', {hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'});}
function duration(milliseconds) {if (!Number.isFinite(milliseconds) || milliseconds < 0) return '—'; if(milliseconds < 1000) return '1초 미만'; const sec = Math.round(milliseconds / 1000); return sec < 60 ? `${sec}초` : `${Math.floor(sec / 60)}분 ${String(sec % 60).padStart(2, '0')}초`;}
function elapsed(run) {return duration(new Date(run.completedAt || (terminal.has(run.status) ? run.requests?.map(r=>r.completedAt).filter(Boolean).sort().at(-1) : null) || Date.now()).getTime() - new Date(run.createdAt).getTime());}
function scenarioFor(commit) {return state.demo?.scenarios?.find(s => s.commit === commit);}
function selectedRequest() {return state.run?.requests?.find(r=>r.id === state.selectedRequest) || null;}
function graphItems() {return graphDefaults.map((fallback, index) => ({...fallback, ...(state.demo?.graph?.[index] || {}), icon:fallback.icon}));}
function requestError(request) {return typeof request?.error === 'string' ? request.error : request?.error?.message || (request?.error ? json(request.error) : '');}

function renderScenarios() {
  const scenarios = state.demo?.scenarios || [];
  $('#scenarios').setAttribute('aria-busy', 'false');
  $('#scenarios').innerHTML = scenarios.length ? scenarios.map((scenario, index) => `<button type="button" class="scenario-card ${state.selectedScenario === scenario.id ? 'selected' : ''}" aria-pressed="${state.selectedScenario === scenario.id}" data-scenario="${escape(scenario.id)}" data-testid="scenario-${escape(scenario.id)}"><span class="scenario-top"><span class="scenario-number">SNAPSHOT ${String(index + 1).padStart(2,'0')}</span><span class="scenario-radio" aria-hidden="true"></span></span><span class="scenario-title">${escape(scenario.label)}</span><span class="scenario-description">${escape(scenario.description)}</span></button>`).join('') : '<div class="loading-placeholder">등록된 데모 스냅샷이 없습니다.</div>';
  const selection = scenarios.find(s=>s.id === state.selectedScenario);
  $('#selected-commit').textContent = shortCommit(selection?.commit);
  $('#selected-commit').title = selection?.commit || '';
  $('#submit-run').disabled = !selection || state.submitting;
  $('#submit-run').innerHTML = state.submitting ? '<span class="spinner" aria-hidden="true"></span>브로커에 요청 중' : '<span class="button-icon" aria-hidden="true">↗</span>리뷰 요청 보내기';
}

function renderGraph() {
  const requests = state.run?.requests || [];
  const graph = graphItems();
  $('#graph').innerHTML = graph.map((node, index) => {
    const request = index ? requests[index - 1] : requests[0];
    const status = index ? request?.status || 'IDLE' : 'ROOT';
    const active = index > 0 && request?.id === state.selectedRequest;
    const artifact = request?.artifacts?.find(a => a.id === node.id);
    const name = ['Why','Spec','Tests','Implementation'][index];
    const label = status === 'ROOT' ? '의도의 출발점' : statusLabels[status] || status;
    const action = index === 0 ? `data-open-artifact="why" data-request-id="${escape(request?.id || '')}"` : `data-select-request="${escape(request?.id || '')}"`;
    const arrow = index ? `<div class="node-arrow ${classFor(status)}" aria-hidden="true"><span>${engineLabel(request || {profile:{kind:index === 3 ? 'runtime':'agent'}})}</span>${icons.arrow}</div>` : '';
    return `${arrow}<button type="button" class="artifact-node node-${classFor(status)} ${active ? 'active' : ''}" ${action} ${request ? '' : 'disabled'} data-testid="artifact-${escape(node.id)}" aria-label="${escape(name)} ${escape(label)}${index === 0 ? ' 문서 보기' : ' 평가 상세'}"><span class="node-top">${icons[node.icon]}<span class="node-index">0${index+1}</span></span><strong class="node-name">${name}</strong><code class="node-path">${escape(artifact?.path || (typeof node.artifact === 'string' ? node.artifact : node.artifact?.path) || graphDefaults[index].artifact)}</code><span class="node-state ${classFor(status)}">${status === 'GREEN' ? '✓ ' : status === 'RED' ? '× ' : status === 'ERROR' ? '! ' : ''}${escape(label)}</span></button>`;
  }).join('');
  $('#run-status').outerHTML = statusBadge(state.run?.status || 'IDLE').replace('<span ', '<span id="run-status" ');
}

function waitingReason(request, index) {
  if (!request) return index === 2 ? '테스트 코드를 실행해 구현을 검증합니다' : index === 0 ? 'why.md와 spec.md를 독립적으로 비교합니다' : 'spec.md와 tests의 요구사항을 비교합니다';
  if (request.status === 'BLOCKED') {
    const previous = state.run?.requests?.find(r=>r.id === request.predecessorId) || state.run?.requests?.[index-1];
    if (previous?.status === 'RED') return '선행 평가가 RED여서 실행하지 않습니다';
    if (previous?.status === 'ERROR') return '선행 평가에 오류가 있어 실행하지 않습니다';
    return '선행 평가의 GREEN 결과를 기다립니다';
  }
  if (request.status === 'RUNNING') return engineLabel(request) === 'Runtime' ? '스냅샷의 테스트 코드를 실제 실행 중입니다' : 'Agent가 Artifact tools로 문서를 읽고 평가합니다';
  if (request.status === 'WAITING_HUMAN') return '알림을 전달했습니다. 리뷰어의 결과를 기다립니다';
  if (request.status === 'ERROR') return requestError(request) || '실행 오류가 발생했습니다';
  if (request.result?.summary) return request.result.summary;
  return '브로커가 실행기를 배정하고 있습니다';
}

function renderCritics() {
  const requests = state.run?.requests || [];
  $('#critics').innerHTML = graphDefaults.slice(1).map((node,index)=>{
    const request = requests[index];
    const status = request?.status || 'IDLE';
    return `<button type="button" class="critic-row ${request?.id === state.selectedRequest && request ? 'selected':''}" ${request ? `data-select-request="${escape(request.id)}"` : 'disabled'} data-testid="critic-${index+1}" aria-pressed="${Boolean(request && request.id === state.selectedRequest)}"><span class="critic-step ${classFor(status)}">${status === 'GREEN' ? icons.check : status === 'RED' || status === 'ERROR' ? '!' : String(index + 1).padStart(2,'0')}</span><span class="critic-copy"><strong class="critic-title">${escape(request?.title || node.criticTitle)}</strong><span class="critic-subtitle">${escape(waitingReason(request,index))}</span></span><span class="critic-trailing"><span class="engine-label">${escape(engineLabel(request || {profile:{kind:index === 2 ? 'runtime':'agent'}}))}</span>${statusBadge(status)}<span class="critic-chevron" aria-hidden="true">›</span></span></button>`;
  }).join('');
  $('#run-handle').textContent = state.run ? `HANDLE ${state.run.id}` : '요청을 보내면 실행 핸들이 생성됩니다';
  $('#run-handle').title = state.run?.id || '';
  $('#run-meta').innerHTML = state.run ? `<span>리뷰 스냅샷 <code>${escape(shortCommit(state.run.snapshotCommit))}</code> <span class="middle-dot">·</span> ${escape(scenarioFor(state.run.snapshotCommit)?.label || '저장된 요청')}</span><span>${terminal.has(state.run.status) ? '소요' : '경과'} ${elapsed(state.run)}</span>` : '<span>Agent가 문서를 평가하고, Runtime이 실제 테스트를 실행합니다.</span>';
}

function eventDescription(event) {
  if (typeof event === 'string') return escape(event);
  const request = state.run?.requests?.find(r=>r.id === event.requestId);
  const name = request?.title || event.criticId || '';
  const type = String(event.type || event.kind || event.event || '').toLowerCase().replace(/[_.]/g, '-');
  const translations = {
    'run-submitted':'리뷰 요청을 접수했습니다', 'run-created':'리뷰 요청을 접수했습니다',
    'request-queued':'실행 대기', 'request-started':'리뷰 시작', 'review-started':'리뷰 시작',
    'request-completed':'리뷰 완료', 'review-completed':'리뷰 완료',
    'request-error':'실행 오류', 'run-completed':'요청 처리 완료', 'run-finished':'요청 처리 완료',
    'worktree-created':'스냅샷 worktree 준비 완료', 'snapshot-ready':'스냅샷 worktree 준비 완료',
    'tool-call':'Artifact tool 호출', 'request-blocked':'선행 평가 결과를 기다립니다',
    'human-notified':'사람 리뷰 알림 전달', 'human-claimed':'리뷰어가 요청을 맡았습니다',
    'executor-started':'실행기 시작', 'executor-completed':'실행기 완료', 'provider-started':'Agent 실행기 시작', 'runtime-started':'Runtime 실행기 시작',
    'artifact-tools-ready':'Artifact Runner가 조회 도구를 구성했습니다', 'artifact-tool-called':'Artifact 조회 도구 실행',
    'human-waiting':'등록된 알림 방법으로 리뷰를 요청했습니다',
    'run-status':`요청 상태: ${statusLabels[event.data?.status] || event.data?.status || ''}`
  };
  const message = type === 'request-completed' || type === 'request-error' ? event.message || translations[type] : translations[type] || event.message || event.data?.message || type || '브로커 이벤트';
  const verdict = event.verdict || event.data?.verdict || event.result?.verdict || (type === 'request-completed' ? event.data?.status : null);
  const toolName = type === 'artifact-tool-called' ? event.data?.name : null;
  return `${name ? `<strong>${escape(name)}</strong> <span class="middle-dot">·</span> ` : ''}${escape(message)}${toolName ? ` <code>${escape(toolName)}</code>` : ''}${verdict ? ` <code>${escape(verdict)}</code>` : ''}`;
}
function renderEvents() {
  const events = state.run?.events || [];
  $('#events').innerHTML = events.length ? events.slice(-7).reverse().map(event=>`<div class="event ${classFor(event.verdict || event.data?.verdict || event.data?.status || event.status || '')}"><time>${timeLabel(event.createdAt || event.timestamp || event.at)}</time><span class="event-marker"></span><span class="event-copy">${eventDescription(event)}</span></div>`).join('') : '<div class="quiet-empty">'+(state.run ? '실행 이벤트를 불러오고 있습니다.' : '리뷰 요청을 기다리고 있습니다.')+'</div>';
}

function artifactButtons(request) {
  return (request.artifacts || []).map(artifact=>`<button class="artifact-link" type="button" data-open-artifact="${escape(artifact.id)}" data-request-id="${escape(request.id)}" data-testid="open-artifact-${escape(artifact.id)}">${icons[artifact.type === 'code' ? 'code' : 'document']}<span class="artifact-link-copy"><strong>${escape(artifact.path)}</strong><small>${escape(artifact.type)} <span class="middle-dot">·</span> ${escape(artifact.id)}</small></span><span class="external" aria-hidden="true">↗</span></button>`).join('');
}
function factsMarkup(entries) {return `<dl class="detail-facts">${entries.filter(([,v])=>v !== undefined && v !== null && v !== '').map(([label,value,code])=>`<div class="fact"><dt>${escape(label)}</dt><dd>${code ? `<code>${escape(value)}</code>` : escape(value)}</dd></div>`).join('')}</dl>`;}
function toolDefinitions(request) {
  const readyEvent = state.run?.events?.findLast(event => event.requestId === request.id && event.type === 'artifact.tools.ready');
  const tools = readyEvent?.data?.tools || [];
  if(!tools.length) return '';
  return `<section class="detail-section"><h3>Agent에게 전달된 조회 도구</h3><p class="section-help">Artifact Runner가 이 요청의 뷰어 진입점을 도구로 구성했습니다.</p><div class="tool-definitions" data-testid="artifact-tools">${tools.map(tool=>`<code>${escape(typeof tool === 'string' ? tool : tool.name)}</code>`).join('')}</div></section>`;
}
function humanMarkup(request) {
  if (request.status !== 'WAITING_HUMAN') return '';
  const claimed = request.claimedBy || request.reviewerId || request.claim?.reviewerId;
  return `<section class="detail-section"><h3>사람 리뷰</h3>${claimed ? `<p class="section-help">담당 리뷰어: ${escape(claimed)}</p>` : '<p class="section-help">허용된 Artifact를 확인한 뒤 리뷰를 맡을 수 있습니다.</p>'}<form class="human-form" id="human-review-form"><label>리뷰어 이름<input name="reviewerId" type="text" required value="${escape(claimed || '')}" placeholder="리뷰어 이름" ${claimed ? 'readonly':''}></label>${claimed ? '<label>결과<select name="verdict"><option value="GREEN">GREEN · 기준에 부합</option><option value="RED">RED · 불일치 발견</option></select></label><label>평가 요약<textarea name="summary" required placeholder="판단과 근거를 기록해 주세요"></textarea></label><label>근거 (한 줄에 하나씩)<textarea name="evidence" required placeholder="Artifact 경로와 확인한 내용을 기록해 주세요"></textarea></label>' : ''}<button class="button primary" type="submit" ${state.humanBusy?'disabled':''} data-testid="human-submit">${claimed ? '리뷰 결과 제출' : '이 리뷰 맡기'}</button></form></section>`;
}

function renderInspector() {
  const request = selectedRequest();
  const outputWasOpen = Boolean($('[data-testid="runtime-output"]')?.open);
  $('#inspector-engine').textContent = request ? engineLabel(request) : '—';
  document.querySelectorAll('[data-tab]').forEach(button=>{const active = button.dataset.tab === state.tab; button.classList.toggle('active',active);button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1;});
  $('#inspector-body').setAttribute('aria-labelledby',`tab-${state.tab}`);
  if (!request) {
    $('#inspector-body').innerHTML = `<div class="inspector-empty"><div class="empty-symbol">${icons.eye}</div><strong>검증의 근거를 확인하는 곳</strong><p>스냅샷을 선택하고 리뷰를 요청하면<br>각 Critic의 판단과 사용한 Artifact를<br>이곳에서 확인할 수 있습니다.</p></div>`;
    return;
  }
  const index = state.run.requests.findIndex(r=>r.id === request.id);
  const header = `<div class="detail-heading"><span class="detail-index">CRITIC ${String(index+1).padStart(2,'0')} / 03</span>${statusBadge(request.status)}</div><h3 class="detail-title">${escape(request.title)}</h3>`;
  if (state.tab === 'request') {
    const snapshot = request.snapshotCommit || state.run.snapshotCommit;
    const profile = request.profile || {};
    const toolCalls = request.result?.toolCalls || [];
    $('#inspector-body').innerHTML = `${header}<section class="detail-section"><h3>허용된 Artifact <span>READ ONLY</span></h3><p class="section-help">요청 payload가 참조한 Artifact만 뷰어로 열 수 있습니다. Agent도 같은 범위의 도구를 사용합니다.</p>${artifactButtons(request)}</section>${toolDefinitions(request)}<section class="detail-section"><h3>리뷰 요청 payload</h3><pre class="request-payload" data-testid="request-payload">${escape(typeof request.payload === 'string' ? request.payload : json(request.payload || {}))}</pre></section>${factsMarkup([['요청 ID',request.id,true],['Repo',request.repoId || state.run.repoId,true],['Snapshot',snapshot,true],['실행기',engineLabel(request)],['Provider',profile.provider,true],['Model',profile.model,true],['Reasoning',profile.reasoning,true],['실행 명령',profile.command ? [profile.command,...(profile.args || [])].join(' ') : null,true]])}<section class="detail-section"><h3>리뷰 worktree</h3><code class="worktree-path" data-testid="worktree-path">${escape(request.worktreePath || '실행이 시작되면 스냅샷의 worktree가 만들어집니다.')}</code></section>${toolCalls.length ? `<section class="detail-section"><h3>실제로 사용한 도구 <span>${toolCalls.length} CALLS</span></h3>${toolCalls.map(call=>`<div class="tool-row"><code>${escape(call.name || call.tool || 'Artifact tool')}</code>${call.arguments ? `<small>${escape(typeof call.arguments === 'string' ? call.arguments : json(call.arguments))}</small>`:''}</div>`).join('')}</section>`:''}`;
  } else {
    const result = request.result;
    const status = request.status;
    const summary = result?.summary || (status === 'ERROR' ? requestError(request) : waitingReason(request,index));
    const labels = {GREEN:'기준에 부합합니다',RED:'불일치가 발견되었습니다',ERROR:'평가를 완료하지 못했습니다',RUNNING:'실제 리뷰를 수행하고 있습니다',QUEUED:'실행을 준비하고 있습니다',BLOCKED:'아직 실행하지 않았습니다',WAITING_HUMAN:'리뷰어의 응답을 기다립니다'};
    const evidence = Array.isArray(result?.evidence) ? result.evidence : result?.evidence ? [result.evidence] : [];
    $('#inspector-body').innerHTML = `${header}<div class="verdict-banner ${classFor(status)}" data-testid="verdict-panel"><div class="verdict-label">${status === 'RUNNING' ? '<span class="spinner" aria-hidden="true"></span>' : status === 'GREEN' ? icons.check : ''}${escape(labels[status] || status)}</div><p class="verdict-summary" data-testid="verdict-summary">${escape(summary)}</p></div>${evidence.length ? `<section class="detail-section"><h3>판단의 근거 <span>${evidence.length} EVIDENCE</span></h3><ul class="evidence-list" data-testid="evidence-list">${evidence.map(item=>`<li>${escape(typeof item === 'string' ? item : json(item))}</li>`).join('')}</ul></section>` : status === 'RUNNING' ? '<p class="section-help">실행 결과가 도착하면 판단과 근거를 표시합니다.</p>' : ''}<section class="detail-section"><h3>이 평가에서 읽는 Artifact</h3>${artifactButtons(request)}</section>${humanMarkup(request)}${factsMarkup([['Snapshot',shortCommit(request.snapshotCommit || state.run.snapshotCommit),true],['시작',request.startedAt ? timeLabel(request.startedAt):null],['완료',request.completedAt ? timeLabel(request.completedAt):null],['소요',result?.durationMs !== undefined ? duration(result.durationMs):null],['Provider',result?.provider || request.profile?.provider,true],['Model',result?.model || request.profile?.model,true],['종료 코드',result?.exitCode,true]])}${result?.stdout || result?.stderr ? `<details class="details-toggle" data-testid="runtime-output" ${outputWasOpen ? 'open' : ''}><summary>실행 출력 확인</summary><pre class="log-output">${escape([result.stdout,result.stderr].filter(Boolean).join('\n'))}</pre></details>`:''}`;
  }
  const draft=state.humanDrafts[request.id], form=$('#human-review-form');
  if(draft && form) for(const name of ['reviewerId','verdict','summary','evidence']) {
    const field=form.elements.namedItem(name);
    if(field && !field.readOnly && draft[name] !== undefined)field.value=draft[name];
  }
}

function renderHistory() {
  $('#history').innerHTML = state.runs.length ? state.runs.map(run=>`<button type="button" class="history-item ${run.id === state.run?.id ? 'selected':''}" data-open-run="${escape(run.id)}" data-testid="history-${escape(run.id)}"><span class="history-top"><strong class="history-name">${escape(scenarioFor(run.snapshotCommit)?.label || '리뷰 요청')}</strong>${statusBadge(run.status)}</span><span class="history-meta"><code>${escape(shortCommit(run.snapshotCommit))}</code><span>${timeLabel(run.createdAt)}</span></span></button>`).join('') : '<div class="quiet-empty">아직 요청 이력이 없습니다.</div>';
}

function renderRun({inspector = true} = {}) {
  renderGraph(); renderCritics(); renderEvents(); if (inspector) renderInspector(); renderHistory();
  if (state.run) {
    const announcement = `${state.run.id} ${state.run.status}`;
    if (announcement !== state.lastAnnouncement) {$('#live-status').textContent = `리뷰 요청 상태: ${statusLabels[state.run.status] || state.run.status}`;state.lastAnnouncement=announcement;}
  }
}
function applyRun(run) {
  state.run = run;
  const requests = run.requests || [];
  if (state.autoSelect || !requests.some(r=>r.id === state.selectedRequest)) {
    state.selectedRequest = (requests.find(r=>r.status === 'RED' || r.status === 'ERROR') || requests.find(r=>r.status === 'RUNNING' || r.status === 'WAITING_HUMAN' || r.status === 'QUEUED') || (run.status === 'GREEN' ? requests.at(-1) : requests[0]))?.id || null;
  }
  const index = state.runs.findIndex(r=>r.id === run.id);
  if (index < 0) state.runs.unshift(run); else state.runs[index] = run;
  // Preserve a human review being composed while the rest of the page stays live.
  const preserveForm = Boolean($('#human-review-form') && $('#human-review-form').contains(document.activeElement));
  renderRun({inspector:!preserveForm});
}

async function loadRun(id, {userSelected = false} = {}) {
  clearTimeout(state.pollTimer);
  const previousId = state.run?.id;
  try {
    const data = await api(`/api/runs/${encodeURIComponent(id)}`);
    if (state.run?.id && state.run.id !== id && state.run.id !== previousId && !userSelected) return;
    if (userSelected) {state.autoSelect=true; state.selectedRequest=null; const scenario = scenarioFor((data.run || data).snapshotCommit); if (scenario) state.selectedScenario=scenario.id; renderScenarios();}
    applyRun(data.run || data);
    schedulePoll();
  } catch(error) {notify(error.message); schedulePoll(4000);}
}
function schedulePoll(delay) {
  clearTimeout(state.pollTimer);
  if (!state.run) return;
  const id = state.run.id;
  state.pollTimer = setTimeout(()=>{if (state.run?.id === id) loadRun(id);}, delay || (terminal.has(state.run.status) ? 7000 : 1300));
}
async function loadHistory() {
  try {const response = await api('/api/runs'); state.runs = Array.isArray(response) ? response : response.runs || [];renderHistory();} catch { /* Active request polling reports connection failures. */ }
  state.historyTimer = setTimeout(loadHistory, 7000);
}
async function checkConnection() {
  try {await api('/api/health');$('#connection').className='connection online';$('#connection').innerHTML='<i></i>브로커 연결됨';}
  catch {$('#connection').className='connection offline';$('#connection').innerHTML='<i></i>브로커 연결 끊김';}
  setTimeout(checkConnection, 15000);
}

async function submitRun() {
  const scenario = state.demo?.scenarios?.find(s=>s.id === state.selectedScenario);
  if (!scenario || state.submitting) return;
  state.submitting=true;renderScenarios();notify('');
  try {
    const response = await api('/api/runs', {method:'POST',body:json({snapshotCommit:scenario.commit,requesterId:'web-demo',reviewRequests:scenario.reviewRequests})});
    const run = response.run || response;
    if (!run.id) throw new Error('브로커 응답에 실행 핸들이 없습니다.');
    state.autoSelect=true;state.selectedRequest=null;state.tab='result';applyRun(run);schedulePoll(350);
  } catch(error) {notify(error.message);}
  finally {state.submitting=false;renderScenarios();}
}

// A small, escaped renderer: source HTML and link URLs are never inserted as HTML.
function markdown(source) {
  const inline = text => escape(text).replace(/`([^`]+)`/g,'<code>$1</code>').replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>');
  const lines = String(source).split('\n'); let output='', code=[], inCode=false, listType=null, paragraph=[];
  const closeParagraph=()=>{if(paragraph.length){output+=`<p>${inline(paragraph.join('\n'))}</p>`;paragraph=[];}};
  const closeList=()=>{if(listType){output+=`</${listType}>`;listType=null;}};
  for(const line of lines){
    if(/^```/.test(line)){closeParagraph();closeList();if(inCode){output+=`<pre>${escape(code.join('\n'))}</pre>`;code=[];}inCode=!inCode;continue;}
    if(inCode){code.push(line);continue;}
    if(!line.trim()){closeParagraph();closeList();continue;}
    const heading=line.match(/^(#{1,3})\s+(.+)$/), list=line.match(/^\s*(?:([-*])|\d+\.)\s+(.+)$/);
    if(heading){closeParagraph();closeList();output+=`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`;}
    else if(list){closeParagraph();const next=list[1]?'ul':'ol';if(listType!==next){closeList();output+=`<${next}>`;listType=next;}output+=`<li>${inline(list[2])}</li>`;}
    else if(line.startsWith('> ')){closeParagraph();closeList();output+=`<blockquote>${inline(line.slice(2))}</blockquote>`;}
    else if(/^---+$/.test(line)){closeParagraph();closeList();output+='<hr>';}
    else{closeList();paragraph.push(line);}
  }
  closeParagraph();closeList();if(code.length)output+=`<pre>${escape(code.join('\n'))}</pre>`;return output;
}

async function openArtifact(requestId, artifactId, file) {
  if (!requestId) return;
  const request = state.run?.requests?.find(r=>r.id === requestId);
  const artifact = request?.artifacts?.find(a=>a.id === artifactId);
  const same = state.artifact?.requestId === requestId && state.artifact?.artifactId === artifactId;
  state.artifact = {requestId,artifactId,file,files:same ? state.artifact.files:[]};
  const identity = state.artifact;
  const dialog = $('#artifact-dialog');
  if (!dialog.open) dialog.showModal();
  $('#artifact-dialog-title').textContent = file || artifact?.path || artifactId;
  $('#artifact-meta').innerHTML = `<span>ARTIFACT <strong>${escape(artifactId)}</strong></span><span>SNAPSHOT <strong class="mono">${escape(shortCommit(request?.snapshotCommit || state.run?.snapshotCommit))}</strong></span><span>TYPE <strong>${escape(artifact?.type || '—')}</strong></span>`;
  $('#artifact-content').innerHTML = '<div class="quiet-empty"><span class="spinner" aria-hidden="true"></span> 스냅샷에서 Artifact를 읽고 있습니다.</div>';
  if (!same) {$('#artifact-files').hidden=true;$('#artifact-files').innerHTML='';}
  try {
    const data = await api(`/api/requests/${encodeURIComponent(requestId)}/artifacts/${encodeURIComponent(artifactId)}${file ? `?file=${encodeURIComponent(file)}`:''}`);
    if (state.artifact !== identity) return;
    const files = data.files || data.entries || (Array.isArray(data.content) ? data.content:[]);
    if (files.length) state.artifact.files=files;
    if (state.artifact.files.length) {
      $('#artifact-files').hidden=false;
      $('#artifact-files').innerHTML=state.artifact.files.map(entry=>{const path=typeof entry === 'string' ? entry : entry.path || entry.name;return `<button class="file-tab ${path === file ? 'active':''}" data-artifact-file="${escape(path)}">${escape(path)}</button>`;}).join('');
    }
    $('#artifact-dialog-title').textContent=data.path || file || artifact?.path || artifactId;
    const content = typeof data.content === 'string' ? data.content : typeof data.text === 'string' ? data.text : null;
    if (data.directory && state.artifact.files.length && !file) {
      const first=state.artifact.files.find(item=>typeof item === 'string' || (item.type !== 'directory' && item.kind !== 'directory'));
      if(first) {await openArtifact(requestId,artifactId,typeof first === 'string' ? first : first.path || first.name);return;}
    }
    if (content !== null) {
      const isMarkdown = data.type === 'markdown' || artifact?.type === 'markdown' || /\.md$/i.test(data.path || file || '');
      $('#artifact-content').innerHTML = isMarkdown ? `<article class="artifact-markdown">${markdown(content)}</article>` : `<pre class="artifact-source">${escape(content)}</pre>`;
    } else if (state.artifact.files.length) {
      $('#artifact-content').innerHTML='<div class="quiet-empty">위의 파일을 선택하면 내용을 확인할 수 있습니다.</div>';
      const first=state.artifact.files.find(item=>typeof item === 'string' || (item.type !== 'directory' && item.kind !== 'directory'));
      if(first && !file) await openArtifact(requestId,artifactId,typeof first === 'string' ? first : first.path || first.name);
    } else $('#artifact-content').innerHTML='<div class="quiet-empty">이 Artifact에서 표시할 파일이 없습니다.</div>';
  } catch(error) {if(state.artifact === identity) $('#artifact-content').innerHTML=`<div class="notice" role="alert">${escape(error.message)}</div>`;}
}

async function submitHuman(event) {
  event.preventDefault();const request=selectedRequest();if(!request || state.humanBusy)return;
  const form=new FormData(event.target), reviewerId=String(form.get('reviewerId') || '').trim();
  if(!reviewerId)return;
  state.humanBusy=true;const button=$('button',event.target);button.disabled=true;
  try{
    const claimed=request.claimedBy || request.reviewerId || request.claim?.reviewerId;
    const path=`/api/requests/${encodeURIComponent(request.id)}/${claimed ? 'result':'claim'}`;
    const body=claimed ? {reviewerId,result:{verdict:form.get('verdict'),summary:String(form.get('summary') || '').trim(),evidence:String(form.get('evidence') || '').split('\n').map(s=>s.trim()).filter(Boolean)}} : {reviewerId};
    await api(path,{method:'POST',body:json(body)});await loadRun(state.run.id);
  }catch(error){notify(error.message);}finally{state.humanBusy=false;renderInspector();}
}

document.addEventListener('click', event=>{
  const scenario=event.target.closest('[data-scenario]');if(scenario){state.selectedScenario=scenario.dataset.scenario;renderScenarios();return;}
  const request=event.target.closest('[data-select-request]');if(request?.dataset.selectRequest){state.selectedRequest=request.dataset.selectRequest;state.autoSelect=false;renderGraph();renderCritics();renderInspector();return;}
  const tab=event.target.closest('[data-tab]');if(tab){state.tab=tab.dataset.tab;renderInspector();return;}
  const artifact=event.target.closest('[data-open-artifact]');if(artifact){openArtifact(artifact.dataset.requestId,artifact.dataset.openArtifact);return;}
  const file=event.target.closest('[data-artifact-file]');if(file && state.artifact){openArtifact(state.artifact.requestId,state.artifact.artifactId,file.dataset.artifactFile);return;}
  const history=event.target.closest('[data-open-run]');if(history){loadRun(history.dataset.openRun,{userSelected:true});return;}
});
document.addEventListener('submit',event=>{if(event.target.id === 'human-review-form')submitHuman(event);});
document.addEventListener('input',event=>{const form=event.target.closest('#human-review-form');if(form && state.selectedRequest)state.humanDrafts[state.selectedRequest]=Object.fromEntries(new FormData(form));});
$('.tabs').addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();state.tab=event.key === 'Home' ? 'result' : event.key === 'End' ? 'request' : state.tab === 'result' ? 'request' : 'result';renderInspector();$(`#tab-${state.tab}`).focus();});
$('#submit-run').addEventListener('click',submitRun);
$('#close-artifact').addEventListener('click',()=>$('#artifact-dialog').close());
$('#artifact-dialog').addEventListener('click',event=>{if(event.target === $('#artifact-dialog')){const rect=event.target.getBoundingClientRect();if(event.clientX<rect.left || event.clientX>rect.right || event.clientY<rect.top || event.clientY>rect.bottom)event.target.close();}});
$('#artifact-dialog').addEventListener('close',()=>{state.artifact=null;});
document.addEventListener('visibilitychange',()=>{if(!document.hidden && state.run)loadRun(state.run.id);});

async function init() {
  renderRun();checkConnection();
  try {
    state.demo=await api('/api/demo');state.selectedScenario=state.demo.scenarios?.[0]?.id || null;
    renderScenarios();renderGraph();
    const provider=state.demo.provider;
    $('#provider-info').textContent=typeof provider === 'string' ? `${provider} · 실제 Agent 평가 + Runtime 실행` : `${provider?.name || provider?.provider || 'Agent'} · 실제 Agent 평가 + Runtime 실행`;
    await loadHistory();
    if(state.runs.length)await loadRun(state.runs[0].id,{userSelected:true});
  } catch(error) {notify(error.message);$('#scenarios').setAttribute('aria-busy','false');$('#scenarios').innerHTML='<div class="loading-placeholder">데모를 불러오지 못했습니다. 브로커 연결을 확인해 주세요.</div>';}
}
init();
