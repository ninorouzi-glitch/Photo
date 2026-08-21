import { expect, test } from '@playwright/test';

/**
 * Leistungsbudget aus §13.
 *
 * Muss im sichtbaren Tab laufen: Chrome drosselt in Hintergrund-Tabs Timer und
 * die Rückmeldung von `toBlob` auf eine Sekunde. Eine Messung dort sagt nichts
 * über die App aus — sie misst Chromes Sparmodus. Playwright-Seiten gelten als
 * sichtbar, deshalb steht die Messung hier und nicht in einem Vitest.
 */
test('Analyse, Vorschau und Export bleiben im Budget', async ({ page }) => {
  test.slow();
  await page.goto('/');

  expect(await page.evaluate(() => document.visibilityState)).toBe('visible');

  // Ein echtes 24-MP-JPEG mit Struktur — ein Farbverlauf allein wäre zu billig.
  await page.evaluate(async () => {
    const W = 6000, H = 4000;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const x = c.getContext('2d')!;
    const g = x.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#28323c');
    g.addColorStop(1, '#c8bda8');
    x.fillStyle = g; x.fillRect(0, 0, W, H);
    for (let i = 0; i < 4000; i++) {
      x.fillStyle = `hsl(${(i * 37) % 360} 45% ${30 + (i % 50)}%)`;
      x.fillRect((i * 577) % W, (i * 991) % H, 40, 40);
    }
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', 0.95));
    c.width = 1; c.height = 1;
    (window as unknown as { __big: Blob }).__big = blob!;
  });

  const N = 5;

  // ── Analyse je Bild ≤ 300 ms, Oberfläche bleibt bedienbar (F-05) ──
  const analyse = await page.evaluate(async (n) => {
    const big = (window as unknown as { __big: Blob }).__big;
    const dt = new DataTransfer();
    for (let i = 1; i <= n; i++) {
      dt.items.add(new File([big], `gross-${String(i).padStart(2, '0')}.jpg`, { type: 'image/jpeg' }));
    }
    // MessageChannel statt Timer: misst echte Hauptthread-Blockaden.
    const mc = new MessageChannel();
    let worst = 0, last = performance.now(), running = true;
    mc.port1.onmessage = () => {
      const t = performance.now();
      worst = Math.max(worst, t - last);
      last = t;
      if (running) mc.port2.postMessage(0);
    };
    mc.port2.postMessage(0);

    const t0 = performance.now();
    const input = document.querySelector('input[type=file]') as HTMLInputElement;
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise<void>((r) => {
      const iv = setInterval(() => {
        if (document.querySelectorAll('.thumb:not(.busy)').length === n) { clearInterval(iv); r(); }
      }, 16);
    });
    running = false;
    return { total: performance.now() - t0, worstBlock: worst };
  }, N);

  report('Analyse je 24-MP-Bild', analyse.total / N, 300);
  report('längste Hauptthread-Blockade', analyse.worstBlock, 150);
  expect(analyse.total / N).toBeLessThanOrEqual(300);
  expect(analyse.worstBlock).toBeLessThanOrEqual(150);

  // ── Vorschau des ganzen Sets ≤ 150 ms ──
  await page.getByRole('button', { name: 'Set analysieren' }).click();
  await page.getByRole('button', { name: 'Angleichen', exact: true }).click();
  await expect(page.locator('.pair')).toHaveCount(N);

  const vorschau = await page.evaluate(() => {
    const s = document.getElementById('strength') as HTMLInputElement;
    const t0 = performance.now();
    s.value = '100';
    s.dispatchEvent(new Event('input', { bubbles: true }));
    return performance.now() - t0;
  });
  report('Vorschau des ganzen Sets', vorschau, 150);
  expect(vorschau).toBeLessThanOrEqual(150);

  // ── Export ──
  //
  // Zwei Budgets, weil es zwei Ausgabegrößen gibt. Die 400 ms aus §13 gelten
  // für 1080 × 1350 und werden dort auch geprüft. Die volle Auflösung rechnet
  // bei einem 24-MP-Foto auf 3200 × 4000 — das Zwölffache an Pixeln, und ein
  // fester Millisekundenwert würde nur noch die Bildgröße messen. Dafür steht
  // ein Budget je Megapixel, das dieselbe Frage beantwortet: rechnet der Export
  // linear, oder ist irgendwo etwas quadratisch geworden.
  const messeExport = () =>
    page.evaluate(async (n) => {
      const saved: Blob[] = [];
      (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = async () => ({
        getFileHandle: async () => ({
          createWritable: async () => ({
            write: async (b: Blob) => { saved.push(b); },
            close: async () => {},
          }),
        }),
      });
      const btn = [...document.querySelectorAll('button')]
        .find((b) => /Bilder exportieren/.test(b.textContent ?? ''))!;
      const t0 = performance.now();
      btn.click();
      await new Promise<void>((r) => {
        const iv = setInterval(() => { if (saved.length === n) { clearInterval(iv); r(); } }, 20);
      });
      const ms = performance.now() - t0;
      const bmp = await createImageBitmap(saved[0]!);
      const px = bmp.width * bmp.height;
      bmp.close();
      return { ms, megapixel: px / 1e6 };
    }, N);

  await page.getByRole('button', { name: 'Reihe ansehen' }).click();

  const voll = await messeExport();
  const proMp = voll.ms / N / voll.megapixel;
  report(
    `Export je Bild (volle Auflösung, ${voll.megapixel.toFixed(1)} MP)`,
    voll.ms / N,
    Math.round(120 * voll.megapixel),
  );
  report('Export je Megapixel', proMp, 120);
  expect(voll.megapixel).toBeGreaterThan(10); // die Pixel sind wirklich noch da
  expect(proMp).toBeLessThanOrEqual(120);

  await page.getByRole('button', { name: 'Zurück zum Angleichen' }).click();
  await page.getByRole('button', { name: '1080 px', exact: true }).click();
  await page.getByRole('button', { name: 'Reihe ansehen' }).click();
  await expect(page.locator('#stage-4 .sub').first()).toContainText('1080 × 1350 px');

  const klein = await messeExport();
  report('Export je Bild (1080 × 1350)', klein.ms / N, 400);
  expect(klein.megapixel).toBeCloseTo(1.458, 2);
  expect(klein.ms / N).toBeLessThanOrEqual(400);
});

function report(label: string, value: number, budget: number): void {
  const line = `${label}: ${Math.round(value)} ms (Budget ${budget} ms)`;
  test.info().annotations.push({ type: 'budget', description: line });
  console.log('  · ' + line);
}
