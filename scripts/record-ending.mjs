import {chromium} from 'playwright';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const out=resolve(process.env.CCDD_VIDEO_DIR||'output/video');
await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{channel:'chrome'})});
const context=await browser.newContext({viewport:{width:1600,height:1000},recordVideo:{dir:out,size:{width:1600,height:1000}}});
const page=await context.newPage(),video=page.video(),began=Date.now();
try{
  await page.goto(process.env.CCDD_URL||'http://127.0.0.1:4317',{waitUntil:'networkidle'});
  await page.locator('#run-status').filter({hasText:'GREEN'}).waitFor();
  await page.getByTestId('critic-3').click();
  await page.evaluate(()=>window.scrollTo(0,0));
  await page.waitForTimeout(1000);
  const start=(Date.now()-began)/1000;
  await page.screenshot({path:resolve(out,'poster.png')});
  await page.waitForTimeout(7000);
  await writeFile(resolve(out,'closing.json'),JSON.stringify({start,end:(Date.now()-began)/1000,source:'closing.webm',caption:'브로커 재시작 후에도 보존된 결과 · 요청 → 스냅샷 → 도구 → 평가 → 영속 결과',speed:1},null,2));
}finally{await context.close();await video.saveAs(resolve(out,'closing.webm'));await browser.close();}
