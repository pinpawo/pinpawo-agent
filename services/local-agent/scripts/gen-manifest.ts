/**
 * Post-build script: generates dist/capability-manifest.json from the
 * built-in capability registry.  Run after tsup via "build" script.
 *
 * The manifest is bundled into the macOS app and read by the Swift UI
 * to populate the Capabilities settings pane without requiring the
 * agent to be running.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILT_IN_CAPABILITY_REGISTRY } from '../src/capabilityRegistry';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(__dirname, '../dist');
const outPath = resolve(outDir, 'capability-manifest.json');

mkdirSync(outDir, { recursive: true });

const manifest = {
  version: 1,
  capabilities: BUILT_IN_CAPABILITY_REGISTRY,
};

writeFileSync(outPath, JSON.stringify(manifest, null, 2), 'utf-8');
console.log(`[gen-manifest] wrote ${outPath} (${manifest.capabilities.length} capabilities)`);
