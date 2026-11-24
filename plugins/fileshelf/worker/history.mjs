import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { describeTarget, sharedReferences } from './references.mjs';

const recordLimit = 96 * 1024 * 1024;
const sha = value => createHash('sha256').update(value).digest('hex');
const mimeExtensions = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
  'application/pdf': 'pdf', 'application/zip': 'zip', 'text/plain': 'txt'
};

async function* records(file, warnings) {
  let chunks = [], size = 0, offset = 0;
  function append(piece) {
    size += piece.length;
    if (size <= recordLimit) chunks.push(piece);
    else chunks = [];
  }
  function finish() {
    const pos = { offset, length: size };
    offset += size + 1;
    let row;
    if (size > recordLimit) warnings.large++;
    else if (size) {
      try { row = JSON.parse(Buffer.concat(chunks, size).toString('utf8')); }
      catch { warnings.unreadable++; }
    }
    chunks = []; size = 0;
    return row && { row, pos };
  }
  for await (const buf of createReadStream(file)) {
    let start = 0;
    for (let newline; (newline = buf.indexOf(10, start)) !== -1;) {
      append(buf.subarray(start, newline));
      const entry = finish();
      if (entry) yield entry;
      start = newline + 1;
    }
    if (start < buf.length) append(buf.subarray(start));
  }
  if (size) {
    const entry = finish();
    if (entry) yield entry;
  }
}

function embedded(block, index) {
  if (!['document', 'image'].includes(block.type)) return;
  const src = block.source;
  if (!src || !['text', 'base64'].includes(src.type) || typeof src.data !== 'string') return;
  if (src.type === 'base64' && (!src.data.length || src.data.length % 4 ||
      /[^a-zA-Z0-9+/=]/.test(src.data) || /=.+[^=]|={3,}|=[^=]/.test(src.data))) return;
  const ext = mimeExtensions[src.media_type] || 'bin';
  return { name: block.title || block.filename || block.name || `attachment-${index + 1}.${ext}`,
    format: src.type === 'base64' ? 'bytes' : 'text', data: src.data };
}

export async function scan(file, session, project) {
  const rows = [], writes = new Map(), pending = new Map(), seen = new Set();
  const warnings = { unreadable: 0, large: 0 };
  for await (const { row, pos } of records(file, warnings)) {
    if (row.isSidechain || (row.sessionId && row.sessionId !== session)) continue;
    if (row.type !== 'assistant' && row.type !== 'user') continue;
    const role = row.message?.role;
    if (role !== row.type) continue;
    if (row.uuid) {
      if (seen.has(row.uuid)) continue;
      seen.add(row.uuid);
    }
    const blocks = typeof row.message.content === 'string' ?
      [{ type: 'text', text: row.message.content }] : row.message.content;
    if (!Array.isArray(blocks)) continue;
    const cwd = typeof row.cwd === 'string' && row.cwd ? row.cwd : project;
    for (const [index, block] of blocks.entries()) {
      if (!block || typeof block !== 'object') continue;
      const stamp = row.timestamp || '';
      const anchor = row.uuid || '';
      function add(ref, category, extra = {}) {
        const item = { ...ref, category, stamp, anchor, pos, ...extra };
        item.id = sha(JSON.stringify([anchor || pos.offset, index, category, ref.key, item.snapshot?.hash || '']));
        rows.push(item);
        return item;
      }
      if (role === 'user') {
        if (block.type !== 'tool_result') continue;
        const action = pending.get(block.tool_use_id);
        pending.delete(block.tool_use_id);
        if (!action || block.is_error) continue;
        if (action.type === 'present') {
          for (const ref of action.refs) add(ref, 'shared', { anchor: action.tool, pos: action.pos, snapshot: writes.get(ref.key) });
        } else if (action.type === 'artifact') {
          const output = row.toolUseResult;
          const link = describeTarget(output?.url || action.url, action.ref.name, cwd, true);
          const ref = link?.kind === 'web' ? { ...action.ref, kind: 'web', target: link.target } : action.ref;
          add(ref, 'shared', { anchor: action.tool, pos: action.pos, snapshot: writes.get(ref.key),
            excerpt: 'Claude published this artifact from ' + action.ref.target });
        } else if (action.type === 'project') {
          add(action.ref, 'shared', { anchor: action.tool, pos: action.pos, snapshot: action.snapshot || writes.get(action.ref.key),
            excerpt: 'Claude presented this project document.' });
        } else if (action.type === 'write') {
          writes.set(action.ref.key, action.snapshot);
          add(action.ref, 'written', { snapshot: action.snapshot, anchor: action.tool, pos: action.pos,
            excerpt: 'Claude recorded this text in a successful Write.' });
        }
        continue;
      }
      if (block.type === 'text' && typeof block.text === 'string') {
        for (const ref of sharedReferences(block.text, cwd)) add(ref, 'shared', { snapshot: writes.get(ref.key) });
      } else if (block.type === 'tool_use' && block.id) {
        const input = block.input || {};
        if (block.name === 'Write' && typeof input.content === 'string') {
          const ref = describeTarget(input.file_path, '', cwd, true);
          if (ref) pending.set(block.id, { type: 'write', pos, tool: block.id, ref, snapshot: {
            pos, index, format: 'write', hash: sha(input.content)
          } });
        } else if (block.name === 'Artifact' && (!input.action || input.action === 'publish')) {
          const ref = describeTarget(input.file_path, input.title || '', cwd, true);
          if (ref) pending.set(block.id, { type: 'artifact', pos, tool: block.id, ref, url: input.url });
        } else if (block.name === 'Projects' && input.method === 'project_write' && input.present_to_user === true) {
          let ref = describeTarget(input.local_path || input.path, '', cwd, true);
          if (!ref) continue;
          const snapshot = typeof input.content === 'string' ? { pos, index, format: 'project', hash: sha(input.content) } : null;
          if (!input.local_path) ref = { ...ref, key: 'project:' + input.path, local: null };
          pending.set(block.id, { type: 'project', pos, tool: block.id, ref, snapshot });
        } else if (/(?:^|__)present_files$/.test(block.name)) {
          const values = input.filepaths || input.paths || input.files;
          if (Array.isArray(values)) {
            const refs = values.map(v => describeTarget(typeof v === 'string' ? v : v?.file_path || v?.path, '', cwd, true)).filter(Boolean);
            pending.set(block.id, { type: 'present', pos, tool: block.id, refs });
          }
        }
      } else {
        const asset = embedded(block, index);
        if (asset) {
          add({ name: asset.name, kind: 'embedded', key: 'block-' + index, local: null, target: '' }, 'shared', {
            snapshot: { pos, index, format: asset.format, hash: sha(asset.data) },
            excerpt: 'Attachment included in this assistant message.'
          });
        } else if ((block.type === 'document' || block.type === 'image') && block.source?.type === 'url') {
          const ref = describeTarget(block.source.url, block.title || '', cwd, true);
          if (ref) add(ref, 'shared', { excerpt: 'File linked as a message attachment.' });
        } else if (block.type === 'container_upload' || (block.type === 'document' && block.source?.type === 'file')) {
          const id = block.file_id || block.source?.file_id;
          if (typeof id === 'string' && id.length) {
            add({ name: block.title || block.filename || 'Attachment ' + id, kind: 'reference',
              key: id, local: null, target: id }, 'shared', { excerpt: 'Claude retained an attachment reference in this message.' });
          }
        }
      }
    }
  }
  return { rows: rows.reverse(), warnings };
}

async function readRecord(file, { offset, length }) {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    let total = 0;
    while (total < length) {
      const { bytesRead } = await handle.read(buffer, total, length - total, offset + total);
      if (!bytesRead) throw new Error('History changed. Refresh the shelf.');
      total += bytesRead;
    }
    return JSON.parse(buffer.toString('utf8'));
  } finally { await handle.close(); }
}

export async function sourceMessage(file, item) {
  const row = await readRecord(file, item.pos);
  if (row.type !== 'assistant' || row.message?.role !== 'assistant') throw new Error('Refresh the shelf to read this message.');
  const blocks = row.message.content;
  if (row.uuid && row.uuid !== item.anchor && !(Array.isArray(blocks) && blocks.some(b => b?.type === 'tool_use' && b.id === item.anchor))) {
    throw new Error('The source message changed. Refresh the shelf.');
  }
  const body = typeof blocks === 'string' ? blocks : blocks.filter(b => b?.type === 'text').map(b => b.text).join('\n\n');
  return body || [item.excerpt || 'Claude presented a file in this tool call.', item.target].filter(Boolean).join('\n\n');
}

export async function readSnapshot(file, snapshot) {
  const row = await readRecord(file, snapshot.pos);
  const block = row.message.content[snapshot.index];
  const data = ['project', 'write'].includes(snapshot.format) ? block?.input?.content : block?.source?.data;
  if (typeof data !== 'string' || sha(data) !== snapshot.hash) throw new Error('History changed. Refresh the shelf.');
  return Buffer.from(data, snapshot.format === 'bytes' ? 'base64' : 'utf8');
}
