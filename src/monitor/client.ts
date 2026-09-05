import type { MonitorArtifactPage, MonitorDetail, MonitorFilter, MonitorOverview, MonitorProject, MonitorRequest } from './types.js';

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function find<T extends HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`Missing UI element: ${selector}`);
  return node;
}
function button(text: string, onClick: () => void, className = 'text-button'): HTMLButtonElement {
  const node = element('button', className, text);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}
async function api<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(15_000), cache: 'no-store' });
  const value = await response.json();
  if (!response.ok) throw new Error(typeof value?.error === 'string' ? value.error : '잠시 후 다시 시도해 주세요.');
  return value as T;
}
const requestList = find('#requests');
const detailPane = find('#detail');
const connection = find('#connection');
const projectSelect = find<HTMLSelectElement>('#project-select');
const projectNav = find('#projects');
const main = find('.main');
const terminal = new Set(['GREEN', 'RED', 'ERROR']);
const kindLabels = { agent: 'Agent', human: 'Human', runtime: 'Runtime' };
let project = '';
let filter: MonitorFilter = 'all';
let offset = 0;
let overview: MonitorOverview | null = null;
let selected: { project: string; request: string } | null = null;
let detail: MonitorDetail | null = null;
let detailTab = 'review';
let listSignature = '';
let projectSignature = '';
let detailSignature = '';
let detailVersion = 0;
let refreshing = false;
let refreshPending = false;
let scopeLoading = true;
let selectionVersion = 0;
let artifactController: AbortController | null = null;
let artifactVersion = 0;
let artifactSelection: { id: string; operation?: 'list' | 'read'; path?: string; startLine?: number; offset?: number } | null = null;

function elapsed(start: string, end?: string | null): string {
  const seconds = Math.max(0, Math.floor(((end ? Date.parse(end) : Date.now()) - Date.parse(start)) / 1000));
  if (!Number.isFinite(seconds)) return '—';
  if (seconds < 60) return `${seconds}초`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}분 ${seconds % 60}초`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}시간 ${Math.floor(seconds % 3600 / 60)}분`;
  return `${Math.floor(seconds / 86400)}일 ${Math.floor(seconds % 86400 / 3600)}시간`;
}
function dateLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date);
}
function badge(request: MonitorRequest): HTMLElement {
  const missing = request.workerState === 'missing' && !terminal.has(request.status);
  const labels: Record<string, string> = { RUNNING: '실행 중', WAITING_HUMAN: request.claimedBy ? '검토 중' : '사람 대기', QUEUED: '실행 대기', BLOCKED: '대기', GREEN: '통과', RED: '수정 필요', ERROR: '실행 오류' };
  const classes: Record<string, string> = { RUNNING: 'running', WAITING_HUMAN: 'waiting', QUEUED: 'blocked', BLOCKED: 'blocked', GREEN: 'green', RED: 'red', ERROR: 'error' };
  const node = element('span', `badge ${missing ? 'error' : classes[request.status] ?? ''}`);
  node.append(element('i'), document.createTextNode(missing ? '실행 중단 감지' : request.blockedByFailure ? '진행 불가' : labels[request.status] ?? request.status));
  if (request.waitingReason) node.title = request.waitingReason;
  return node;
}
function projectName(id: string): string { return overview?.projects.find(item => item.id === id)?.name ?? '프로젝트'; }
function renderProjects(projects: MonitorProject[]): void {
  const signature = JSON.stringify({ projects, project });
  if (projectSignature === signature) return;
  projectSignature = signature;
  const all = button('모든 프로젝트', () => selectProject(''), 'project-button');
  all.setAttribute('aria-current', String(!project));
  projectNav.replaceChildren(all);
  projectSelect.replaceChildren(new Option('모든 프로젝트', ''));
  if (projects.length) projectNav.append(element('hr', 'project-separator'));
  for (const item of projects) {
    const choice = button(item.name, () => selectProject(item.id), 'project-button');
    choice.title = item.path;
    choice.setAttribute('aria-current', String(item.id === project));
    if (projects.filter(other => other.name === item.name).length > 1) {
      choice.append(element('small', '', item.path.split('/').slice(-2).join('/')));
    }
    projectNav.append(choice);
    projectSelect.append(new Option(item.name, item.id));
  }
  projectSelect.value = project;
}
function selectProject(id: string): void {
  project = id; offset = 0; closeDetail(false); listSignature = ''; projectSignature = '';
  if (overview) renderProjects(overview.projects);
  showScopeLoading();
  void refresh();
}
function showScopeLoading(): void {
  scopeLoading = true; listSignature = '';
  requestList.replaceChildren(element('p', 'artifact-message', '요청을 불러오는 중…'));
  find('#list-caption').textContent = '목록을 확인하고 있습니다.';
  document.querySelectorAll<HTMLButtonElement>('[data-filter]').forEach(node => node.setAttribute('aria-pressed', String(node.dataset.filter === filter)));
  find<HTMLButtonElement>('#load-more').disabled = true; find<HTMLButtonElement>('#newer').disabled = true;
}
function emptyList(data: MonitorOverview): HTMLElement {
  const node = element('div', 'empty-state');
  node.append(element('div', 'empty-symbol', '◌'));
  if (!data.projects.length) {
    node.append(element('strong', '', '아직 리뷰 요청이 없습니다'), element('p', '', '프로젝트에서 CCDD 리뷰를 실행하면 여기에 표시됩니다.'));
    const hint = element('p', 'empty-command'); hint.append(element('code', '', 'ccdd run --copy')); node.append(hint);
    node.append(element('p', 'empty-hint', '별도 저장 경로는 monitor의 --state-dir로 연결할 수 있습니다.'));
  } else if (filter === 'attention') node.append(element('strong', '', '확인할 요청이 없습니다'), element('p', '', '사람의 검토나 수정이 필요하면 여기에 표시됩니다.'));
  else if (filter === 'active') node.append(element('strong', '', '진행 중인 요청이 없습니다'), element('p', '', '완료된 리뷰는 전체 목록에서 볼 수 있습니다.'));
  else node.append(element('strong', '', '표시할 요청이 없습니다'), element('p', '', offset ? '최근 요청으로 돌아가 주세요.' : '새 리뷰가 접수되면 자동으로 표시됩니다.'));
  return node;
}
function renderOverview(data: MonitorOverview): void {
  overview = data;
  renderProjects(data.projects);
  const issues = data.projects.filter(item => item.issue && (!project || item.id === project));
  const sourceError = find('#source-error'); sourceError.hidden = !issues.length;
  sourceError.textContent = issues.map(item => `${item.name}: ${item.issue}`).join(' ');
  find('#list-caption').textContent = project ? `${projectName(project)} · ${data.counts.all}개 요청` : `${data.projects.length}개 프로젝트 · ${data.counts.all}개 요청`;
  document.querySelectorAll<HTMLButtonElement>('[data-filter]').forEach(node => {
    const key = node.dataset.filter as MonitorFilter;
    node.setAttribute('aria-pressed', String(key === filter));
    const count = node.querySelector('span'); if (count) count.textContent = data.counts[key] ? String(data.counts[key]) : '';
  });
  find('#load-more').hidden = !data.hasMore;
  find('#newer').hidden = offset === 0;
  const signature = JSON.stringify({ requests: data.requests, projectNames: data.projects.map(item => [item.id, item.name]), filter, selected });
  if (signature === listSignature) { updateDurations(); return; }
  listSignature = signature;
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.request : undefined;
  const rows = data.requests.map(request => {
    const row = button('', () => openDetail(request.projectId, request.id), 'request-row');
    row.dataset.request = `${request.projectId}/${request.id}`;
    row.setAttribute('aria-current', String(selected?.request === request.id && selected.project === request.projectId));
    const title = element('div', 'request-title'); title.append(element('strong', '', request.title));
    const subtitle = element('div', 'request-subtitle'); subtitle.append(element('span', 'project-name', projectName(request.projectId)), element('span', '', '·'), element('span', '', kindLabels[request.kind]));
    title.append(subtitle);
    const aside = element('div', 'row-aside');
    const duration = element('span', 'duration', request.blockedByFailure ? '—' : elapsed(request.createdAt, request.completedAt));
    if (!request.blockedByFailure) { duration.dataset.start = request.createdAt; if (request.completedAt) duration.dataset.end = request.completedAt; }
    duration.title = request.blockedByFailure ? '선행 리뷰가 종료되어 실행되지 않은 요청입니다.' : `접수 후 경과 · ${dateLabel(request.createdAt)}`;
    aside.append(badge(request), duration);
    row.append(title, aside, element('span', 'row-arrow', '›'));
    return row;
  });
  requestList.replaceChildren(...(rows.length ? rows : [emptyList(data)]));
  if (focused) rows.find(row => row.dataset.request === focused)?.focus({ preventScroll: true });
}
function updateDurations(): void {
  document.querySelectorAll<HTMLElement>('[data-start]').forEach(node => { node.textContent = elapsed(node.dataset.start!, node.dataset.end); });
}
function closeDetail(focus = true): void {
  const last = selected;
  selected = null; detail = null; detailSignature = ''; selectionVersion++; artifactVersion++;
  artifactController?.abort(); artifactSelection = null;
  detailPane.hidden = true; main.classList.remove('has-detail');
  history.replaceState(null, '', location.pathname + location.search);
  if (overview) renderOverview(overview);
  if (focus && last) Array.from(document.querySelectorAll<HTMLElement>('[data-request]')).find(node => node.dataset.request === `${last.project}/${last.request}`)?.focus();
}
function openDetail(projectId: string, requestId: string, updateHistory = true): void {
  selected = { project: projectId, request: requestId };
  detail = null; detailTab = 'review'; detailSignature = ''; artifactSelection = null;
  selectionVersion++; artifactVersion++; artifactController?.abort();
  main.classList.add('has-detail'); detailPane.hidden = false;
  detailPane.scrollTop = 0;
  detailPane.replaceChildren(element('p', 'artifact-message', '요청을 불러오는 중…'));
  if (updateHistory) history.replaceState(null, '', `#${encodeURIComponent(projectId)}/${encodeURIComponent(requestId)}`);
  if (overview) renderOverview(overview);
  void refreshDetail(true);
}
async function refreshDetail(focus = false): Promise<void> {
  if (!selected) return;
  const version = selectionVersion;
  const requestVersion = ++detailVersion;
  try {
    const data = await api<MonitorDetail>(`/api/requests/${encodeURIComponent(selected.project)}/${encodeURIComponent(selected.request)}`);
    if (version !== selectionVersion || requestVersion !== detailVersion) return;
    detailPane.querySelector('.detail-refresh-error')?.remove();
    detail = data;
    const signature = JSON.stringify(data);
    if (signature === detailSignature) return;
    detailSignature = signature;
    // Reviews can advance while a reader scrolls or types. Keep the Artifact DOM intact.
    if (detailTab === 'artifacts' && detailPane.querySelector('.artifact-content')) {
      detailPane.querySelector('h2')!.textContent = data.request.title;
      const meta = detailPane.querySelector('.detail-meta');
      meta?.replaceChildren(badge(data.request), element('span', '', data.profile.kind === 'agent' ? data.profile.model : kindLabels[data.profile.kind]));
      return;
    }
    renderDetail();
    if (focus) detailPane.querySelector<HTMLButtonElement>('.close-detail')?.focus({ preventScroll: true });
  } catch (error) {
    if (version !== selectionVersion || requestVersion !== detailVersion) return;
    if (detail) {
      let note = detailPane.querySelector<HTMLElement>('.detail-refresh-error');
      if (!note) { note = element('p', 'inline-error detail-refresh-error'); note.setAttribute('role', 'status'); detailPane.querySelector('.detail-meta')?.after(note); }
      note.textContent = '이 요청을 갱신하지 못했습니다. 마지막으로 확인한 기록입니다.';
      return;
    }
    const close = button('목록으로', () => closeDetail());
    detailPane.replaceChildren(close, element('p', 'artifact-message error', error instanceof Error ? error.message : '요청을 불러오지 못했습니다.'));
  }
}
function renderDetail(): void {
  if (!detail || !selected) return;
  const scrollTop = detailPane.scrollTop;
  const opened = Array.from(detailPane.querySelectorAll<HTMLDetailsElement>('details[open]')).map(node => node.dataset.section);
  const top = element('div', 'detail-top');
  top.append(element('span', 'detail-project', projectName(selected.project)));
  const close = button('×', () => closeDetail(), 'icon-button close-detail'); close.setAttribute('aria-label', '요청 상세 닫기'); top.append(close);
  const heading = element('h2', '', detail.request.title);
  const meta = element('div', 'detail-meta'); meta.append(badge(detail.request));
  const profile = detail.profile;
  meta.append(element('span', '', profile.kind === 'agent' ? profile.model : kindLabels[profile.kind]));
  const tabs = element('div', 'detail-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', '요청 정보');
  for (const [key, label] of [['review', '검토'], ['artifacts', 'Artifact']]) {
    const tab = button(label, () => { detailTab = key; renderDetail(); detailPane.querySelector<HTMLButtonElement>('[aria-selected=true]')?.focus({ preventScroll: true }); });
    tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(detailTab === key));
    tab.id = `tab-${key}`; tab.tabIndex = detailTab === key ? 0 : -1; tab.setAttribute('aria-controls', 'detail-body');
    tab.addEventListener('keydown', event => {
      if (['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); detailTab = key === 'review' ? 'artifacts' : 'review'; renderDetail(); detailPane.querySelector<HTMLButtonElement>('[aria-selected=true]')?.focus(); }
    });
    tabs.append(tab);
  }
  const body = element('div'); body.id = 'detail-body'; body.setAttribute('role', 'tabpanel'); body.setAttribute('aria-labelledby', `tab-${detailTab}`);
  detailPane.replaceChildren(top, heading, meta, tabs, body);
  if (detailTab === 'artifacts') renderArtifacts(body);
  else {
    const text = detail.error ?? detail.result?.summary ?? detail.request.waitingReason ?? (detail.request.status === 'RUNNING' ? 'Artifact를 확인하고 있습니다.' : '리뷰 실행을 기다리고 있습니다.');
    body.append(element('p', `outcome${detail.error ? ' error' : ''}`, text));
    if (detail.result?.evidence.length) {
      const evidence = element('details', 'evidence'); evidence.dataset.section = 'evidence';
      evidence.append(element('summary', '', `근거 ${detail.result.evidence.length}개`));
      const list = element('ul'); for (const item of detail.result.evidence) list.append(element('li', '', item)); evidence.append(list); body.append(evidence);
    }
    if (detail.timeline.length) {
      const section = element('section', 'detail-section'); section.append(element('h3', 'section-title', '진행 기록'));
      const timeline = element('ol', 'timeline');
      for (const item of detail.timeline) {
        if (item.label === '실행 대기' && dateLabel(item.at) === dateLabel(detail.request.createdAt)) continue;
        const row = element('li'); const time = element('time', '', dateLabel(item.at)); time.dateTime = item.at; row.append(element('span', '', item.label), time); timeline.append(row);
      }
      section.append(timeline); body.append(section);
    }
    const instruction = element('details', 'disclosure'); instruction.dataset.section = 'instruction';
    instruction.append(element('summary', '', '요청 내용'), element('p', 'instruction', detail.instruction));
    if (profile.kind === 'agent') instruction.append(element('p', 'profile-description', `${profile.provider} · ${profile.model} · ${profile.reasoning}`));
    body.append(instruction);
  }
  for (const node of detailPane.querySelectorAll<HTMLDetailsElement>('details')) node.open = opened.includes(node.dataset.section);
  detailPane.scrollTop = scrollTop;
}
function renderArtifacts(container: HTMLElement): void {
  if (!detail) return;
  if (!detail.artifacts.length) { container.append(element('p', 'artifact-message', '제공된 Artifact가 없습니다.')); return; }
  const choices = element('div', 'artifact-choices');
  if (!artifactSelection || !detail.artifacts.some(item => item.id === artifactSelection?.id)) artifactSelection = { id: detail.artifacts[0].id };
  for (const item of detail.artifacts) {
    const choice = button(item.path, () => { artifactSelection = { id: item.id }; renderDetail(); }, 'artifact-choice');
    choice.title = item.id; choice.setAttribute('aria-pressed', String(item.id === artifactSelection.id)); choices.append(choice);
  }
  const content = element('div', 'artifact-content'); container.append(choices, content);
  void loadArtifact(content);
}
function navigateArtifact(value: NonNullable<typeof artifactSelection>): void { artifactSelection = value; renderDetail(); }
async function loadArtifact(container: HTMLElement): Promise<void> {
  if (!selected || !artifactSelection) return;
  artifactController?.abort(); artifactController = new AbortController();
  const current = { ...artifactSelection }; const version = ++artifactVersion;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(current)) if (key !== 'id' && value !== undefined) query.set(key, String(value));
  container.replaceChildren(element('p', 'artifact-message', 'Artifact를 읽는 중…'));
  try {
    const page = await api<MonitorArtifactPage>(`/api/requests/${encodeURIComponent(selected.project)}/${encodeURIComponent(selected.request)}/artifacts/${encodeURIComponent(current.id)}?${query}`, artifactController.signal);
    if (version !== artifactVersion || !container.isConnected) return;
    container.replaceChildren(element('p', 'artifact-description', page.artifact.description));
    const toolbar = element('div', 'artifact-toolbar');
    if (current.path) {
      const parent = current.path.split('/').slice(0, -1).join('/');
      toolbar.append(button('‹ 상위 폴더', () => navigateArtifact({ id: current.id, operation: 'list', ...(parent ? { path: parent } : {}) }), 'artifact-back'));
    }
    toolbar.append(element('span', 'artifact-path', current.path ?? page.artifact.path));
    container.append(toolbar);
    const result = page.result;
    if ('entries' in result) {
      const list = element('div', 'file-list');
      for (const entry of result.entries) {
        const row = button('', () => navigateArtifact({ id: current.id, operation: entry.kind === 'directory' ? 'list' : 'read', path: entry.path }), 'file-entry');
        row.disabled = !['file', 'directory'].includes(entry.kind);
        row.append(element('span', 'file-icon', entry.kind === 'directory' ? '▱' : '·'), element('span', 'file-name', entry.name)); list.append(row);
      }
      container.append(result.entries.length ? list : element('p', 'artifact-message', '빈 폴더입니다.'));
      const pagination = element('div', 'artifact-pagination'); pagination.append(element('span', '', `${(current.offset ?? 0) + result.entries.length} / ${result.totalEntries}개`));
      if (current.offset) pagination.append(button('처음으로', () => navigateArtifact({ ...current, offset: 0 })));
      if (result.nextOffset !== null) pagination.append(button('다음 파일', () => navigateArtifact({ ...current, operation: 'list', offset: result.nextOffset! })));
      container.append(pagination);
    } else {
      const form = element('form', 'line-jump'); const label = element('label', '', '줄');
      const input = element('input'); input.type = 'number'; input.min = '1'; input.step = '1'; input.value = String(result.startLine); input.setAttribute('aria-label', '시작 줄');
      const go = element('button', '', '이동'); go.type = 'submit'; label.append(input); form.append(label, go);
      form.addEventListener('submit', event => { event.preventDefault(); const line = Number(input.value); if (Number.isSafeInteger(line) && line >= 1) navigateArtifact({ id: current.id, operation: 'read', ...(current.path ? { path: current.path } : {}), startLine: line }); });
      toolbar.append(form);
      const code = element('div', 'code-view'); code.setAttribute('role', 'region'); code.setAttribute('aria-label', 'Artifact 원문'); code.tabIndex = 0;
      const lines = result.content.split('\n'); if (lines.at(-1) === '') lines.pop();
      for (const [index, line] of lines.entries()) {
        const row = element('div', 'code-line'); const number = element('span', 'line-number', String(result.startLine + index)); number.setAttribute('aria-hidden', 'true');
        row.append(number, element('span', 'line-content', line.replace(/\r$/, ''))); code.append(row);
      }
      container.append(lines.length ? code : element('p', 'artifact-message', result.totalLines === 0 ? '빈 파일입니다.' : '이 위치에 더 읽을 내용이 없습니다.'));
      const pagination = element('div', 'artifact-pagination'); pagination.append(element('span', '', result.endLine === null ? '읽은 줄 없음' : `${result.startLine}–${result.endLine}줄`));
      if (result.startLine > 1) pagination.append(button('처음으로', () => navigateArtifact({ ...current, operation: 'read', startLine: 1 })));
      if (result.nextStartLine !== null) pagination.append(button('다음 줄', () => navigateArtifact({ ...current, operation: 'read', startLine: result.nextStartLine! })));
      container.append(pagination);
    }
  } catch (error) {
    if (version !== artifactVersion || !container.isConnected) return;
    container.replaceChildren(element('p', 'artifact-message error', error instanceof Error ? error.message : 'Artifact를 읽지 못했습니다.'), button('다시 읽기', () => void loadArtifact(container)));
  }
}
async function refresh(): Promise<void> {
  if (refreshing) { refreshPending = true; return; }
  refreshing = true;
  const expected = { project, filter, offset };
  const refreshButton = find<HTMLButtonElement>('#refresh'); refreshButton.disabled = true;
  try {
    const params = new URLSearchParams({ filter, limit: '50', offset: String(offset), ...(project ? { project } : {}) });
    const data = await api<MonitorOverview>(`/api/requests?${params}`);
    if (expected.project !== project || expected.filter !== filter || expected.offset !== offset) return;
    scopeLoading = false;
    renderOverview(data);
    const detailProject = detailPane.querySelector('.detail-project'); if (detailProject && selected) detailProject.textContent = projectName(selected.project);
    connection.className = 'connected'; connection.querySelector('span')!.textContent = '실시간'; connection.title = `마지막 확인 ${dateLabel(data.observedAt)}`;
    find('#list-error').hidden = true;
    await refreshDetail();
  } catch (error) {
    connection.className = 'disconnected'; connection.querySelector('span')!.textContent = '연결 끊김';
    const errorNode = find('#list-error'); errorNode.hidden = false;
    errorNode.textContent = '모니터에 연결하지 못했습니다. 자동으로 다시 연결합니다.';
    if (!overview || scopeLoading) requestList.replaceChildren(element('div', 'empty-state', error instanceof Error ? error.message : '모니터가 실행 중인지 확인해 주세요.'));
  } finally {
    refreshing = false; refreshButton.disabled = false;
    find<HTMLButtonElement>('#load-more').disabled = scopeLoading; find<HTMLButtonElement>('#newer').disabled = scopeLoading;
    if (refreshPending) { refreshPending = false; void refresh(); }
  }
}
document.querySelectorAll<HTMLButtonElement>('[data-filter]').forEach(node => node.addEventListener('click', () => { filter = node.dataset.filter as MonitorFilter; offset = 0; showScopeLoading(); void refresh(); }));
projectSelect.addEventListener('change', () => selectProject(projectSelect.value));
find('#refresh').addEventListener('click', () => void refresh());
find('#load-more').addEventListener('click', () => { offset += 50; showScopeLoading(); void refresh(); window.scrollTo({ top: 0 }); });
find('#newer').addEventListener('click', () => { offset = 0; showScopeLoading(); void refresh(); window.scrollTo({ top: 0 }); });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && selected) closeDetail(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
function readLocation(): void {
  const parts = location.hash.slice(1).split('/');
  try { if (parts.length === 2 && parts.every(Boolean)) openDetail(decodeURIComponent(parts[0]), decodeURIComponent(parts[1]), false); else if (selected) closeDetail(false); } catch { closeDetail(false); }
}
window.addEventListener('hashchange', readLocation);
readLocation();
void refresh();
setInterval(() => { if (!document.hidden) void refresh(); }, 2000);
setInterval(() => { if (!document.hidden) updateDurations(); }, 1000);
