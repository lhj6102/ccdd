import { defineConfig } from '@lhj6102/ccdd';
import { agent, human } from '@lhj6102/ccdd-default-tools';

export default defineConfig({
  artifacts: {
    effect: { type: 'markdown', path: 'effect.md' },
    preview: { type: 'image', path: 'preview.png' },
    explosion: { kind: 'group', members: ['effect', 'preview'] },
  },
  artifactTypes: {
    markdown: {
      agentTools: { read: agent.text.read() },
      humanTools: { open: human.desktop.open() },
    },
    image: {
      agentTools: { view_image: agent.image.view() },
      humanTools: { open: human.desktop.open() },
    },
  },
  critics: [
    {
      id: 'preview-review', title: '이미지 자체의 시인성', target: 'preview', deps: [],
      profile: { kind: 'agent', provider: 'openai-codex', model: 'gpt-6-astra', reasoning: 'medium' },
      payload: { instruction: '{preview}에 어두운 배경과 구분되는 밝은 중심과 주황색 고리가 보이는지 확인하세요. 이 검토는 이미지 자체에 관한 것이며 효과 명세와의 일치는 평가하지 않습니다.' },
    },
    {
      id: 'explosion-review', title: '효과 설명과 프리뷰의 일치', target: 'explosion', deps: ['preview'],
      profile: { kind: 'agent', provider: 'openai-codex', model: 'gpt-6-astra', reasoning: 'medium' },
      payload: { instruction: '{explosion}의 모든 구성원을 관측하여 {effect}에 명시된 정적 외형과 {preview}가 일치하는지 평가하세요. 애니메이션 타이밍이나 실제 VFX 런타임 동작은 이 정적 예제의 평가 대상이 아닙니다.' },
    },
    {
      id: 'explosion-human', title: '데스크톱에서 그룹 검토', target: 'explosion', deps: ['preview'],
      profile: { kind: 'human' },
      payload: { instruction: '{explosion}의 문서와 이미지를 각각 데스크톱 프로그램으로 열어 비교한 뒤 판정을 제출하세요.' },
    },
  ],
});
