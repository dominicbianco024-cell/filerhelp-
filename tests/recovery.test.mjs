import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, mkdir, readFile, rm, symlink, appendFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { run, safeName } from '../plugins/fileshelf/worker/shelf.mjs';
import { sharedReferences } from '../plugins/fileshelf/worker/references.mjs';

const session = 'session-1';
async function fixture(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'fileshelf-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const project = path.join(home, 'work');
  const recovery = path.join(home, 'copies');
  const transcript = path.join(home, 'session-1.jsonl');
  await mkdir(project);
  await writeFile(transcript, '');
  let seq = 0;
  async function add(role, content, extra = {}) {
    const row = { uuid: 'msg-' + ++seq, type: role, cwd: project, sessionId: session,
      timestamp: '2026-04-21T14:52:00Z', message: { role, content }, ...extra };
    await appendFile(transcript, JSON.stringify(row) + '\r\n');
    return row.uuid;
  }
  const ask = (action = {}) => run({ action: 'list', project, session, transcript, ...action }, recovery);
  async function tool(name, input, fail = false, details = {}) {
    const id = 'tool-' + seq;
    await add('assistant', [{ type: 'tool_use', name, id, input }]);
    await add('user', [{ type: 'tool_result', tool_use_id: id, is_error: fail, content: 'done' }], details);
    return id;
  }
  const share = text => add('assistant', [{ type: 'text', text }]);
  const recover = async (item, method = 'snapshot') => {
    const { saved } = await ask({ action: 'save', method, id: item.id });
    return { saved, data: await readFile(saved) };
  };
  return { add, ask, tool, share, recover, transcript, project, home, recovery };
}

test('restores an old successful Write after deletion, independent of the current disk version', async t => {
  const f = await fixture(t);
  const original = 'résumé 🚗\r\nfirst\n';
  await f.tool('Write', { file_path: 'notes.md', content: original });
  await f.share('Here is [your old file](./notes.md).');
  await f.tool('Write', { file_path: 'notes.md', content: 'new' });
  await f.share('Here is [your new file](./notes.md).');
  await writeFile(path.join(f.project, 'notes.md'), 'working copy');
  const [latest, old] = (await f.ask()).items;
  assert.equal((await f.recover(latest)).data.toString(), 'new');
  assert.equal((await f.recover(old, 'disk')).data.toString(), 'working copy');
  await rm(path.join(f.project, 'notes.md'));
  const [a, b] = await Promise.all([f.recover(old), f.recover(old)]);
  assert.notEqual(a.saved, b.saved);
  assert.deepEqual(a.data, Buffer.from(original));
  assert.equal((await f.ask()).items[1].disk, false);
});

test('embedded PDF and a zero-length text attachment survive without any source file', async t => {
  const f = await fixture(t);
  const pdf = Buffer.from([37,80,68,70,45,0,128,255,10]);
  await f.add('assistant', [
    { type: 'document', title: '../../CON.pdf', source: { type: 'base64', data: pdf.toString('base64'), media_type: 'application/pdf' } },
    { type: 'document', title: 'empty.txt', source: { type: 'text', data: '', media_type: 'text/plain' } }
  ]);
  const [empty, binary] = (await f.ask()).items;
  assert.equal((await f.recover(empty)).data.length, 0);
  const restored = await f.recover(binary);
  assert.equal(path.basename(restored.saved), '_CON.pdf');
  assert.deepEqual(restored.data, pdf);
});

test('user uploads, failed tools, sidechains and other sessions stay out of the shelf', async t => {
  const f = await fixture(t);
  await f.share('[valid link](https://example.org/kit.zip)');
  await f.add('user', [{ type: 'document', title: 'mine.pdf', source: { type: 'text', data: 'mine' } }]);
  await f.add('assistant', '[other](note.md)', { sessionId: 'someone-else' });
  await f.add('assistant', '[side](note.md)', { isSidechain: true });
  await f.tool('Write', { file_path: 'failed.txt', content: 'failed' }, true);
  await f.tool('present_files', { filepaths: ['missing.docx'] }, true);
  const result = await f.ask();
  assert.equal(result.shared, 1);
  assert.equal(result.written, 0);
  assert.equal(result.items[0].label, 'Original link');
  await assert.rejects(f.recover(result.items[0]));
});

test('long sessions, paging, compaction records and partial JSONL writes', async t => {
  const f = await fixture(t);
  await f.share('The first [brief](<Quarterly Brief (1).pdf>) covers margin.');
  await appendFile(f.transcript, (JSON.stringify({ type: 'system', subtype: 'compact_boundary' }) + '\n').repeat(16000));
  for (let i = 0; i < 14; i++) await f.share('[Download](report-' + i + '.csv)');
  await appendFile(f.transcript, '{"type":"assistant"');
  const result = await f.ask({ query: 'margin' });
  assert.equal(result.items[0].name, 'Quarterly Brief (1).pdf');
  assert.equal(result.warnings.unreadable, 1);
  assert.equal((await f.ask({ page: 2 })).items.at(-1).name, 'Quarterly Brief (1).pdf');
});

test('workspace copies reject files outside the project and links that escape the project', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.home, 'private.zip'), 'private');
  await f.share('[outside](../private.zip)');
  assert.equal((await f.ask()).items[0].disk, false);
  if (process.platform !== 'win32') {
    await symlink(path.join(f.home, 'private.zip'), path.join(f.project, 'inside.zip'));
    await f.share('[inside](inside.zip)');
    assert.equal((await f.ask()).items[0].disk, false);
  }
  await assert.rejects(f.recover((await f.ask()).items[0], 'disk'));
});

test('Windows paths, sandbox links, reference links, URLs with tokens and ignored code samples', () => {
  const refs = sharedReferences([
    '[a](<C:\\Users\\Me\\My File.zip>) and [b](sandbox:/mnt/data/report%20draft.pdf)',
    '[here][output]', '[output]: https://example.org/out.csv?sig=abc',
    '[chart](chart(v2).png) and `C:\\Work\\plan.md`',
    '```text', '[ignore](fake.xls)', '```',
    '[unsafe](javascript:hello.png) [network](file://server/docs/a.pdf)'
  ].join('\n'), 'C:\\Work');
  assert.deepEqual(refs.map(r => r.name), ['My File.zip', 'report draft.pdf', 'out.csv', 'chart(v2).png', 'plan.md']);
  assert.equal(refs[1].local, null);
  assert.equal(refs[2].target, 'https://example.org/out.csv?sig=abc');
});

test('presented files, published artifacts and a presented inline project document', async t => {
  const f = await fixture(t);
  await f.tool('mcp__cowork__present_files', { filepaths: ['deck.pdf'] });
  await f.tool('Artifact', { file_path: 'site.html' }, false, { toolUseResult: { url: 'https://claude.ai/artifact/123' } });
  await f.tool('Projects', { method: 'project_write', present_to_user: true, path: 'slides.md', content: 'A slide' });
  await f.tool('Projects', { method: 'project_write', path: 'internal.md', content: 'private' });
  const result = await f.ask();
  assert.deepEqual(result.items.map(r => r.name), ['slides.md', 'site.html', 'deck.pdf']);
  assert.equal(result.items[1].target, 'https://claude.ai/artifact/123');
  assert.equal((await f.recover(result.items[0])).data.toString(), 'A slide');
});

test('a stale selection cannot restore substituted transcript bytes', async t => {
  const f = await fixture(t);
  await f.tool('Write', { file_path: 'a.txt', content: 'original' });
  await f.share('[first](a.txt)');
  const [old] = (await f.ask()).items;
  await writeFile(f.transcript, (await readFile(f.transcript, 'utf8')).replace('original', 'replaced'));
  await assert.rejects(f.recover(old), /changed/);
});

test('worker accepts an actual request over stdin from the host', async t => {
  const f = await fixture(t);
  await f.share('Here it is: [kit](starter.zip)');
  const reader = fileURLToPath(new URL('../plugins/fileshelf/worker/shelf.mjs', import.meta.url));
  const child = spawnSync(process.execPath, [reader], { input: JSON.stringify({
    action: 'list', session, project: f.project, transcript: f.transcript
  }), encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).items[0].name, 'starter.zip');
  assert.equal(safeName('a.txt:stream'), 'a.txt_stream');
});

test('shows the original reply in the pane even when its desktop-only card has no bytes', async t => {
  const f = await fixture(t);
  const message = 'Your [poster](computer:///mnt/user-data/outputs/poster.pdf) is ready.\n' + 'extra text '.repeat(500);
  await f.share(message);
  const [item] = (await f.ask()).items;
  assert.equal(item.name, 'poster.pdf');
  assert.equal(item.label, 'Message only');
  const first = await f.ask({ action: 'message', id: item.id });
  const second = await f.ask({ action: 'message', id: item.id, page: 1 });
  assert.equal(first.body + second.body, message);
  await f.add('assistant', [{ type: 'container_upload', file_id: 'file-123', filename: 'manual.pdf' }]);
  assert.equal((await f.ask()).items[0].name, 'manual.pdf');
});

test('shows a written entry source without putting its file contents in the pane', async t => {
  const f = await fixture(t);
  await f.tool('Write', { file_path: 'result.txt', content: 'private body of the file' });
  const [item] = (await f.ask({ scope: 'written' })).items;
  const source = await f.ask({ action: 'message', id: item.id });
  assert.match(source.body, /result.txt/);
  assert.doesNotMatch(source.body, /private body/);
});
