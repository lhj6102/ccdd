import { stronglyConnectedComponents } from '../broker/graph.js';
import type { ProjectSnapshot } from './types.js';

export const gateTestHooks: { edge?: () => void } = {};
/** Direct condensation edges only. Entries are dependency-first, including SCC peers. */
export function criticGates(snapshot: Pick<ProjectSnapshot, 'config'>): Map<string, string[]> {
  const { artifacts, critics, relations } = snapshot.config;
  const components = stronglyConnectedComponents(Object.keys(artifacts), relations);
  const component = new Map(components.flatMap((ids, n) => ids.map(id => [id, n] as const)));
  const owned = components.map(() => [] as string[]);
  const gating = components.map(() => [] as string[]);
  for (const critic of critics) {
    const index = component.get(critic.target)!;
    owned[index].push(critic.id);
    if (!artifacts[critic.target].basis) gating[index].push(critic.id);
  }
  const dependencies = components.map(() => new Set<number>());
  for (const edge of relations) {
    gateTestHooks.edge?.();
    const consumer = component.get(edge.target)!, dependency = component.get(edge.source)!;
    if (consumer !== dependency) dependencies[consumer].add(dependency);
  }
  const result = new Map<string, string[]>();
  // Tarjan emits a component after its dependencies. No transitive closure is
  // materialized: a child observes its parent's gated state transitively.
  for (let index = 0; index < components.length; index++) {
    const direct = [...dependencies[index]].flatMap(dependency => gating[dependency]);
    for (const critic of owned[index]) result.set(critic, direct);
  }
  return result;
}
