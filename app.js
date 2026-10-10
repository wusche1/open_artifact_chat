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
  { type: 'openrouter:web_search' },
  { type: 'openrouter:web_fetch' },
  fn('run_python', 'Run Python code (Pyodide, in the user\'s browser) and return stdout plus the value of the last expression. Packages like numpy and pandas are auto-loaded from imports.', { code: str('Python code') }),
  fn('create_artifact', 'Show the user a rendered HTML artifact in a side panel: web pages, apps, games, visualizations, diagrams, documents. Artifacts are shared across all chats in the project. Pass a complete self-contained HTML document; libraries may be loaded from cdnjs or jsdelivr. To revise an artifact (including one made by another chat), call again with the same id and the full updated HTML.',
    { id: str('Short slug, reuse to update'), title: str('Title'), html: str('Full HTML document') }),
  fn('list_artifacts', 'List all artifacts in this project.', {}),
  fn('read_artifact', 'Get the HTML of a project artifact.', { id: str('Artifact id') }),
  fn('list_chats', 'List the other chats (agents) in this project.', {}),
  fn('send_message', 'Send a message to another chat (agent) in this project. It runs and its reply is returned.', { chat_id: str('Target chat id'), message: str('Message') }),
];
const SPAWN = fn('spawn_subagent', 'Spawn a subagent in a new chat to do a self-contained task; returns its final answer. Call several at once to run them in parallel.',
  { title: str('Short title'), task: str('Complete instructions; the subagent sees nothing else'), model: str('Optional OpenRouter model id, defaults to yours') }, ['title', 'task']);

const $ = s => document.querySelector(s);
const uid = () => crypto.randomUUID().slice(0, 8);
const load = (k, d) => JSON.parse(localStorage.getItem(k)) ?? d;
const md = s => DOMPurify.sanitize(marked.parse(s));

const state = load('state', { projects: {}, chats: {} });
const persist = () => localStorage.setItem('state', JSON.stringify(state));
const running = {};
let current = null;

function newProject(name) {
  const p = { id: uid(), name, artifacts: {}, created: Date.now() };
  state.projects[p.id] = p;
  persist();
  return p;
}

function newChat(projectId, title, parent) {
  const c = { id: uid(), projectId, title, parent, model: $('#model').value, messages: [], updated: Date.now() };
  state.chats[c.id] = c;
  return c;
}

const chatsIn = projectId => Object.values(state.chats).filter(c => c.projectId === projectId);
if (!Object.keys(state.projects).length) newProject('General');

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

async function runTool(tc, chat) {
  const args = JSON.parse(tc.function.arguments || '{}');
  const project = state.projects[chat.projectId];
  switch (tc.function.name) {
    case 'run_python': return runPython(args.code);
    case 'create_artifact':
      project.artifacts[args.id] = { title: args.title, html: args.html, chatId: chat.id, updated: Date.now() };
      if (chat === current) openArtifact(args);
      return 'Artifact displayed to the user.';
    case 'list_artifacts':
      return Object.entries(project.artifacts).map(([id, a]) => `${id}: ${a.title} (by chat ${a.chatId})`).join('\n') || 'No artifacts yet.';
    case 'read_artifact': return project.artifacts[args.id]?.html ?? 'No such artifact.';
    case 'list_chats':
      return chatsIn(chat.projectId).filter(c => c !== chat)
        .map(c => `${c.id}: ${c.title}${c.parent ? ` (subagent of ${c.parent})` : ''}${running[c.id] ? ' [busy]' : ''}`).join('\n') || 'No other chats.';
    case 'send_message': {
      const target = state.chats[args.chat_id];
      if (!target || target.projectId !== chat.projectId) return 'No such chat in this project.';
      if (running[target.id]) return 'That agent is busy right now.';
      target.messages.push({ role: 'user', content: `[Message from chat "${chat.title}" (${chat.id})]\n${args.message}` });
      return runAgent(target);
    }
    case 'spawn_subagent': {
      const sub = newChat(chat.projectId, `🤖 ${args.title}`, chat.id);
      sub.model = args.model || chat.model;
      sub.messages.push({ role: 'user', content: args.task });
      return runAgent(sub);
    }
  }
  return `Unknown tool ${tc.function.name}`;
}

function systemPrompt(chat) {
  const project = state.projects[chat.projectId];
  return `You are a helpful assistant. Today is ${new Date().toDateString()}.
You are chat "${chat.title}" (id ${chat.id}) in project "${project.name}". The project's other chats are other agents: you can list and message them, and all chats share the project's artifacts.
Use web search/fetch for anything current or uncertain and cite sources. Use run_python for computation.
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
      if (d.annotations) (msg.annotations ??= []).push(...d.annotations);
      for (const t of d.tool_calls ?? []) {
        const tc = ((msg.tool_calls ??= [])[t.index] ??= { id: '', type: 'function', function: { name: '', arguments: '' } });
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
      const results = await Promise.all(msg.tool_calls.map(tc => runTool(tc, chat)));
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
  if (!current.id) current = newChat(current.projectId, text.slice(0, 50));
  current.messages.push({ role: 'user', content: text });
  runAgent(current);
}

function openArtifact({ title, html }) {
  $('#artifact').hidden = false;
  $('#art-title').textContent = title;
  $('#art-frame').srcdoc = html;
  $('#art-code').textContent = html;
}

function details(label, text) {
  const el = document.createElement('details');
  el.innerHTML = '<summary></summary><pre></pre>';
  el.querySelector('summary').textContent = label;
  el.querySelector('pre').textContent = text;
  return el;
}

function partialArgs(tc) {
  try { return JSON.parse(tc.function.arguments); } catch { return null; }
}

function renderTool(tc, result) {
  const args = partialArgs(tc);
  const pending = result === undefined;
  switch (tc.function.name) {
    case 'create_artifact': {
      if (!args) return details('📄 Creating artifact…', '');
      const card = document.createElement('div');
      card.className = 'artifact-card';
      card.textContent = `📄 ${args.title}`;
      card.onclick = () => openArtifact(args);
      return card;
    }
    case 'run_python':
      return details(pending ? '🐍 Running Python…' : '🐍 Ran Python', `${args?.code ?? tc.function.arguments}\n\n── output ──\n${result ?? ''}`);
    case 'spawn_subagent': {
      const el = details(`${pending ? '⏳' : '✅'} Subagent: ${args?.title ?? '…'}`, `${args?.task ?? ''}\n\n── result ──\n${result ?? ''}`);
      const sub = Object.values(state.chats).find(c => c.parent === current.id && c.title === `🤖 ${args?.title}`);
      if (sub) el.querySelector('summary').append(Object.assign(document.createElement('a'), { textContent: ' open', href: '#', onclick: e => { e.preventDefault(); openChat(sub); } }));
      return el;
    }
    case 'send_message': {
      const target = state.chats[args?.chat_id];
      return details(`${pending ? '⏳' : '✉️'} Message to ${target?.title ?? args?.chat_id ?? '…'}`, `${args?.message ?? ''}\n\n── reply ──\n${result ?? ''}`);
    }
  }
  return details(`🔧 ${tc.function.name}`, `${tc.function.arguments}\n\n${result ?? ''}`);
}

function renderMessage(m, results) {
  const el = document.createElement('div');
  el.className = `msg ${m.role}`;
  if (m.role === 'user') {
    el.textContent = m.content;
    return el;
  }
  if (m.error) {
    el.innerHTML = '<div class="error"></div>';
    el.firstChild.textContent = m.error;
    return el;
  }
  if (m.reasoning) el.append(details('Thinking', m.reasoning));
  if (m.content) el.insertAdjacentHTML('beforeend', `<div class="md">${md(m.content)}</div>`);
  for (const tc of m.tool_calls ?? []) el.append(renderTool(tc, results[tc.id]));
  if (m.annotations?.length) {
    const src = document.createElement('div');
    src.className = 'sources';
    for (const { url_citation: c } of m.annotations)
      src.append(Object.assign(document.createElement('a'), { href: c.url, target: '_blank', textContent: c.title || new URL(c.url).hostname }));
    el.append(src);
  }
  return el;
}

function renderMessages() {
  const box = $('#messages');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const openDetails = [...box.querySelectorAll('details')].map(d => d.open);
  const msgs = current.messages ?? [];
  const results = Object.fromEntries(msgs.filter(m => m.role === 'tool').map(m => [m.tool_call_id, m.content]));
  box.replaceChildren(...msgs.filter(m => m.role !== 'tool').map(m => renderMessage(m, results)));
  box.querySelectorAll('details').forEach((d, i) => d.open = openDetails[i] ?? false);
  if (!msgs.length) box.innerHTML = `<div class="empty">${localStorage.getItem('apiKey') ? `New chat in <b>${state.projects[current.projectId].name}</b>` : 'Paste your OpenRouter key in the sidebar to start.'}</div>`;
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
    if (current === c) current = { projectId: c.projectId };
    persist();
    render();
  };
  return el;
}

function renderSidebar() {
  const list = $('#chat-list');
  list.replaceChildren();
  for (const p of Object.values(state.projects).sort((a, b) => a.created - b.created)) {
    const head = document.createElement('div');
    head.className = `project${p.id === current.projectId ? ' active' : ''}`;
    head.innerHTML = '<span></span><button title="New chat">+</button><button title="Delete project">×</button>';
    head.querySelector('span').textContent = p.name;
    head.querySelector('span').ondblclick = () => { p.name = prompt('Rename project', p.name) || p.name; persist(); render(); };
    head.querySelector('[title="New chat"]').onclick = () => openChat({ projectId: p.id });
    head.querySelector('[title="Delete project"]').onclick = () => {
      if (!confirm(`Delete project "${p.name}" and all its chats?`)) return;
      chatsIn(p.id).forEach(c => delete state.chats[c.id]);
      delete state.projects[p.id];
      if (!Object.keys(state.projects).length) newProject('General');
      if (!state.projects[current.projectId]) current = { projectId: Object.keys(state.projects)[0] };
      persist();
      render();
    };
    list.append(head);
    const chats = chatsIn(p.id).sort((a, b) => b.updated - a.updated);
    const addTree = (parent, depth) => chats.filter(c => (c.parent ?? null) === parent).forEach(c => {
      list.append(chatItem(c, depth));
      addTree(c.id, depth + 1);
    });
    addTree(null, 0);
  }
}

function renderArtifactMenu() {
  const arts = Object.entries(state.projects[current.projectId].artifacts);
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
$('#api-key').onchange = e => { localStorage.setItem('apiKey', e.target.value.trim()); render(); };
$('#new-chat').onclick = () => openChat({ projectId: current.projectId });
$('#new-project').onclick = () => {
  const name = prompt('Project name');
  if (name) openChat({ projectId: newProject(name).id });
};
$('#artifacts').onchange = e => {
  const a = state.projects[current.projectId].artifacts[e.target.value];
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
current = { projectId: Object.values(state.projects).sort((a, b) => a.created - b.created)[0].id };
loadModels();
render();
