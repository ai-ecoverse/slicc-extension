import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { documentBrowser, documentCell, hosts, ports, unique, ways } from './document-rows.mjs';
import { read, readable, receiver } from './http-fixture.mjs';

let context;
before(async () => {
  context = await documentBrowser();
});
after(() => context?.chrome.close());

for (const way of ways) {
  test(`${way} requests commit https documents or fail`, { timeout: 600000 }, async (t) => {
    for (const host of hosts) {
      for (const port of ports) {
        const counts = await documentCell(context, t, { way, host, port });
        const line = `row-1: way=${way} host=${host} port=${port || 'default'} trials=5 ${JSON.stringify(counts)}`;
        t.diagnostic(line);
        console.log(line);
      }
    }
  });
}

test('https documents keep their scheme and port and read the receiver', async (t) => {
  for (const host of ['seven.sliccy.ai', 'www.sliccy.ai']) {
    for (const port of ['', ':18443']) {
      let lifted = 0;
      for (let trial = 0; trial < 20; trial++) {
        const href = `https://${host}${port}/?n=${unique('https')}`;
        const page = await context.chrome.visit(t, href, { expectExtension: false });
        assert.equal(await page.evaluate(() => location.href), href);
        if (readable(await read(page, `${receiver}?n=${unique('https-receiver')}`))) lifted++;
        await page.close();
      }
      const line = `row-2: host=${host} port=${port || 'default'} documents=20 lifted=${lifted}/20`;
      t.diagnostic(line);
      console.log(line);
      assert.equal(lifted, 20);
    }
  }
});
