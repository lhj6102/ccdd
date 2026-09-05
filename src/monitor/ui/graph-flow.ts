import type { GraphArtifactState, GraphCriticState } from '../../broker/graph.js';
import type { MonitorRequest } from '../types.js';
import type { GraphEdgePosition } from './graph-layout';

export interface ArtifactNodeData {
  artifact: GraphArtifactState;
  critics: GraphCriticState[];
  requests: Map<string, MonitorRequest>;
  statusLabel: string;
  accessibleLabel: string;
  selected: boolean;
  selectedRequestId?: string;
  vertical: boolean;
  hasInput: boolean;
  hasOutput: boolean;
}

export interface ArtifactEdgeData {
  route: GraphEdgePosition;
  connected: boolean;
}
