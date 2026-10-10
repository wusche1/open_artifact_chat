import { marked } from 'https://cdn.jsdelivr.net/npm/marked@12.0.2/lib/marked.esm.js';
import DOMPurify from 'https://cdn.jsdelivr.net/npm/dompurify@3.1.6/dist/purify.es.mjs';

const MODELS = [
  ['z-ai/glm-5.3', 'GLM 5.3'],
  ['z-ai/glm-5.3-flash', 'GLM 5.3 Flash'],
  ['moonshotai/kimi-k3', 'Kimi K3'],
];

const fn = (name, description, properties, required = Object.keys(properties)) =>
  ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });
const str = description => ({ type: 'string', description });

const TOOLS = [
  fn('web_search', 'Search the web. Returns the top results with page excerpts.', { query: str('Search query') }),
  fn('run_python', 'Run Python code (Pyodide, in the user\'s browser) and return stdout plus the value of the last expression. Packages like numpy and pandas are auto-loaded from imports.', { code: str('Python code') }),
  fn('create_artifact', 'Show the user a rendered HTML artifact in a side panel: web pages, apps, games, visualizations, diagrams, documents. Artifacts are shared across all chats. Pass a complete self-contained HTML document; libraries may be loaded from cdnjs or jsdelivr. To revise an artifact (including one made by another chat), call again with the same id and the full updated HTML.',
    { id: str('Short slug, reuse to update'), title: str('Title'), html: str('Full HTML document') }),
  fn('list_artifacts', 'List all artifacts.', {}),
  fn('read_artifact', 'Get the HTML of an artifact.', { id: str('Artifact id') }),
  fn('list_chats', 'List the user\'s other chats (agents).', {}),
  fn('send_message', 'Send a message to another chat (agent). It runs and its reply is returned.', { chat_id: str('Target chat id'), message: str('Message') }),
];
const SPAWN = fn('spawn_subagent', 'Spawn a subagent in a new chat to do a self-contained task; returns its final answer. Call several at once to run them in parallel.',
  { title: str('Short title'), task: str('Complete instructions; the subagent sees nothing else'), model: str('Optional OpenRouter model id, defaults to yours') }, ['title', 'task']);

const $ = s => document.querySelector(s);
const uid = () => crypto.randomUUID().slice(0, 8);
const load = (k, d) => JSON.parse(localStorage.getItem(k)) ?? d;
const md = s => DOMPurify.sanitize(marked.parse(s));

const state = load('state', { chats: {} });
state.artifacts ??= {};
for (const c of Object.values(state.chats)) for (const m of c.messages) if (m.tool_calls) m.tool_calls = m.tool_calls.filter(Boolean);
const persist = () => localStorage.setItem('state', JSON.stringify(state));
const running = {};
let current = null;

function newChat(title, parent) {
  const c = { id: uid(), title, parent, model: $('#model').value, messages: [], updated: Date.now() };
  state.chats[c.id] = c;
  return c;
}


let pyWorker = null;
const pyPending = {};
function runPython(code) {
  if (!pyWorker) {
    pyWorker = new Worker('py-worker.js');
    pyWorker.onmessage = ({ data }) => pyPending[data.id](data.out);
  }
  const id = uid();
  return new Promise(resolve => {
    pyPending[id] = resolve;
    pyWorker.postMessage({ id, code });
  });
}

async function webSearch(query, msg) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${localStorage.getItem('apiKey')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'openai/gpt-4.1-nano', max_tokens: 16, plugins: [{ id: 'web', max_results: 5 }], messages: [{ role: 'user', content: query }] }),
  });
  const j = await res.json();
  if (j.error) return `Search failed: ${j.error.message}`;
  const annotations = j.choices[0].message.annotations ?? [];
  for (const a of annotations)
    if (!msg.annotations?.some(x => x.url_citation.url === a.url_citation.url)) (msg.annotations ??= []).push(a);
  return annotations.map(({ url_citation: c }) => `## ${c.title}\n${c.url}\n${c.content ?? ''}`).join('\n\n') || 'No results.';
}

async function runTool(tc, chat, msg) {
  const args = JSON.parse(tc.function.arguments || '{}');
  switch (tc.function.name) {
    case 'run_python': return runPython(args.code);
    case 'web_search': return webSearch(args.query, msg);
    case 'create_artifact':
      state.artifacts[args.id] = { title: args.title, html: args.html, chatId: chat.id, updated: Date.now() };
      if (chat === current) openArtifact(args);
      return 'Artifact displayed to the user.';
    case 'list_artifacts':
      return Object.entries(state.artifacts).map(([id, a]) => `${id}: ${a.title} (by chat ${a.chatId})`).join('\n') || 'No artifacts yet.';
    case 'read_artifact': return state.artifacts[args.id]?.html ?? 'No such artifact.';
    case 'list_chats':
      return Object.values(state.chats).filter(c => c !== chat)
        .map(c => `${c.id}: ${c.title}${c.parent ? ` (subagent of ${c.parent})` : ''}${running[c.id] ? ' [busy]' : ''}`).join('\n') || 'No other chats.';
    case 'send_message': {
      const target = state.chats[args.chat_id];
      if (!target) return 'No such chat.';
      if (running[target.id]) return 'That agent is busy right now.';
      target.messages.push({ role: 'user', content: `[Message from chat "${chat.title}" (${chat.id})]\n${args.message}` });
      return runAgent(target);
    }
    case 'spawn_subagent': {
      const sub = newChat(`🤖 ${args.title}`, chat.id);
      sub.model = args.model || chat.model;
      sub.messages.push({ role: 'user', content: args.task });
      return runAgent(sub);
    }
  }
  return `Unknown tool ${tc.function.name}`;
}

function systemPrompt(chat) {
  return `You are a helpful assistant. Today is ${new Date().toDateString()}.
You are chat "${chat.title}" (id ${chat.id}). The user's other chats are other agents: you can list and message them, and all chats share the same artifacts.
Use web_search for anything current or uncertain and cite sources. Use run_python for computation.
Use create_artifact whenever the user wants something visual, interactive, or a substantial standalone document; don't repeat the artifact's code in your reply.
${chat.parent ? 'You are a subagent: do the task and end with a complete final answer, which is returned to your parent.' : 'Spawn subagents for independent or parallelizable subtasks.'}`;
}

async function streamCompletion(chat, signal) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    signal,
    headers: {
      Authorization: `Bearer ${localStorage.getItem('apiKey')}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': location.origin,
      'X-Title': 'Open Artifact Chat',
    },
    body: JSON.stringify({
      model: chat.model,
      stream: true,
      tools: chat.parent ? TOOLS : [...TOOLS, SPAWN],
      messages: [
        { role: 'system', content: systemPrompt(chat) },
        ...chat.messages.filter(m => !m.error).map(({ role, content, tool_calls, tool_call_id, reasoning }) =>
          ({ role, content, tool_calls, tool_call_id, reasoning })),
      ],
    }),
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);

  const msg = { role: 'assistant', content: '', reasoning: '' };
  chat.messages.push(msg);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  const byIndex = {};
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
      const chunk = JSON.parse(line.slice(6));
      if (chunk.error) throw new Error(chunk.error.message);
      const d = chunk.choices?.[0]?.delta;
      if (!d) continue;
      msg.content += d.content ?? '';
      msg.reasoning += d.reasoning ?? '';
      for (const a of d.annotations ?? [])
        if (a.url_citation?.url && !msg.annotations?.some(x => x.url_citation.url === a.url_citation.url)) (msg.annotations ??= []).push(a);
      for (const t of d.tool_calls ?? []) {
        let tc = byIndex[t.index];
        if (!tc) (msg.tool_calls ??= []).push(tc = byIndex[t.index] = { id: '', type: 'function', function: { name: '', arguments: '' } });
        if (t.id) tc.id = t.id;
        tc.function.name += t.function?.name ?? '';
        tc.function.arguments += t.function?.arguments ?? '';
      }
      render();
    }
  }
  return msg;
}

async function runAgent(chat) {
  const controller = running[chat.id] = new AbortController();
  render();
  let reply = '';
  try {
    for (;;) {
      const msg = await streamCompletion(chat, controller.signal);
      reply = msg.content;
      if (!msg.tool_calls?.length) break;
      const results = await Promise.all(msg.tool_calls.map(tc => runTool(tc, chat, msg)));
      msg.tool_calls.forEach((tc, i) => chat.messages.push({ role: 'tool', tool_call_id: tc.id, content: results[i] }));
      render();
    }
  } catch (e) {
    const last = chat.messages.at(-1);
    if (last.role === 'assistant') delete last.tool_calls;
    reply = e.name === 'AbortError' ? 'Stopped by user.' : `Error: ${e.message}`;
    if (e.name !== 'AbortError') chat.messages.push({ role: 'assistant', error: e.message });
  }
  delete running[chat.id];
  chat.updated = Date.now();
  persist();
  render();
  return reply || '(no reply)';
}

function send(text) {
  if (!localStorage.getItem('apiKey')) return alert('Add your OpenRouter key in the sidebar first.');
  if (!current.id) current = newChat(text.slice(0, 50));
  current.messages.push({ role: 'user', content: text });
  runAgent(current);
}

const STORAGE_SHIM = `<script>try{localStorage}catch(e){const m=()=>{const d={};return{getItem:k=>k in d?d[k]:null,setItem:(k,v)=>{d[k]=String(v)},removeItem:k=>{delete d[k]},clear:()=>{for(const k in d)delete d[k]},key:i=>Object.keys(d)[i]??null,get length(){return Object.keys(d).length}}};Object.defineProperty(window,'localStorage',{value:m()});Object.defineProperty(window,'sessionStorage',{value:m()})}<\/script>`;
const withShim = html => /<!doctype[^>]*>/i.test(html) ? html.replace(/<!doctype[^>]*>/i, m => m + STORAGE_SHIM) : STORAGE_SHIM + html;

function openArtifact({ title, html }) {
  $('#artifact').hidden = false;
  $('#art-title').textContent = title;
  $('#art-frame').srcdoc = withShim(html);
  $('#art-code').textContent = html;
}

function partialField(raw, key) {
  const m = raw.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`));
  if (!m) return '';
  try { return JSON.parse(`"${m[1].replace(/\\u?[0-9a-fA-F]{0,3}$/, '')}"`); } catch { return m[1]; }
}

const views = new WeakMap();

function syncChildren(el, nodes) {
  if (nodes.length !== el.children.length || nodes.some((n, i) => el.children[i] !== n)) el.replaceChildren(...nodes);
}

function part(v, key, make) {
  if (!v.parts.has(key)) v.parts.set(key, make());
  return v.parts.get(key);
}

function makeDetails() {
  const el = document.createElement('details');
  el.innerHTML = '<summary><span></span></summary><pre></pre>';
  return el;
}

function setDetails(el, label, text) {
  const span = el.querySelector('span');
  const pre = el.querySelector('pre');
  if (span.textContent !== label) span.textContent = label;
  if (pre.textContent !== text) {
    const follow = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 20;
    pre.textContent = text;
    if (follow) pre.scrollTop = pre.scrollHeight;
  }
  return el;
}

function renderTool(v, tc, i, result) {
  const raw = tc.function.arguments;
  const pending = result === undefined;
  const d = key => part(v, `${i}:${key}`, makeDetails);
  switch (tc.function.name) {
    case 'create_artifact': {
      let args = null;
      try { args = JSON.parse(raw); } catch {}
      if (!args) return setDetails(d('writing'), `📄 Writing artifact: ${partialField(raw, 'title') || '…'}`, partialField(raw, 'html'));
      const card = part(v, `${i}:card`, () => document.createElement('div'));
      card.className = 'artifact-card';
      card.textContent = `📄 ${args.title}`;
      card.onclick = () => openArtifact(args);
      return card;
    }
    case 'web_search':
      return setDetails(d('search'), `🔎 ${pending ? 'Searching' : 'Searched'}: ${partialField(raw, 'query') || '…'}`, result ?? '');
    case 'run_python':
      return setDetails(d('py'), pending ? '🐍 Running Python…' : '🐍 Ran Python', `${partialField(raw, 'code')}${pending ? '' : `\n\n── output ──\n${result}`}`);
    case 'spawn_subagent': {
      const title = partialField(raw, 'title');
      const el = setDetails(d('sub'), `${pending ? '⏳' : '✅'} Subagent: ${title || '…'}`, `${partialField(raw, 'task')}${pending ? '' : `\n\n── result ──\n${result}`}`);
      const sub = Object.values(state.chats).find(c => c.parent === current.id && c.title === `🤖 ${title}`);
      if (sub && !el.querySelector('a')) el.querySelector('summary').append(Object.assign(document.createElement('a'), { textContent: ' open', href: '#', onclick: e => { e.preventDefault(); openChat(sub); } }));
      return el;
    }
    case 'send_message': {
      const id = partialField(raw, 'chat_id');
      return setDetails(d('msg'), `${pending ? '⏳' : '✉️'} Message to ${state.chats[id]?.title ?? (id || '…')}`, `${partialField(raw, 'message')}${pending ? '' : `\n\n── reply ──\n${result}`}`);
    }
  }
  return setDetails(d('tool'), `🔧 ${tc.function.name}`, `${raw}${pending ? '' : `\n\n${result}`}`);
}

function renderMessage(m, results) {
  if (!views.has(m)) views.set(m, { el: document.createElement('div'), parts: new Map() });
  const v = views.get(m);
  v.el.className = `msg ${m.role}`;
  if (m.role === 'user') {
    if (v.el.textContent !== m.content) v.el.textContent = m.content;
    return v.el;
  }
  if (m.error) {
    v.el.className = 'msg error';
    v.el.textContent = m.error;
    return v.el;
  }
  const nodes = [];
  if (m.reasoning) nodes.push(setDetails(part(v, 'reasoning', makeDetails), m.content || m.tool_calls ? '💭 Thought' : '💭 Thinking…', m.reasoning));
  if (m.content) {
    const el = part(v, 'content', () => Object.assign(document.createElement('div'), { className: 'md' }));
    if (el.src !== m.content) {
      el.innerHTML = md(m.content);
      el.src = m.content;
    }
    nodes.push(el);
  }
  (m.tool_calls ?? []).forEach((tc, i) => nodes.push(renderTool(v, tc, i, results[tc.id])));
  if (m.annotations?.length) {
    const src = part(v, 'sources', () => Object.assign(document.createElement('div'), { className: 'sources' }));
    if (src.children.length !== m.annotations.length)
      src.replaceChildren(...m.annotations.map(({ url_citation: c }) =>
        Object.assign(document.createElement('a'), { href: c.url, target: '_blank', textContent: c.title || new URL(c.url).hostname })));
    nodes.push(src);
  }
  syncChildren(v.el, nodes);
  return v.el;
}

const workingIndicator = Object.assign(document.createElement('div'), { className: 'working', textContent: 'Working…' });
const emptyState = Object.assign(document.createElement('div'), { className: 'empty', textContent: 'Start a conversation.' });

function renderMessages() {
  const box = $('#messages');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const msgs = current.messages ?? [];
  const results = Object.fromEntries(msgs.filter(m => m.role === 'tool').map(m => [m.tool_call_id, m.content]));
  const nodes = msgs.length ? msgs.filter(m => m.role !== 'tool').map(m => renderMessage(m, results)) : [emptyState];
  syncChildren(box, running[current.id] ? [...nodes, workingIndicator] : nodes);
  if (atBottom) box.scrollTop = box.scrollHeight;
  $('#send').textContent = running[current.id] ? 'Stop' : 'Send';
}

function chatItem(c, depth) {
  const el = document.createElement('div');
  el.className = `chat-item${c === current ? ' active' : ''}`;
  el.style.paddingLeft = `${12 + depth * 14}px`;
  el.innerHTML = '<span></span><button title="Delete">×</button>';
  el.querySelector('span').textContent = (running[c.id] ? '● ' : '') + c.title;
  el.onclick = () => openChat(c);
  el.querySelector('button').onclick = e => {
    e.stopPropagation();
    delete state.chats[c.id];
    if (current === c) current = {};
    persist();
    render();
  };
  return el;
}

function renderSidebar() {
  const list = $('#chat-list');
  list.replaceChildren();
  const chats = Object.values(state.chats).sort((a, b) => b.updated - a.updated);
  const addTree = (parent, depth) => chats.filter(c => (c.parent ?? null) === parent).forEach(c => {
    list.append(chatItem(c, depth));
    addTree(c.id, depth + 1);
  });
  addTree(null, 0);
}

function renderArtifactMenu() {
  const arts = Object.entries(state.artifacts);
  $('#artifacts').replaceChildren(new Option(`Artifacts (${arts.length})`, ''), ...arts.map(([id, a]) => new Option(a.title, id)));
}

let renderQueued = false;
function render() {
  if (renderQueued) return;
  renderQueued = true;
  setTimeout(() => {
    renderQueued = false;
    renderSidebar();
    renderMessages();
    renderArtifactMenu();
  }, 30);
}

function openChat(chat) {
  current = chat;
  if (chat.model) $('#model').value = chat.model;
  $('#artifact').hidden = true;
  render();
  $('#input').focus();
}

async function loadModels() {
  const select = $('#model');
  const opt = ([id, name]) => new Option(name, id);
  select.append(...MODELS.map(opt));
  select.value = localStorage.getItem('model') ?? MODELS[0][0];
  const { data } = await (await fetch('https://openrouter.ai/api/v1/models')).json();
  const group = Object.assign(document.createElement('optgroup'), { label: 'All models' });
  group.append(...data.filter(m => m.supported_parameters?.includes('tools')).map(m => opt([m.id, m.name])));
  select.append(group);
  select.value = current.model ?? localStorage.getItem('model') ?? MODELS[0][0];
}

$('#model').onchange = e => {
  localStorage.setItem('model', e.target.value);
  if (current.id) current.model = e.target.value;
};
$('#api-key').value = localStorage.getItem('apiKey') ?? '';
$('#api-key').onchange = e => {
  localStorage.setItem('apiKey', e.target.value.trim());
  gate.hidden = !!e.target.value.trim();
  render();
};
const hashKey = new URLSearchParams(location.hash.slice(1)).get('key');
if (hashKey) {
  localStorage.setItem('apiKey', hashKey);
  $('#api-key').value = hashKey;
  history.replaceState(null, '', location.pathname);
}
const gate = $('#key-gate');
gate.hidden = !!localStorage.getItem('apiKey');
gate.querySelector('form').onsubmit = async e => {
  e.preventDefault();
  const key = gate.querySelector('input').value.trim();
  const res = await fetch('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) return gate.querySelector('.error').textContent = 'OpenRouter rejected that key.';
  localStorage.setItem('apiKey', key);
  $('#api-key').value = key;
  gate.hidden = true;
  render();
};
$('#new-chat').onclick = () => openChat({});
$('#artifacts').onchange = e => {
  const a = state.artifacts[e.target.value];
  if (a) openArtifact(a);
  e.target.value = '';
};
$('#toggle-sidebar').onclick = () => $('#sidebar').classList.toggle('hidden');
$('#art-close').onclick = () => $('#artifact').hidden = true;
$('#art-toggle').onclick = () => {
  const showCode = $('#art-code').hidden;
  $('#art-code').hidden = !showCode;
  $('#art-frame').hidden = showCode;
  $('#art-toggle').textContent = showCode ? 'Preview' : 'Code';
};
$('#art-newtab').onclick = () => {
  const page = `<!doctype html><meta charset="utf-8"><style>html,body,iframe{margin:0;width:100%;height:100%;border:0;display:block}</style>
<iframe sandbox="${$('#art-frame').getAttribute('sandbox')}"></iframe>
<script>document.title = ${JSON.stringify($('#art-title').textContent).replace(/</g, '\\u003c')}; document.querySelector('iframe').srcdoc = ${JSON.stringify(withShim($('#art-code').textContent)).replace(/</g, '\\u003c')};<\/script>`;
  open(URL.createObjectURL(new Blob([page], { type: 'text/html' })));
};
$('#art-download').onclick = () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([$('#art-code').textContent], { type: 'text/html' }));
  a.download = `${$('#art-title').textContent}.html`;
  a.click();
};

const input = $('#input');
input.oninput = () => { input.style.height = 'auto'; input.style.height = input.scrollHeight + 'px'; };
input.onkeydown = e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#composer').requestSubmit(); }
};
$('#composer').onsubmit = e => {
  e.preventDefault();
  if (running[current.id]) return running[current.id].abort();
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  input.oninput();
  send(text);
};

if (innerWidth <= 800) $('#sidebar').classList.add('hidden');
current = {};
loadModels();
render();
