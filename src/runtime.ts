// Shared singletons set up by the plugin entry (index.tsx) so that both the
// Quick Access panel and the full-page Studio can reach them without importing
// index.tsx (which would create an import cycle).

import type { SoundPlayer } from './sound';

export const runtime: { sound?: SoundPlayer } = {};
