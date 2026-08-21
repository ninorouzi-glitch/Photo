import { expect, test, type ConsoleMessage } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { CRITERIA } from '../src/core/deviation.ts';

const fixture = (name: string) =>
  fileURLToPath(new URL(`../test/fixtures/out/${name}`, import.meta.url));

const FILES = [
  '01-Referenz.png',
  '02-nah-dran.png',
  '03-dunkel-kühl.png',
  '04-flau.png',
  '05-quer-rauschig.png',
].map(fixture);

/**
 * A-05: ein Set aus fünf Bildern von der Ablage bis zum Export, ohne
 * Konsolenfehler. Das ist der Durchlauf, der die vier Stufen als Ganzes prüft —
 * die Einzelteile hängen an den Vitest-Prüfungen.
 */
test('Durchlauf von der Ablage bis zum Export', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m: ConsoleMessage) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');

  // ── Stufe 01 ──
  await expect(page.getByRole('button', { name: 'Set analysieren' })).toBeDisabled();
  await page.locator('input[type=file]').setInputFiles(FILES);
  await expect(page.locator('.thumb:not(.busy)')).toHaveCount(5, { timeout: 15_000 });

  // F-01: Reihenfolge der Auswahl
  await expect(page.locator('.thumb .name')).toHaveText([
    '01-Referenz', '02-nah-dran', '03-dunkel-kühl', '04-flau', '05-quer-rauschig',
  ]);

  // F-04: Entfernen korrigiert die Nummerierung ohne Neuladen
  await page.locator('.thumb .remove').nth(1).click();
  await expect(page.locator('.thumb')).toHaveCount(4);
  await expect(page.locator('.thumb .n')).toHaveText(['01', '02', '03', '04']);
  await page.locator('input[type=file]').setInputFiles([fixture('02-nah-dran.png')]);
  await expect(page.locator('.thumb:not(.busy)')).toHaveCount(5);

  await page.getByRole('button', { name: 'Set analysieren' }).click();

  // ── Stufe 02 ──
  await expect(page.locator('table.matrix')).toBeVisible();
  // Gegen CRITERIA.length, nicht gegen eine feste Zahl: geprüft wird, dass die
  // Matrix jedes Kriterium zeigt. Mit der festen 7 brach dieser Test, sobald
  // tint als Achse dazukam — und er bräche bei der nächsten wieder.
  await expect(page.locator('table.matrix tbody tr')).toHaveCount(CRITERIA.length);
  await expect(page.locator('table.matrix thead th')).toHaveCount(6); // Kriterienspalte + 5
  await expect(page.locator('.findings li').first()).toContainText('als das Set.');

  // F-06: der Seitenkörper scrollt nicht seitwärts
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);

  // F-07: die Zelle ist per Tastatur erreichbar und gibt denselben Wert aus wie
  // per Maus. Geprüft wird die berechnete Deckkraft — `toBeVisible` würde ein
  // Element mit `opacity: 0` durchgehen lassen und die Zusicherung wertlos machen.
  const cell = page.locator('table.matrix .cell').first();
  const value = cell.locator('.val');
  const opacity = () => value.evaluate((e) => getComputedStyle(e).opacity);
  expect(await opacity()).toBe('0');

  await page.locator('table.matrix .cell').first().evaluate((e) => (e as HTMLElement).blur());
  await cell.focus();
  expect(await opacity()).toBe('1');
  const perTastatur = await value.textContent();

  await cell.evaluate((e) => (e as HTMLElement).blur());
  await cell.hover();
  expect(await opacity()).toBe('1');
  expect(await value.textContent()).toBe(perTastatur);
  expect(await cell.getAttribute('aria-label')).toContain(perTastatur!);

  await page.getByRole('button', { name: 'Angleichen', exact: true }).click();

  // ── Stufe 03 ──
  await expect(page.locator('.pair')).toHaveCount(5);

  // F-14: das Ankerbild zeigt überall null
  await page.locator('#reference').selectOption({ index: 2 });
  const anchorValues = await page.locator('.pair').nth(1).locator('.devlist .v').allTextContents();
  expect(anchorValues.every((v) => v.startsWith('±0,00'))).toBe(true);
  await page.locator('#reference').selectOption('median');

  // F-13/A-03: bei 0 % ist das Ergebnis der reine Zuschnitt
  await page.locator('#strength').fill('0');
  await expect(page.locator('.strength-value')).toHaveText('0 %');
  // Das Ergebnis-Canvas des dritten Paares — nicht irgendein Canvas: seit die
  // Originalseite ebenfalls gezeichnet wird, stehen je Paar zwei davon.
  const ergebnis = () =>
    page.evaluate(() => {
      const pair = document.querySelectorAll('.pair')[2]!;
      const c = pair.querySelectorAll('canvas')[1] as HTMLCanvasElement;
      return c.getContext('2d')!.getImageData(0, 0, 4, 4).data.join(',');
    });

  const neutral = await ergebnis();
  await page.locator('#strength').fill('70');
  const corrected = await ergebnis();
  expect(corrected).not.toBe(neutral);

  await page.getByRole('button', { name: 'Reihe ansehen' }).click();

  // ── Stufe 04 ──
  await expect(page.locator('.carousel figure')).toHaveCount(5);
  await expect(page.locator('.grid3 canvas')).toHaveCount(5);

  // F-21: der Vorschlag ist deterministisch
  const before = await page.locator('.carousel figcaption').allTextContents();
  await page.getByRole('button', { name: 'Reihenfolge vorschlagen' }).click();
  const first = await page.locator('.carousel figcaption').allTextContents();
  await page.getByRole('button', { name: 'Reihenfolge vorschlagen' }).click();
  expect(await page.locator('.carousel figcaption').allTextContents()).toEqual(first);
  await page.getByRole('button', { name: 'Ursprüngliche Reihenfolge' }).click();
  expect(await page.locator('.carousel figcaption').allTextContents()).toEqual(before);

  // F-22: Export in einen Ordner. Der native Dialog lässt sich nicht bedienen,
  // deshalb steht hier ein Verzeichnis-Handle, das die Blobs einsammelt — der
  // Weg durch renderAll() und die JPEG-Kodierung ist derselbe.
  await page.evaluate(() => {
    const saved: { name: string; blob: Blob }[] = [];
    (window as unknown as { __saved: typeof saved }).__saved = saved;
    (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = async () => ({
      getFileHandle: async (name: string) => ({
        createWritable: async () => ({
          write: async (blob: Blob) => { saved.push({ name, blob }); },
          close: async () => {},
        }),
      }),
    });
  });

  await page.getByRole('button', { name: /Bilder exportieren/ }).click();
  await expect(page.locator('.actions .note').last()).toContainText('gespeichert', { timeout: 30_000 });

  const exported = await page.evaluate(async () => {
    const saved = (window as unknown as { __saved: { name: string; blob: Blob }[] }).__saved;
    return Promise.all(
      saved.map(async (f) => {
        const bmp = await createImageBitmap(f.blob);
        const size = { name: f.name, w: bmp.width, h: bmp.height, type: f.blob.type };
        bmp.close();
        return size;
      }),
    );
  });

  expect(exported).toHaveLength(5);
  for (const f of exported) {
    expect(f.type).toBe('image/jpeg');
    expect(f.w / f.h).toBeCloseTo(0.8, 3); // 4:5, exakt
  }

  // Standard ist die volle Auflösung: die Ausgabe hat genau die Pixel, die im
  // Zuschnitt des hochgeladenen Bildes stecken. Die vier Hochkantbilder messen
  // 800 × 1000 und füllen 4:5 schon aus; das Querformat (800 × 450) wird an der
  // Breite beschnitten. Kein Bild wird verkleinert, keines vergrößert.
  expect(exported.map((f) => `${f.w}×${f.h}`)).toEqual([
    '800×1000', '800×1000', '800×1000', '360×450', '800×1000',
  ]);

  // Bild 2 wurde oben entfernt und danach wieder angehängt — die Nummerierung
  // folgt der Position im Post, nicht dem ursprünglichen Dateinamen.
  expect(exported.map((f) => f.name)).toEqual([
    '01_01-Referenz.jpg', '02_03-dunkel-kühl.jpg', '03_04-flau.jpg',
    '04_05-quer-rauschig.jpg', '05_02-nah-dran.jpg',
  ]);

  // ── F-22: die Instagram-Größe gibt es weiterhin, jetzt als Wahl ──
  await page.getByRole('button', { name: 'Zurück zum Angleichen' }).click();
  await page.getByRole('button', { name: '1080 px', exact: true }).click();
  await page.getByRole('button', { name: 'Reihe ansehen' }).click();
  await expect(page.locator('#stage-4 .sub').first()).toContainText('1080 × 1350 px');

  await page.evaluate(() => {
    (window as unknown as { __saved: unknown[] }).__saved.length = 0;
  });
  await page.getByRole('button', { name: /Bilder exportieren/ }).click();
  await expect(page.locator('.actions .note').last()).toContainText('gespeichert', { timeout: 30_000 });

  const klein = await page.evaluate(async () => {
    const saved = (window as unknown as { __saved: { name: string; blob: Blob }[] }).__saved;
    return Promise.all(saved.map(async (f) => {
      const bmp = await createImageBitmap(f.blob);
      const size = { w: bmp.width, h: bmp.height };
      bmp.close();
      return size;
    }));
  });
  expect(klein).toHaveLength(5);
  for (const f of klein) expect(f).toEqual({ w: 1080, h: 1350 });

  expect(errors).toEqual([]);
});
