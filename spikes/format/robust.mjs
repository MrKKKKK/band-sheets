import { chromium } from 'playwright';
const b = await chromium.launch(); const p = await b.newPage();
p.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 200)));
await p.goto('http://localhost:5180/robust.html');
await p.waitForFunction(() => window.__robust, null, { timeout: 20000 });
console.log(JSON.stringify(await p.evaluate(() => window.__robust), null, 1));
await b.close();
