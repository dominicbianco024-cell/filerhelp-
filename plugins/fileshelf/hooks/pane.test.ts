import { expect, test } from 'claude-code/testing';

const pane = {
  plugin: 'fileshelf', surface: 'desktop' as const, component: 'Pane' as const, requestId: 'fileshelf-history',
  props: { title: 'FileShelf', isFocused: true, bodyColumns: 48, placement: 'dock' as const,
    scroll: { offset: 0, bodyRows: 40, contentRows: 0 }, view: {} }
};

test('Desktop opens the command, searches a shared file, shows its source and saves a copy', async ($, on) => {
  const requests = [];
  on('ui.open', async (_api, e) => { expect(e.id).toBe('fileshelf-history'); return { value: { isPlaced: true } }; });
  on('session.info', async () => ({ value: { transcriptPath: 'C:/data/session.jsonl', platform: 'windows' } }));
  on('session.root', async () => ({ value: 'C:/projects' }));
  on('session.id', async () => ({ value: 'test-session' }));
  on('process.run', async (_api, e) => {
    const req = JSON.parse(e.init.stdin);
    requests.push(req);
    const item = { id: 'a', name: 'brief.md', target: 'brief.md', stamp: '', anchor: 'm-3', kind: 'path',
      label: 'Recorded Write', snapshot: 'write', disk: false, excerpt: 'Here is your brief.' };
    const result = req.action === 'save' ? { saved: 'C:/copies/brief.md' } : req.action === 'message' ? { body: 'Original delivery', page: 0, pages: 1 } :
      { shared: 1, written: 1, page: 0, pages: 1, items: [item], warnings: {} };
    return { value: { stdout: JSON.stringify(result), exitCode: 0, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } };
  });
  await $.command.run({ command: 'fileshelf', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } });
  const view = await $.ui.mount(pane);
  expect((await view.find({ key: 'file-a' }))?.text).toBe('brief.md');
  await view.input({ key: 'search', text: 'brief' });
  expect(requests.at(-1).query).toBe('brief');
  await view.press({ key: 'file-a' });
  await view.press({ key: 'read-message' });
  expect(await view.find({ text: 'Original delivery' })).toBeDefined();
  await view.press({ key: 'back-file' });
  await view.press({ key: 'save-snapshot' });
  expect(requests.at(-1)).toMatchObject({ action: 'save', method: 'snapshot', id: 'a' });
  expect(await view.find({ text: 'C:/copies/brief.md' })).toBeDefined();
  await view.press({ key: 'back' });
  expect(await view.find({ key: 'search' })).toBeDefined();
});

test('an unavailable transcript leaves the pane open with a retry action', async ($, on) => {
  on('session.info', async () => ({ value: { transcriptPath: '', platform: 'windows' } }));
  const view = await $.ui.mount(pane);
  await view.press({ key: 'refresh' });
  expect(await view.find({ text: 'Choose a local Code session with saved history to use FileShelf.' })).toBeDefined();
  expect(await view.find({ key: 'refresh' })).toBeDefined();
});
