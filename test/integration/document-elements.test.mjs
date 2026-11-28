import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  checkDocuments,
  documentBrowser,
  elements,
  hosts,
  httpDocument,
  navigateDocument,
  ports,
  unique,
} from './document-rows.mjs';

let context;
before(async () => {
  context = await documentBrowser();
});
after(() => context?.chrome.close());

const counts = () => ({ documents: 0, targetDocuments: 0, http: 0, https: 0, failed: 0, empty: 0 });
function add(total, result) {
  total.documents += result.documents;
  total.targetDocuments += result.targetDocuments;
  total.http += result.http;
  total.empty += result.empty;
  if (result.outcome === 'http') total.ordinaryHttp = (total.ordinaryHttp ?? 0) + 1;
  else total[result.outcome] += 1;
}

for (const element of elements) {
  test(`${element} document requests and ordinary http controls`, {
    timeout: 600000,
  }, async (t) => {
    for (const host of hosts) {
      for (const port of ports) {
        const positive = counts();
        const ordinary = counts();
        const outcomes = new Set();
        for (let trial = 0; trial < 5; trial++) {
          const token = unique('pair');
          const zone = await navigateDocument(context, t, { element, host, port, token });
          const other = await navigateDocument(context, t, {
            element,
            host: 'ordinary.test',
            port,
            token,
          });
          checkDocuments(zone);
          checkDocuments(other, 'http');
          assert.equal(new URL(zone.setup).protocol, 'http:');
          assert.equal(new URL(other.setup).protocol, 'http:');
          const zoneUrl = new URL(zone.requested);
          const otherUrl = new URL(other.requested);
          zoneUrl.hostname = otherUrl.hostname;
          assert.equal(zoneUrl.href, otherUrl.href);
          add(positive, zone);
          add(ordinary, other);
          outcomes.add(
            `${zone.committed ?? 'no-document'}|${zone.unreachable ?? zone.attempted ?? ''}`.replace(
              /\?.*$/,
              ''
            )
          );
        }
        const line = `row-3: kind=${element} host=${host} port=${port || 'default'} trials=5 ${JSON.stringify({ positive, ordinary, outcomes: [...outcomes] })}`;
        t.diagnostic(line);
        console.log(line);
      }
    }
  });
}

test('fenced frame availability without flags', { timeout: 600000 }, async (t) => {
  const support = {};
  for (const scheme of ['http', 'https']) {
    const page = await context.chrome.visit(t, `${scheme}://other.test/?n=${unique('fenced')}`, {
      expectExtension: false,
    });
    support[scheme] = await page.evaluate(() => ({
      element: typeof HTMLFencedFrameElement === 'function',
      config: typeof FencedFrameConfig === 'function',
      secure: isSecureContext,
    }));
    assert.equal(await page.evaluate(() => location.protocol), `${scheme}:`);
    await page.close();
  }
  const parent = ['http', 'https'].find(
    (scheme) => support[scheme].element && support[scheme].config
  );
  if (!parent) {
    const line = `row-4: kind=fencedframe measured=false ${JSON.stringify(support)}`;
    t.diagnostic(line);
    console.log(line);
    return;
  }
  const from = `${parent}://other.test/?n=${unique('fenced-parent')}`;
  let outside;
  try {
    outside = await navigateDocument(context, t, {
      element: 'fencedframe',
      host: 'ordinary.test',
      from,
    });
  } catch (error) {
    const line = `row-4: kind=fencedframe measured=false ${JSON.stringify({ ...support, error: String(error) })}`;
    t.diagnostic(line);
    console.log(line);
    return;
  }
  if (outside.outcome !== 'http') {
    const line = `row-4: kind=fencedframe measured=false ${JSON.stringify({ ...support, outcome: outside.outcome, committed: outside.committed, attempted: outside.unreachable ?? outside.attempted })}`;
    t.diagnostic(line);
    console.log(line);
    return;
  }
  checkDocuments(outside, 'http');
  for (const host of hosts) {
    for (const port of ports) {
      const result = await navigateDocument(context, t, {
        element: 'fencedframe',
        host,
        port,
        from,
      });
      assert.equal(result.http, 0);
      assert.equal(result.frameUrls.some(httpDocument), false);
      checkDocuments(result);
      const line = `row-4: kind=fencedframe host=${host} port=${port || 'default'} measured=true documents=${result.documents} targetDocuments=${result.targetDocuments} outcome=${result.outcome} committed=${result.committed} attempted=${result.unreachable ?? result.attempted ?? 'none'}`;
      t.diagnostic(line);
      console.log(line);
    }
  }
});
