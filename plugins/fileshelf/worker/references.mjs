import path from 'node:path';

const windowsDrive = /^[A-Za-z]:[\\/]/;
const extension = /\.[\p{L}\d][\p{L}\d_+-]{0,15}$/u;
const invalid = /[\x00-\x1f\x7f]/;
const protocol = /^[a-z][\w+.-]*:/i;

function decode(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

export function describeTarget(raw, label, cwd, explicit = false) {
  if (typeof raw !== 'string' || raw.length > 12000 || invalid.test(raw)) return;
  let value = raw.trim();
  if (!value || value.startsWith('#') || value.startsWith('//') || value.startsWith('\\\\')) return;
  let kind = 'path';
  let target = value;
  let local = value;
  let name;
  if (/^https?:\/\//i.test(value)) {
    let url;
    try { url = new URL(value); } catch { return; }
    if (url.username || url.password) return;
    name = decode(url.pathname.split('/').pop() || '');
    if (!extension.test(name) && extension.test(label)) name = label;
    if (!extension.test(name) && !/download|attachment|\/artifacts?\//i.test(label + ' ' + url.pathname) && !explicit) return;
    kind = 'web';
    local = null;
    name ||= label || 'Download';
  } else {
    if (/^file:\/\//i.test(value)) {
      let url;
      try { url = new URL(value); } catch { return; }
      if (url.hostname && url.hostname !== 'localhost') return;
      local = decode(url.pathname).replace(/^\/(?=[A-Za-z]:\/)/, '');
    } else if (value.startsWith('computer:///')) {
      local = decode(value.slice('computer://'.length));
      kind = 'sandbox';
    } else if (/^sandbox:\//i.test(value)) {
      local = decode(value.slice(8));
      kind = 'sandbox';
    } else if (protocol.test(value) && !windowsDrive.test(value)) {
      return;
    } else if (!windowsDrive.test(value) && !value.includes('\\')) {
      local = decode(value.split('#')[0]);
    }
    if (!local || invalid.test(local) || /^(?:\\\\|\/\/)/.test(local)) return;
    name = local.split(/[\\/]/).pop();
    if (!name || (!explicit && !extension.test(name))) return;
    const win = windowsDrive.test(local) || windowsDrive.test(cwd);
    const engine = win ? path.win32 : path.posix;
    // Linux-side sandbox links on Windows have no Windows disk equivalent.
    if ((kind === 'sandbox' || (win && local.startsWith('/'))) && !windowsDrive.test(local)) {
      target = path.posix.normalize(local);
    } else {
      target = engine.resolve(cwd, local);
    }
    if (kind === 'sandbox' || (win && /^\//.test(local) && !windowsDrive.test(local))) local = null;
    else local = target;
  }
  let key = kind === 'web' ? target : target.replaceAll('\\', '/');
  if (windowsDrive.test(target)) key = key.toLowerCase();
  return { name, kind, target: kind === 'web' ? target : value, key, local };
}

// CommonMark inline destinations can include balanced parentheses or an angle-wrapped
// filename with spaces. Code fences are examples rather than file deliveries.
function markdownLinks(line) {
  const links = [];
  const stripped = [];
  let last = 0;
  const start = /!?\[([^\]\n]{0,512})\]\(/g;
  for (let match; (match = start.exec(line));) {
    let depth = 1;
    let i = start.lastIndex;
    const angle = line[i] === '<';
    let inAngle = angle;
    for (; i < line.length && depth; i++) {
      if (line[i] === '\\' && /[()<>\\]/.test(line[i + 1] || ' ')) { i++; continue; }
      if (inAngle) { if (line[i] === '>') inAngle = false; continue; }
      if (line[i] === '(') depth++;
      if (line[i] === ')') depth--;
    }
    if (depth) continue;
    let dst = line.slice(start.lastIndex, i - 1).trim();
    if (angle) dst = dst.slice(1, dst.lastIndexOf('>'));
    else dst = dst.replace(/\s+["'][^"']*["']\s*$/, '').replace(/\\([()])/g, '$1');
    links.push([dst, match[1]]);
    stripped.push(line.slice(last, match.index), ' ');
    last = i;
    start.lastIndex = i;
  }
  stripped.push(line.slice(last));
  return { links, rest: stripped.join('') };
}

export function sharedReferences(text, cwd) {
  const found = new Map();
  const refs = new Map();
  const lines = text.split(/\r?\n/);
  let fence;
  const body = [];
  for (const line of lines) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker && !fence) { fence = marker; continue; }
    if (fence) {
      if (marker?.[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    const definition = /^\s*\[([^\]]+)\]:\s*(?:<([^>]+)>|(\S+))/.exec(line);
    if (definition) refs.set(definition[1].toLowerCase(), definition[2] || definition[3]);
    else body.push(line);
  }
  function add(raw, label, line) {
    const item = describeTarget(raw, label, cwd);
    if (item && !found.has(item.key)) found.set(item.key, { ...item, excerpt: line.trim().slice(0, 500) });
  }
  for (const line of body) {
    const { links, rest } = markdownLinks(line);
    for (const [raw, label] of links) add(raw, label, line);
    const plain = rest.replace(/\[([^\]]+)\](?:\[([^\]]*)\])?/g, (token, label, id) => {
      const raw = refs.get((id || label).toLowerCase());
      if (!raw) return token;
      add(raw, label, line);
      return ' ';
    }).replace(/`([^`\n]+)`/g, (_, raw) => { add(raw, '', line); return ' '; });
    for (const match of plain.matchAll(/(?:https?:\/\/|sandbox:\/|computer:\/\/\/|file:\/\/|[A-Za-z]:[\\/]|\/mnt\/(?:data|user-data)\/)[^\s<>"'`]+/gi)) {
      add(match[0].replace(/[.,;:!?\])]+$/, ''), '', line);
    }
  }
  return [...found.values()];
}
