import { readFile } from 'node:fs/promises';
import { defineArtifactSource, defineConfig, defineDataTool } from '@ccdd/core';
import type { JsonValue } from '@ccdd/core';

function scenarioData(value: JsonValue) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.name !== 'string' || typeof value.objective !== 'string'
    || !Array.isArray(value.criteria) || value.criteria.some(item => typeof item !== 'string')
    || !Array.isArray(value.details) || value.details.some(item => !item || typeof item !== 'object'
      || Array.isArray(item) || typeof item.id !== 'string' || typeof item.observation !== 'string')) {
    throw new Error('Expected a scenario with name, objective, criteria, and identified details.');
  }
  return value as { name: string; objective: string; criteria: string[]; details: { id: string; observation: string }[] };
}

const scenarioSource = defineArtifactSource({
  metadata: {
    preparation: 'read-only',
    identity: { kind: 'canonical-data', namespace: 'example/scenario', version: '1' },
  },
  async prepare(context) {
    if (typeof context.params !== 'string') throw new Error('Expected a scenario file path.');
    const data: JsonValue = JSON.parse(await readFile(await context.resolvePath(context.params), 'utf8'));
    scenarioData(data);
    return { data };
  },
});

const overview = defineDataTool({
  metadata: {
    description: 'Read the objective, criteria, and available detail IDs of {artifactName}.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    resultKinds: ['json'],
    observation: 'content',
  },
  execute(context) {
    const data = scenarioData(context.readData());
    return {
      content: [{ type: 'json', data: {
        name: data.name, objective: data.objective, criteria: data.criteria,
        detailIds: data.details.map(detail => detail.id),
      } }],
      observation: { kind: 'content' },
    };
  },
});

const detail = defineDataTool({
  metadata: {
    description: 'Read one identified detail from the captured {artifactName} scenario.',
    inputSchema: {
      type: 'object', properties: { id: { type: 'string', minLength: 1 } },
      required: ['id'], additionalProperties: false,
    },
    resultKinds: ['json'],
    observation: 'content',
  },
  execute(context, args) {
    const found = scenarioData(context.readData()).details.find(item => item.id === args.id);
    if (!found) throw new Error('Unknown scenario detail.');
    return { content: [{ type: 'json', data: found }], observation: { kind: 'content' } };
  },
});

export default defineConfig({
  artifactSources: { scenario: scenarioSource },
  artifactTypes: {
    scenario: { agentTools: { overview, detail }, humanTools: { overview, detail } },
  },
  artifacts: {
    checkout: { kind: 'generated', type: 'scenario', source: 'scenario', params: 'scenarios/checkout.json' },
    search: { kind: 'generated', type: 'scenario', source: 'scenario', params: 'scenarios/search.json' },
  },
  critics: [
    {
      id: 'checkout-review', title: 'Review the checkout scenario', target: 'checkout', deps: [],
      profile: { kind: 'human' },
      payload: { instruction: 'Read the overview of {checkout}, then inspect every listed detail. Decide whether the observations satisfy each criterion. Cite detail IDs and explain missing or contradictory evidence.' },
    },
    {
      id: 'search-review', title: 'Review the search scenario', target: 'search', deps: [],
      profile: { kind: 'human' },
      payload: { instruction: 'Read the overview of {search}, then inspect every listed detail. Decide whether the observations satisfy each criterion. Cite detail IDs and explain missing or contradictory evidence.' },
    },
  ],
});
