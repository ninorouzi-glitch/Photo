import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const fixture = (name: string) =>
  fileURLToPath(new URL(`../test/fixtures/out/${name}`, import.meta.url));

const NAMES = [
  '01-Referenz.png', '02-nah-dran.png', '03-dunkel-kühl.png',
  '04-flau.png', '05-quer-rauschig.png',
];

const FIVE = NAMES.map(fixture);

/** Playwright darf Pfade und Puffer nicht mischen — für gemischte Sets alles als Puffer. */
const asBuffers = (n = NAMES.length) =>
  NAMES.slice(0, n).map((name) => ({
    name,
    mimeType: 'image/png',
    buffer: readFileSync(fixture(name)),
  }));

test('F-06: bei 20 Bildern bleibt die Kriterienspalte stehen', async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');

  await page.locator('input[type=file]').setInputFiles([...FIVE, ...FIVE, ...FIVE, ...FIVE]);
  await expect(page.locator('.thumb:not(.busy)')).toHaveCount(20, { timeout: 30_000 });

  // F-02: die Obergrenze greift
  await page.locator('input[type=file]').setInputFiles(FIVE);
  await expect(page.locator('.thumb')).toHaveCount(20);
  await expect(page.locator('.note.alert')).toContainText('über der Obergrenze von 20');

  await page.getByRole('button', { name: 'Set analysieren' }).click();
  await expect(page.locator('table.matrix thead th')).toHaveCount(21);

  // Der Seitenkörper scrollt nicht seitwärts …
  const bodyOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(bodyOverflow).toBeLessThanOrEqual(0);

  // … die Matrix in ihrem eigenen Container schon.
  const scroller = page.locator('.matrix-scroll');
  expect(await scroller.evaluate((e) => e.scrollWidth - e.clientWidth)).toBeGreaterThan(0);

  // Und die Zeilenbeschriftung bleibt beim Scrollen sichtbar.
  const label = page.locator('table.matrix tbody th').first();
  const before = (await label.boundingBox())!.x;
  await scroller.evaluate((e) => { e.scrollLeft = e.scrollWidth; });
  const after = (await label.boundingBox())!.x;
  expect(Math.abs(after - before)).toBeLessThan(2);
  await expect(label).toBeVisible();
});

test('§12: unlesbare und nicht unterstützte Dateien werden übersprungen', async ({ page }) => {
  await page.goto('/');

  await page.locator('input[type=file]').setInputFiles([
    ...asBuffers(2),
    { name: 'notizen.txt', mimeType: 'text/plain', buffer: Buffer.from('kein Bild') },
    { name: 'kaputt.png', mimeType: 'image/png', buffer: Buffer.from('nicht wirklich ein PNG') },
  ]);

  // Die übrigen Bilder werden geladen …
  await expect(page.locator('.thumb:not(.busy)')).toHaveCount(2, { timeout: 15_000 });
  // … und ein Hinweis nennt, was fehlt.
  await expect(page.locator('.note.alert')).toContainText('kaputt');
  await expect(page.locator('.note.alert')).toContainText('nicht unterstütztem Format');
  await expect(page.getByRole('button', { name: 'Set analysieren' })).toBeEnabled();
});

test('§12: über 50 Megapixel gibt es einen Hinweis statt eines Absturzes', async ({ page }) => {
  test.slow();
  await page.goto('/');

  const oversized = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 8000; c.height = 7000; // 56 MP
    const x = c.getContext('2d')!;
    x.fillStyle = '#446688';
    x.fillRect(0, 0, c.width, c.height);
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', 0.6));
    c.width = 1; c.height = 1;
    const buf = await blob!.arrayBuffer();
    return [...new Uint8Array(buf)];
  });

  await page.locator('input[type=file]').setInputFiles([
    ...asBuffers(2),
    { name: 'riesig.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(oversized) },
  ]);

  await expect(page.locator('.thumb:not(.busy)')).toHaveCount(2, { timeout: 30_000 });
  await expect(page.locator('.note.alert')).toContainText('50 Megapixel');
});

test('§15: Format und Stärke überleben die Sitzung, die Bilder nicht', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type=file]').setInputFiles(FIVE);
  await expect(page.locator('.thumb:not(.busy)')).toHaveCount(5, { timeout: 15_000 });
  await page.getByRole('button', { name: 'Set analysieren' }).click();
  await page.getByRole('button', { name: 'Angleichen', exact: true }).click();

  await page.getByRole('button', { name: '1:1', exact: true }).click();
  await page.getByRole('button', { name: '1080 px', exact: true }).click();
  await page.locator('#strength').fill('35');
  await page.locator('.switches input').nth(3).uncheck(); // Korn aus

  await page.reload();

  // P5: die Bilder sind weg, nur die Einstellungen sind geblieben.
  await expect(page.locator('.thumb')).toHaveCount(0);
  await page.locator('input[type=file]').setInputFiles(FIVE);
  await expect(page.locator('.thumb:not(.busy)')).toHaveCount(5, { timeout: 15_000 });
  await page.getByRole('button', { name: 'Set analysieren' }).click();
  await page.getByRole('button', { name: 'Angleichen', exact: true }).click();

  await expect(page.getByRole('button', { name: '1:1', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: '1080 px', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.strength-value')).toHaveText('35 %');
  await expect(page.locator('.switches input').nth(3)).not.toBeChecked();
  await expect(page.locator('.pane h3').nth(1)).toContainText('1:1');
});

test('F-23: ohne Schreibrecht erscheinen die fertigen Bilder zum Sichern', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type=file]').setInputFiles(FIVE.slice(0, 3));
  await expect(page.locator('.thumb:not(.busy)')).toHaveCount(3, { timeout: 15_000 });
  await page.getByRole('button', { name: 'Set analysieren' }).click();
  await page.getByRole('button', { name: 'Angleichen', exact: true }).click();
  await page.getByRole('button', { name: 'Reihe ansehen' }).click();

  // Weder Verzeichniswahl noch Download möglich — die letzte Stufe muss tragen.
  await page.evaluate(() => {
    (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker = undefined;
    HTMLAnchorElement.prototype.click = function () {
      throw new Error('Downloads sind hier gesperrt');
    };
  });

  await page.getByRole('button', { name: /Bilder exportieren/ }).click();
  await expect(page.locator('.actions .note').last()).toContainText('zum Sichern', { timeout: 30_000 });
  await expect(page.locator('.export-list figure')).toHaveCount(3);
  await expect(page.locator('.export-list figcaption').first()).toHaveText(/^01_/);
});

/**
 * Ein Schirm mit doppelter Pixeldichte — der Fall, für den die Vorschau gebaut
 * ist. Auf einem 1×-Schirm wäre nichts von alldem zu sehen.
 */
test.describe('Vorschau auf einem Retina-Schirm', () => {
  test.use({ deviceScaleFactor: 2 });

  test('die Vorschau zeigt Gerätepixel, nicht CSS-Pixel', async ({ page }) => {
    await page.goto('/');
    await page.locator('input[type=file]').setInputFiles(FIVE.slice(0, 3));
    await expect(page.locator('.thumb:not(.busy)')).toHaveCount(3, { timeout: 15_000 });
    await page.getByRole('button', { name: 'Set analysieren' }).click();
    await page.getByRole('button', { name: 'Angleichen', exact: true }).click();

    // Ergebnis und Original stehen nebeneinander und müssen dieselbe Dichte
    // haben — sonst vergleicht man zwei verschiedene Auflösungen miteinander.
    const dichte = await page.evaluate(() => {
      const pane = document.querySelectorAll('.pair')[0]!;
      const [original, ergebnis] = [...pane.querySelectorAll('canvas')];
      return [original!, ergebnis!].map((c) => c.width / c.getBoundingClientRect().width);
    });
    for (const d of dichte) expect(d).toBeGreaterThan(1.5);

    // F-16: am Regler läuft zuerst die schnelle Fassung, damit das
    // 150-ms-Budget hält — und kurz danach wird scharf nachgezogen.
    const verlauf = await page.evaluate(async () => {
      const slider = document.getElementById('strength') as HTMLInputElement;
      const pair = document.querySelectorAll('.pair')[0]!;
      const canvas = pair.querySelectorAll('canvas')[1] as HTMLCanvasElement;
      slider.value = '90';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      const schnell = canvas.width;
      await new Promise((r) => setTimeout(r, 600));
      return { schnell, scharf: canvas.width };
    });
    expect(verlauf.scharf).toBeGreaterThan(verlauf.schnell);
  });
});

test('F-12: ein eigenes Zielformat trägt bis in die Datei', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type=file]').setInputFiles(FIVE.slice(0, 3));
  await expect(page.locator('.thumb:not(.busy)')).toHaveCount(3, { timeout: 15_000 });
  await page.getByRole('button', { name: 'Set analysieren' }).click();
  await page.getByRole('button', { name: 'Angleichen', exact: true }).click();

  await page.getByRole('button', { name: 'Eigenes', exact: true }).click();
  await page.locator('#ratio-w').fill('16');
  await page.locator('#ratio-h').fill('9');

  // Die Überschrift des Ergebnisses nennt das gerechnete Format, ohne Neuladen.
  await expect(page.locator('.pair').first().locator('h3').nth(1)).toHaveText('Ergebnis, 16:9');
  // 16:9 sind 1,78 und liegen damit noch innerhalb dessen, was Instagram
  // stehen lässt (0,8 bis 1,91) — der Hinweis nennt nur die Zahl.
  await expect(page.locator('.ratio-note')).toHaveText('1,78:1');

  const vorschau = await page.evaluate(() => {
    const c = document.querySelectorAll('.pair')[0]!.querySelectorAll('canvas')[1] as HTMLCanvasElement;
    return c.width / c.height;
  });
  expect(vorschau).toBeCloseTo(16 / 9, 2);

  await page.getByRole('button', { name: 'Reihe ansehen' }).click();
  await page.evaluate(() => {
    const saved: Blob[] = [];
    (window as unknown as { __saved: Blob[] }).__saved = saved;
    (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = async () => ({
      getFileHandle: async () => ({
        createWritable: async () => ({
          write: async (b: Blob) => { saved.push(b); },
          close: async () => {},
        }),
      }),
    });
  });
  await page.getByRole('button', { name: /Bilder exportieren/ }).click();
  await expect(page.locator('.actions .note').last()).toContainText('gespeichert', { timeout: 30_000 });

  const masse = await page.evaluate(async () => {
    const saved = (window as unknown as { __saved: Blob[] }).__saved;
    return Promise.all(saved.map(async (b) => {
      const bmp = await createImageBitmap(b);
      const m = { w: bmp.width, h: bmp.height };
      bmp.close();
      return m;
    }));
  });
  expect(masse).toHaveLength(3);
  for (const m of masse) expect(m.w / m.h).toBeCloseTo(16 / 9, 2);
  // Die Testbilder sind 800 × 1000 — in 16:9 bleibt die Breite ganz, die Höhe
  // wird beschnitten. Volle Auflösung heißt: 800 px Breite, nicht 1080.
  expect(masse[0]!.w).toBe(800);

  // §15: das eigene Format überlebt die Sitzung wie die Voreinstellungen.
  await page.reload();
  await page.locator('input[type=file]').setInputFiles(FIVE.slice(0, 3));
  await expect(page.locator('.thumb:not(.busy)')).toHaveCount(3, { timeout: 15_000 });
  await page.getByRole('button', { name: 'Set analysieren' }).click();
  await page.getByRole('button', { name: 'Angleichen', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Eigenes', exact: true }))
    .toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#ratio-w')).toHaveValue('16');
  await expect(page.locator('#ratio-h')).toHaveValue('9');
});

test('F-12: leere oder unsinnige Felder kippen den Zuschnitt nicht', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type=file]').setInputFiles(FIVE.slice(0, 2));
  await expect(page.locator('.thumb:not(.busy)')).toHaveCount(2, { timeout: 15_000 });
  await page.getByRole('button', { name: 'Set analysieren' }).click();
  await page.getByRole('button', { name: 'Angleichen', exact: true }).click();
  await page.getByRole('button', { name: 'Eigenes', exact: true }).click();

  // Leeres Feld: kein Absturz, kein 0 × 0-Canvas — es gilt 1:1.
  await page.locator('#ratio-h').fill('');
  await expect(page.locator('.ratio-note')).toContainText('1:1');
  const leer = await page.evaluate(() => {
    const c = document.querySelectorAll('.pair')[0]!.querySelectorAll('canvas')[1] as HTMLCanvasElement;
    return { w: c.width, h: c.height };
  });
  expect(leer.w).toBeGreaterThan(0);
  expect(leer.w / leer.h).toBeCloseTo(1, 2);

  // Innerhalb der eigenen Grenzen, aber jenseits dessen, was Instagram stehen
  // lässt: zugeschnitten wird trotzdem, gesagt wird es auch.
  await page.locator('#ratio-w').fill('21');
  await page.locator('#ratio-h').fill('9');
  await expect(page.locator('.ratio-note')).toContainText('Instagram');
  const breit = await page.evaluate(() => {
    const c = document.querySelectorAll('.pair')[0]!.querySelectorAll('canvas')[1] as HTMLCanvasElement;
    return c.width / c.height;
  });
  expect(breit).toBeCloseTo(21 / 9, 2);

  // Weit jenseits der Grenze: geklemmt, und der Hinweis sagt es.
  await page.locator('#ratio-w').fill('50');
  await page.locator('#ratio-h').fill('1');
  await expect(page.locator('.ratio-note')).toContainText('Geklemmt');
  const geklemmt = await page.evaluate(() => {
    const c = document.querySelectorAll('.pair')[0]!.querySelectorAll('canvas')[1] as HTMLCanvasElement;
    return c.width / c.height;
  });
  expect(geklemmt).toBeCloseTo(4, 2);
});
