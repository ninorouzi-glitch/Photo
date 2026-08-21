import { mkdirSync, writeFileSync } from 'node:fs';
import { test } from 'vitest';
import { testSet } from './generate.ts';
import { encodePng } from './png.ts';

/**
 * Schreibt die fünf Testbilder aus §13 als PNG nach test/fixtures/out/.
 * Läuft als Test mit, damit die Dateien nie veralten.
 */
test('Testbilder als Dateien schreiben', () => {
  const dir = new URL('./out/', import.meta.url).pathname;
  mkdirSync(dir, { recursive: true });
  for (const { id, label, frame } of testSet()) {
    const name = `${id}-${label.replace(/[^a-zäöüß0-9]+/gi, '-')}.png`;
    writeFileSync(dir + name, encodePng(frame));
  }
});
