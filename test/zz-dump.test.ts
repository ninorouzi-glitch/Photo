import { test } from 'vitest';
import { appendFileSync, writeFileSync } from 'node:fs';
import { testSet } from './fixtures/generate.ts';
import { analyzeFull } from '../src/core/stats.ts';

test('dump', () => {
  const out = '/tmp/dump.txt';
  writeFileSync(out, '');
  for (const t of testSet()) {
    const s = analyzeFull(t.frame) as any;
    appendFileSync(out, [
      t.id,
      'p50', s.p50.toFixed(3),
      'contrast', s.contrast.toFixed(2),
      'warmth', s.warmth.toFixed(5),
      'tint', s.tint.toFixed(5),
      'sat', s.saturation.toFixed(5),
      'sharp', s.sharpness.toFixed(4),
      'noise', s.noise.toFixed(4),
      'clip', s.clippedRatio === undefined ? '-' : s.clippedRatio.toFixed(5),
      'pal', s.palette.join(','),
    ].join(' ') + '\n');
  }
});
