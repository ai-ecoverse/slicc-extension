import assert from 'node:assert/strict';
import test from 'node:test';
import { backend } from './fixtures/cdp-675-extension-backend.mjs';

const root = {
  id: 'root',
  loaderId: 'ordinary-document',
  url: 'https://ordinary.test/',
  securityOrigin: 'https://ordinary.test',
};
const ordinaryChild = {
  id: 'child',
  parentId: 'root',
  loaderId: 'child-document',
  url: 'https://ordinary.test/iframe',
  securityOrigin: 'https://ordinary.test',
};
const unplaced = () => ({
  frameTree: {
    frame: { ...root },
    childFrames: [
      {
        frame: {
          id: 'child',
          parentId: 'root',
          loaderId: 'child-document',
          url: '',
          securityOrigin: '',
        },
      },
    ],
  },
});

for (const method of ['Page.getFrameTree', 'Page.getResourceTree']) {
  for (const event of ['Page.frameNavigated', 'Page.frameAttached']) {
    test(`${method} sampled before ${event} cannot prune or latch a now-placed ordinary frame`, async (t) => {
      const fixture = await backend();
      t.after(fixture.close);
      const send = fixture.api.debugger.sendCommand;
      let resolve;
      fixture.api.debugger.sendCommand = (source, name, params) =>
        name === method
          ? new Promise((done) => {
              resolve = done;
            })
          : send(source, name, params);
      const reading = fixture.connection.send(11, method, {});
      assert.equal(typeof resolve, 'function');
      await fixture.emit(
        event,
        event === 'Page.frameNavigated'
          ? { frame: ordinaryChild }
          : { frameId: 'child', parentFrameId: 'root' }
      );
      const tab = fixture.connection.tabState(11);
      fixture.connection.watchFrame(11, tab, ordinaryChild);
      assert.equal(tab.frames.get('child'), false);
      resolve(unplaced());
      const result = await reading;
      await fixture.connection.learn(11, tab, method, result);
      assert.equal(
        tab.frames.get('child'),
        false,
        'stale tree must not overwrite the ordinary commit'
      );
      assert.equal(
        result.frameTree.childFrames.length,
        1,
        'stale tree must not prune after a frame event'
      );
      assert.equal(fixture.connection.frameHidden(tab, ordinaryChild), false);
    });
  }
  test(`${method} sampled while a frame really is unplaced still prunes and latches it`, async (t) => {
    const fixture = await backend();
    t.after(fixture.close);
    const send = fixture.api.debugger.sendCommand;
    fixture.api.debugger.sendCommand = (source, name, params) =>
      name === method ? Promise.resolve(unplaced()) : send(source, name, params);
    const tab = fixture.connection.tabState(11);
    const result = await fixture.connection.send(11, method, {});
    await fixture.connection.learn(11, tab, method, result);
    assert.equal(tab.frames.get('child'), true, 'a current unplaced frame must remain protected');
    assert.equal(result.frameTree.childFrames.length, 0);
    assert.equal(fixture.connection.frameHidden(tab, ordinaryChild), true);
  });
}
