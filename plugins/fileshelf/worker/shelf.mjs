import path from 'node:path';
import os from 'node:os';
import { constants } from 'node:fs';
import { copyFile, mkdir, mkdtemp, open, realpath, rm, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { readSnapshot, scan, sourceMessage } from './history.mjs';

const pageSize = 6;
const device = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;

export function safeName(name) {
  let clean = String(name).split(/[\\/]/).pop().normalize('NFC')
    .replace(/[<>:"|?*\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '_')
    .replace(/[ .]+$/, '').slice(0, 150).replace(/[ .]+$/, '');
  if (!clean || clean === '.' || clean === '..') clean = 'recovered-file';
  if (device.test(clean)) clean = '_' + clean;
  return clean;
}

function within(root, name) {
  const relative = path.relative(root, name);
  return !!relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

async function workspaceFile(root, candidate) {
  if (!candidate || !root || !within(root, candidate)) return null;
  if (process.platform === 'win32' && candidate.slice(path.parse(candidate).root.length).split(/[\\/]/)
    .some(part => part.includes(':') || device.test(part))) return null;
  try {
    const [directory, target] = await Promise.all([realpath(root), realpath(candidate)]);
    return within(directory, target) && (await stat(target)).isFile() ? target : null;
  } catch { return null; }
}

async function summary(item, project) {
  const disk = Boolean(await workspaceFile(project, item.local));
  const snapshot = item.snapshot?.format || '';
  const label = snapshot === 'write' ? 'Recorded Write' : snapshot ? 'Embedded attachment'
    : disk ? 'Workspace file' : item.kind === 'web' ? 'Original link' : 'Message only';
  return {
    id: item.id, name: item.name.slice(0, 240), stamp: String(item.stamp).slice(0, 40),
    anchor: item.anchor, target: item.target, kind: item.kind, label, disk,
    snapshot, excerpt: (item.excerpt || 'File presented in this conversation.').slice(0, 500)
  };
}

async function saveItem(item, req, recoveryRoot) {
  const disk = req.method === 'disk' && await workspaceFile(req.project, item.local);
  const snapshot = req.method === 'snapshot' && item.snapshot;
  if (!disk && !snapshot) throw new Error('This copy is unavailable. Refresh to see the remaining sources.');
  const bytes = snapshot ? await readSnapshot(req.transcript, snapshot) : null;
  await mkdir(recoveryRoot, { recursive: true, mode: 0o700 });
  const folder = await mkdtemp(path.join(recoveryRoot, 'copy-'));
  const destination = path.join(folder, safeName(item.name));
  try {
    if (bytes !== null) {
      const out = await open(destination, 'wx', 0o600);
      try { await out.writeFile(bytes); } finally { await out.close(); }
    } else {
      await copyFile(disk, destination, constants.COPYFILE_EXCL);
    }
    return { saved: destination };
  } catch (error) {
    await rm(folder, { recursive: true, force: true });
    throw error;
  }
}

export async function run(req, recoveryRoot = path.join(os.homedir(), 'FileShelf Recovery')) {
  if (!req || !['list', 'save', 'message'].includes(req.action) || typeof req.session !== 'string' || !req.session ||
      typeof req.transcript !== 'string' || !path.isAbsolute(req.transcript) ||
      typeof req.project !== 'string' || !path.isAbsolute(req.project)) {
    throw new Error('Open FileShelf in a local Code session that has a saved transcript.');
  }
  const { rows, warnings } = await scan(req.transcript, req.session, req.project);
  if (req.action !== 'list') {
    const item = rows.find(r => r.id === req.id);
    if (!item) throw new Error('This entry changed or left the transcript. Refresh and select it again.');
    if (req.action === 'save') return saveItem(item, req, recoveryRoot);
    const body = await sourceMessage(req.transcript, item);
    const pages = Math.max(1, Math.ceil(body.length / 3200));
    const page = Math.max(0, Math.min(pages - 1, Number.isSafeInteger(req.page) ? req.page : 0));
    return { body: body.slice(page * 3200, (page + 1) * 3200), page, pages };
  }
  const query = String(req.query || '').slice(0, 240).trim().toLowerCase();
  const shared = rows.filter(r => r.category === 'shared').length;
  const matches = rows.filter(r => r.category === (req.scope === 'written' ? 'written' : 'shared') &&
    (!query || [r.name, r.target, r.excerpt || ''].some(s => s.toLowerCase().includes(query))));
  const pages = Math.max(1, Math.ceil(matches.length / pageSize));
  const page = Math.max(0, Math.min(pages - 1, Number.isSafeInteger(req.page) ? req.page : 0));
  return { shared, written: rows.length - shared, matches: matches.length, page, pages, warnings,
    items: await Promise.all(matches.slice(page * pageSize, (page + 1) * pageSize).map(r => summary(r, req.project))) };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    process.stdout.write(JSON.stringify(await run(JSON.parse(input))));
  } catch (error) {
    const message = error.code === 'ENOENT' ? 'A source file is missing. Reopen the original session and refresh.'
      : ['EACCES', 'EPERM'].includes(error.code) ? 'Windows denied access to the transcript, source file or recovery directory.'
      : error.code === 'ENOSPC' ? 'The recovery drive has no free space.' : error.message;
    process.stderr.write(message);
    process.exitCode = 1;
  }
}
