import {chromium} from 'playwright';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

// Captures actual UI interactions and actual asynchronous provider results.
// Editing uses this timeline; no API responses or verdicts are replaced.
const base=process.env.CCDD_URL||'http://127.0.0.1:4318';
const out=resolve(process.env.CCDD_VIDEO_DIR||'output/video');
await mkdir(out,{recursive:true});
const launch=process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{channel:'chrome'};
const browser=await chromium.launch({headless:true,...launch});
const context=await browser.newContext({viewport:{width:1600,height:1000},deviceScaleFactor:1,recordVideo:{dir:out,size:{width:1600,height:1000}}});
const page=await context.newPage();
const video=page.video();
const timeline=[],runs=[],pageErrors=[];
page.on('pageerror',error=>pageErrors.push(error.message));
const started=Date.now();
let active;
function segment(caption,speed=1){const now=(Date.now()-started)/1000;if(active){active.end=now;timeline.push(active);}active={start:now,caption,speed};}
const hold=ms=>page.waitForTimeout(ms);
async function save(){await writeFile(resolve(out,'capture.json'),JSON.stringify({base,recordedAt:new Date().toISOString(),viewport:{width:1600,height:1000},timeline,runs,pageErrors},null,2));}
async function click(id){await page.getByTestId(id).click();await hold(350);}
async function topInspector(){await page.locator('#inspector-body').evaluate(el=>{el.scrollTop=0;});}
try{
  await page.goto(base,{waitUntil:'networkidle'});
  await page.getByTestId('scenario-baseline').waitFor();
  segment('CCDD · Critic 중계 브로커와 Artifact Runner');await hold(4000);
  segment('Why → Spec → Tests → Implementation · 조합 없는 한 방향 의존 그래프');await hold(5000);
  for(const scenario of [
    {id:'baseline',intro:'01 정상 기준 · Why에서 구현까지 최대 3개로 일치',verdict:'GREEN',states:['GREEN','GREEN','GREEN'],result:'Agent 검토 2개와 실제 테스트 런타임을 모두 통과'},
    {id:'why-change',intro:'02 Why만 변경 · 2개를 원하지만 Spec은 아직 3개',verdict:'RED',states:['RED','BLOCKED','BLOCKED'],result:'Spec이 Why에 부합하지 않아 RED · 후속 평가는 실행하지 않음'},
    {id:'runtime-failure',intro:'03 구현 불일치 · Spec과 Tests는 2개, 구현은 아직 3개',verdict:'RED',states:['GREEN','GREEN','RED'],result:'문서와 테스트 검토는 GREEN · 실제 구현 테스트는 실패'},
    {id:'fixed',intro:'04 수정 완료 · 구현도 2개로 맞춘 새로운 커밋',verdict:'GREEN',states:['GREEN','GREEN','GREEN'],result:'새 스냅샷을 처음부터 재평가 · 세 단계 모두 GREEN'}
  ]){
    segment(scenario.intro);await click(`scenario-${scenario.id}`);await hold(3500);
    const response=page.waitForResponse(r=>r.url()===base+'/api/runs'&&r.request().method()==='POST');
    await click('submit-run');const submitted=await(await response).json();
    if(!submitted.id)throw new Error('Missing persisted run handle');
    await hold(3500);
    segment('실제 Agent 평가 중 · 대기 구간 6배속',6);
    let run,deadline=Date.now()+600000;
    while(Date.now()<deadline){run=await context.request.get(base+'/api/runs/'+submitted.id).then(r=>r.json());if(['GREEN','RED','ERROR'].includes(run.status))break;await hold(1500);}
    if(!run||run.status!==scenario.verdict||JSON.stringify(run.requests.map(x=>x.status))!==JSON.stringify(scenario.states))throw new Error(`Unexpected result for ${scenario.id}: ${JSON.stringify(run?.requests.map(x=>({status:x.status,result:x.result,error:x.error})))}`);
    for(const request of run.requests.filter(x=>x.profile.kind==='agent'&&x.result))if(!request.result.toolCalls?.length)throw new Error('Missing actual artifact tool audit');
    runs.push({scenario:scenario.id,...run});
    await page.locator('#run-status').filter({hasText:run.status}).waitFor({timeout:15000});
    await hold(1600);
    segment(scenario.result);await topInspector();await hold(6000);
    await page.screenshot({path:resolve(out,`${scenario.id}.png`)});
    if(scenario.id==='baseline'){
      segment('Artifact Runner가 요청의 Artifact를 읽는 Viewer 진입점을 Agent 도구로 전달');
      await click('critic-1');await click('tab-request');await topInspector();await hold(4000);
      await click('open-artifact-why');await page.locator('.artifact-markdown').waitFor();await hold(4500);await click('close-artifact');
      segment('리뷰는 요청 커밋의 worktree에서 실행 · 실제 Viewer 호출 내역을 보관');
      await page.locator('.tool-row').last().scrollIntoViewIfNeeded();await hold(6000);
      await click('critic-2');await topInspector();await hold(3000);
      await click('open-artifact-tests');await page.locator('[data-artifact-file="rank.test.mjs"]').click();await page.locator('.artifact-source').filter({hasText:'assert'}).waitFor();await hold(5000);await click('close-artifact');
      await click('tab-result');await topInspector();
    }
    if(scenario.id==='why-change'){
      segment('근거 확인 · Why의 최대 2개와 Spec의 최대 3개가 충돌');
      await click('critic-1');await topInspector();await hold(4500);
      await click('open-artifact-why');await page.locator('.artifact-markdown').waitFor();await hold(4000);await click('close-artifact');
    }
    if(scenario.id==='runtime-failure'){
      segment('Code Runner가 snapshot의 테스트를 실제 실행 · exit 1과 실패 근거');
      await click('critic-3');await topInspector();await hold(4500);
      await page.getByTestId('runtime-output').locator('summary').click();await page.locator('.log-output').scrollIntoViewIfNeeded();await hold(6000);
      await topInspector();
    }
    await save();
  }
  segment('브로커에 보관된 이전 실행 · 새 커밋의 GREEN이 과거 RED를 덮어쓰지 않음');
  await click(`history-${runs[1].id}`);await topInspector();await hold(5000);
  await click(`history-${runs[3].id}`);await topInspector();await page.evaluate(()=>window.scrollTo(0,0));await hold(4000);
  segment('요청 → 스냅샷 재현 → Artifact 도구 → 평가 → 영속 결과');await hold(5000);
  await page.screenshot({path:resolve(out,'poster.png')});
  if(pageErrors.length)throw new Error(pageErrors.join('\n'));
  segment('END');active=null;await save();
  console.log(JSON.stringify({ok:true,runs:runs.map(r=>({scenario:r.scenario,id:r.id,status:r.status})),raw:resolve(out,'capture.webm')}));
}finally{
  if(active){active.end=(Date.now()-started)/1000;timeline.push(active);}await save();
  await context.close();await video.saveAs(resolve(out,'capture.webm'));await browser.close();
}
