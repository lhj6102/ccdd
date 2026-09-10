import { defineConfig } from '@ccdd/core';
import { agent, human } from '@ccdd/default-tools';

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
      id: 'preview-review', title: 'Image visibility', target: 'preview', deps: [],
      profile: { kind: 'agent', provider: 'openai-codex', model: 'gpt-6-astra', reasoning: 'medium' },
      payload: { instruction: 'Check whether {preview} has a bright center and an orange ring distinguishable from the dark background. Review the image itself; matching the effect specification is outside this review.' },
    },
    {
      id: 'explosion-review', title: 'Match the effect description and preview', target: 'explosion', deps: ['preview'],
      profile: { kind: 'agent', provider: 'openai-codex', model: 'gpt-6-astra', reasoning: 'medium' },
      payload: { instruction: 'Observe every member of {explosion} and evaluate whether {preview} matches the static appearance specified in {effect}. Animation timing and actual VFX runtime behavior are outside the scope of this static example.' },
    },
    {
      id: 'explosion-human', title: 'Review the group on the desktop', target: 'explosion', deps: ['preview'],
      profile: { kind: 'human' },
      payload: { instruction: 'Open the document and image in {explosion} with their desktop programs, compare them, and submit your verdict.' },
    },
  ],
});
