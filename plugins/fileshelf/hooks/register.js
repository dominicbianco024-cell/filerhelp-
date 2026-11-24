const pane = 'fileshelf-history';

let scope, query, page, list, selected, notice, saved, message, busy, dirty, revision = 0;
function reset() {
  revision++;
  scope = 'shared'; query = ''; page = 0; list = null; selected = null;
  notice = ''; saved = ''; message = null; busy = false; dirty = false;
}
reset();

async function worker($, request) {
  const info = await $.session.info();
  if (!info.transcriptPath || info.isWorkspaceRemote || info.isHosted) {
    throw new Error('Choose a local Code session with saved history to use FileShelf.');
  }
  const input = { ...request, transcript: info.transcriptPath, session: await $.session.id(),
    project: await $.session.root() };
  let result;
  try {
    result = await $.process.run(['node', $.plugin.root + '/worker/shelf.mjs'], {
      cwd: $.plugin.root, stdin: JSON.stringify(input), timeoutMs: 120000
    });
  } catch (error) {
    throw new Error('The file reader could not start or timed out. Check that Node.js 22+ is on PATH, then restart Desktop. ' + String(error).slice(0, 160));
  }
  if (result.exitCode !== 0) throw new Error((result.stderr || 'The local reader stopped.').slice(0, 320));
  if (result.isStdoutTruncated) throw new Error('The result exceeded the host display limit.');
  return JSON.parse(result.stdout);
}

async function load($) {
  const ticket = ++revision;
  selected = null; message = null; saved = ''; notice = ''; busy = true; list = null;
  $.ui.invalidate('ui.render');
  try {
    const result = await worker($, { action: 'list', scope, query, page });
    if (ticket !== revision) return;
    list = result; page = list.page; dirty = false;
  } catch (error) {
    if (ticket === revision) notice = error.message;
  } finally {
    if (ticket === revision) { busy = false; $.ui.invalidate('ui.render'); }
  }
}

async function save($, item, method) {
  if (busy) return;
  const ticket = ++revision;
  busy = true; saved = ''; notice = '';
  $.ui.invalidate('ui.render');
  try {
    const result = await worker($, { action: 'save', id: item.id, method });
    if (ticket === revision) saved = result.saved;
  } catch (error) {
    if (ticket === revision) notice = error.message;
  } finally {
    if (ticket === revision) { busy = false; $.ui.invalidate('ui.render'); }
  }
}

async function readMessage($, item, pageNumber) {
  const ticket = ++revision;
  try {
    const result = await worker($, { action: 'message', id: item.id, page: pageNumber });
    if (ticket === revision && selected?.id === item.id) { message = result; notice = ''; }
  } catch (error) {
    if (ticket === revision) notice = error.message;
  }
  $.ui.invalidate('ui.render');
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    reset();
    await $.command.register({ name: 'fileshelf', description: 'Find and recover files from this conversation', immediate: true });
    return next(e);
  });

  on('command.run', { command: 'fileshelf' }, async ($) => {
    await $.ui.open({ id: pane, title: 'FileShelf', focus: true, closeOnEscape: true, columns: 48 });
    await load($);
    return {};
  });

  on('turn.complete', async ($, e, next) => {
    if (list) { dirty = true; $.ui.invalidate('ui.render'); }
    return next(e);
  });

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== pane) return next(e);
    const { Box, Button, Text, Input, Link } = $.ui.resolve(e);
    const redraw = () => $.ui.invalidate('ui.render');
    const text = (value, props = {}) => Text({ ...props, children: [value] });
    const button = (key, label, onPress, props = {}) => Button({ key, label, onPress, ...props });
    const column = (children, props = {}) => Box({ flexDirection: 'column', ...props, children });
    const row = children => Box({ flexDirection: 'row', flexWrap: 'wrap', columnGap: 1, children });
    const small = { size: 'caption', dimColor: true };
    const accent = '#b8724f';
    const body = [];
    const back = () => { selected = null; message = null; saved = ''; notice = ''; redraw(); };
    const changeScope = async value => { scope = value; page = 0; await load($); };

    async function copy(value, surface) {
      try {
        const result = await $.ui.copy({ text: value, surface });
        notice = result.isCopied ? 'Copied.' : 'Select and copy the text displayed here.';
      } catch { notice = 'Select and copy the text displayed here.'; }
      redraw();
    }
    if (selected && message) {
      body.push(button('back-file', '‹  File details', () => { message = null; notice = ''; redraw(); }, { plain: true }),
        text('Original message', { size: 'heading', weight: 'semibold' }), text(selected.name, small),
        text(message.body));
      const pages = [];
      if (message.page > 0) pages.push(button('prev-message', 'Previous', () => readMessage($, selected, message.page - 1)));
      if (message.pages > 1) pages.push(text((message.page + 1) + ' / ' + message.pages, small));
      if (message.page + 1 < message.pages) pages.push(button('next-message', 'Next', () => readMessage($, selected, message.page + 1)));
      if (pages.length) body.push(row(pages));
    } else if (selected) {
      const item = selected;
      if (!busy) body.push(button('back', '‹  All files', back, { plain: true }));
      body.push(text(item.name, { size: 'heading', weight: 'semibold' }), text(item.label, { color: accent }));
      if (item.target) body.push(text(item.target, { mono: true, size: 'footnote' }));
      if (item.stamp) body.push(text(item.stamp, small));
      body.push(column([text('From the conversation', { weight: 'medium' }), text(item.excerpt)], {
        borderStyle: 'quote', borderColor: accent, paddingX: 1
      }));
      if (busy) body.push(text('Saving a new copy…', small));
      else {
        if (item.snapshot === 'write') body.push(text('This version contains the UTF-8 text of the recorded Write. Later edits may differ.', small));
        if (item.snapshot) body.push(button('save-snapshot', item.snapshot === 'write' ? 'Save recorded text' : 'Save attachment',
          () => save($, item, 'snapshot'), { variant: 'primary' }));
        if (item.disk) body.push(button('save-disk', 'Save current workspace copy', () => save($, item, 'disk')));
        if (item.kind === 'web') {
          if (item.target.startsWith('https://') && item.target.length <= 2048)
            body.push(Link({ href: item.target, label: 'Open original link ↗' }));
          body.push(button('copy-link', 'Copy original link', press => copy(item.target, press.surface)));
        }
        if (item.label === 'Message only') body.push(text('This entry contains a reference. Check the original message for its file card.', small));
        body.push(button('read-message', 'Read original message', () => readMessage($, item, 0)));
        if (item.anchor) body.push(button('source', 'Jump to chat', async () => {
          try {
            const result = await $.ui.scroll({ to: { requestId: item.anchor }, block: 'center' });
            notice = result?.deny ? 'Claude could not scroll to this row. Use Read original message to view it here.' : '';
          } catch { notice = 'This row is unavailable in the current chat view. Use Read original message to view it here.'; }
          redraw();
        }));
        if (saved) body.push(column([text('Copy saved', { weight: 'semibold' }), text(saved, { mono: true, size: 'footnote' }),
          button('copy-path', 'Copy saved path', press => copy(saved, press.surface))], { borderStyle: 'round', paddingX: 1 }));
      }
    } else {
      body.push(text('Session files', { size: 'title', weight: 'semibold' }));
      if (busy) body.push(text('Reading this conversation…', small));
      else {
        body.push(row([
          button('shared', 'Shared' + (list ? ' · ' + list.shared : ''), () => changeScope('shared'), { variant: scope === 'shared' ? 'primary' : 'secondary' }),
          button('written', 'Tool writes' + (list ? ' · ' + list.written : ''), () => changeScope('written'), { variant: scope === 'written' ? 'primary' : 'secondary' })
        ]));
        body.push(Input({ key: 'search', label: 'Find files', placeholder: 'Filename, extension or message text',
          value: query, submitLabel: 'Search', onSubmit: async value => { query = value.slice(0, 240); page = 0; await load($); } }));
        if (list) {
          if (list.items.length === 0) {
            const empty = query ? 'No files match “' + query + '”.' : scope === 'shared'
              ? 'No shared files found. Tool writes lists text files Claude created in this session.'
              : 'No successful Write calls found in this session.';
            body.push(text(empty, small));
          }
          for (const item of list.items) {
            const when = item.stamp ? '  ·  ' + item.stamp.slice(0, 10) : '';
            body.push(column([
              button('file-' + item.id, item.name, () => { selected = item; message = null; notice = ''; saved = ''; redraw(); }, { plain: true }),
              text(item.label + when, small)
            ], { borderStyle: 'quote', borderColor: accent, paddingX: 1 }));
          }
          if (list.pages > 1) {
            const controls = [];
            if (page > 0) controls.push(button('previous', 'Previous', async () => { page--; await load($); }));
            controls.push(text((page + 1) + ' / ' + list.pages, small));
            if (page + 1 < list.pages) controls.push(button('next', 'Next', async () => { page++; await load($); }));
            body.push(row(controls));
          }
          if (list.warnings.unreadable || list.warnings.large) body.push(text(
            'Skipped ' + list.warnings.unreadable + ' incomplete or unreadable records and ' + list.warnings.large + ' over 96 MiB.', small));
        }
        const actions = [button('refresh', dirty ? 'Refresh · new activity' : 'Refresh', () => load($), { plain: true })];
        if (query) actions.push(button('clear', 'Clear search', async () => { query = ''; page = 0; await load($); }, { plain: true }));
        body.push(row(actions));
      }
    }
    if (notice) body.push(text(notice, { size: 'footnote' }));
    return column(body, { gap: 1, paddingX: 1 });
  });
}
