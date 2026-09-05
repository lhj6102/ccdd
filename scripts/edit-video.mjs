import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';

const out=resolve(process.env.CCDD_VIDEO_DIR||'output/video');
const ffmpeg=process.env.FFMPEG_PATH||'ffmpeg';
const font=process.env.CCDD_FONT||'/System/Library/Fonts/AppleSDGothicNeo.ttc';
const capture=JSON.parse(await readFile(join(out,'capture.json'),'utf8'));
if(capture.runs.length!==4||capture.pageErrors.length)throw new Error('A successful four-scenario recording is required');
try { const closing=JSON.parse(await readFile(join(out,'closing.json'),'utf8'));capture.timeline=capture.timeline.filter(x=>x.caption!=='요청 → 스냅샷 재현 → Artifact 도구 → 평가 → 영속 결과');capture.timeline.push(closing); }
catch(error) { if(error.code!=='ENOENT')throw error; }
const parts=join(out,'edited-parts');await mkdir(parts,{recursive:true});
const filterPath=value=>value.replaceAll('\\','/').replaceAll(':','\\:').replaceAll("'","'\\''");
const files=[],chapters=[];let elapsed=0;
for(const [index,item] of capture.timeline.entries()){
  const duration=item.end-item.start;if(duration<0.1)continue;
  const label=join(parts,`${index}.txt`),file=join(parts,`${String(index).padStart(3,'0')}.mp4`);
  await writeFile(label,item.caption);
  const filter=`setpts=(PTS-STARTPTS)/${item.speed},fps=30,pad=iw:ih+80:0:0:color=0x1d363a,drawtext=fontfile='${filterPath(font)}':textfile='${filterPath(label)}':fontcolor=0xf4f4ee:fontsize=25:x=(w-text_w)/2:y=h-52`;
  execFileSync(ffmpeg,['-hide_banner','-loglevel','error','-y','-ss',String(item.start),'-t',String(duration),'-i',join(out,item.source||'capture.webm'),'-an','-vf',filter,'-c:v','libx264','-preset','fast','-crf','20','-pix_fmt','yuv420p','-movflags','+faststart',file],{stdio:'inherit'});
  files.push(file);chapters.push({atSeconds:Number(elapsed.toFixed(2)),caption:item.caption,speed:item.speed});elapsed+=duration/item.speed;
}
const concat=join(parts,'concat.txt');await writeFile(concat,files.map(file=>`file '${file.replaceAll("'","'\\''")}'`).join('\n')+'\n');
execFileSync(ffmpeg,['-hide_banner','-loglevel','error','-y','-f','concat','-safe','0','-i',concat,'-c','copy','-movflags','+faststart',join(out,'CCDD-demo-ko.mp4')],{stdio:'inherit'});
const verification={recordedAt:capture.recordedAt,method:'Actual isolated Chrome UI recording; real Codex MCP reviews and actual Node tests. Only waiting intervals accelerated 6x with visible captions.',model:'gpt-6-astra',browserErrors:capture.pageErrors,scenarios:capture.runs.map(run=>({scenario:run.scenario,snapshotCommit:run.snapshotCommit,runId:run.id,status:run.status,requests:run.requests.map(request=>({id:request.id,criticId:request.criticId,status:request.status,snapshotCommit:request.snapshotCommit,profile:request.profile,result:request.result,error:request.error,blockedReason:request.blockedReason}))})),chapters};
await writeFile(join(out,'verification.json'),JSON.stringify(verification,null,2)+'\n');
console.log(JSON.stringify({video:join(out,'CCDD-demo-ko.mp4'),seconds:Math.round(elapsed),parts:files.length,verifiedScenarios:verification.scenarios.length}));
