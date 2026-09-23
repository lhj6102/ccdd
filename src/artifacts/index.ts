import type { ArtifactDefinition } from '../definitions.js';
import type { ReviewToolCall } from '../contracts.js';
export interface ArtifactReference extends ArtifactDefinition { id: string }
export interface ArtifactReferenceMetadata { id: string; path: string }
export type ArtifactToolCall = ReviewToolCall;
export { assertArtifactAudience } from './types.js';
export type { ArtifactAudience } from './types.js';
