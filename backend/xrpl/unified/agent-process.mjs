// The AI AGENT PROCESS. It runs a local LLM (Ollama /api/chat with tools) and can only CALL TOOLS: every tool call is
// sent to the parent (Eterna's tool host) over IPC and the parent's answer comes back as the tool result.
// It holds no key material and cannot read any: the parent forks it under the Node permission model with fs reads
// limited to this file, no fs writes, no child processes, no workers, and an empty environment (see agentSpawnOptions in
// agent-tools.mjs). It imports nothing but node builtins and talks to one host: the local Ollama URL it is given.
// Protocol (all messages are plain JSON):
//   parent -> child  { type:'probe', path } -> child { type:'probe_result', path, readable, code }
//   parent -> child  { type:'start', ollamaUrl, model, system, user, tools, options, think, maxTurns }
//   child  -> parent { type:'llm', turn, request:{ messageCount }, response:{ message, eval_count, ... } }
//   child  -> parent { type:'tool_call', id, turn, name, arguments }   parent -> child { type:'tool_result', id, result }
//   child  -> parent { type:'done', reason, turns }  |  { type:'error', message }
import { readdirSync } from 'node:fs';

const pending = new Map();
let nextId = 1;
const callTool = (turn, name, args) => new Promise((resolve) => {
  const id = nextId++;
  pending.set(id, resolve);
  process.send({ type: 'tool_call', id, turn, name, arguments: args });
});
process.on('message', async (m) => {
  if (m?.type === 'probe') { // isolation self-check: list (never read) the given directory; under the permission model this must fail
    let readable = false, code = null;
    if (m.path) { try { readdirSync(m.path); readable = true; } catch (e) { code = e.code ?? 'ERROR'; } }
    process.send({ type: 'probe_result', path: m.path, readable, code });
    return;
  }
  if (m?.type === 'tool_result') { const r = pending.get(m.id); pending.delete(m.id); r?.(m.result); return; }
  if (m?.type === 'start') {
    try { process.send({ type: 'done', ...(await run(m)) }); } catch (e) { process.send({ type: 'error', message: String(e?.message ?? e) }); }
    process.disconnect();
  }
});

async function run({ ollamaUrl, model, system, user, tools, options, think = false, maxTurns = 12 }) {
  const u = new URL(ollamaUrl);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) throw new Error(`ollama must be local, got ${u.hostname}`);
  const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
  for (let turn = 1; turn <= maxTurns; turn++) {
    const body = { model, messages, tools, stream: false, think, options };
    const res = await fetch(new URL('/api/chat', u), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(600000) });
    const j = await res.json();
    if (!res.ok || !j.message) throw new Error(`ollama ${res.status}: ${JSON.stringify(j).slice(0, 300)}`);
    const { message, eval_count, prompt_eval_count, total_duration, done_reason, model: servedModel } = j;
    process.send({ type: 'llm', turn, request: { messageCount: messages.length }, response: { model: servedModel, message, eval_count, prompt_eval_count, total_duration, done_reason } });
    const calls = message.tool_calls ?? [];
    messages.push({ role: 'assistant', content: message.content ?? '', ...(calls.length ? { tool_calls: calls } : {}) });
    if (!calls.length) {
      const nudge = 'Use the tools. When you are done, call finish with your summary for the finance team.';
      messages.push({ role: 'user', content: nudge });
      process.send({ type: 'nudge', turn, content: nudge }); // recorded in the transcript: a fixed harness message, not Rose
      continue;
    }
    for (const c of calls) {
      const name = c.function?.name, args = c.function?.arguments ?? {};
      const result = await callTool(turn, name, typeof args === 'string' ? safeParse(args) : args);
      messages.push({ role: 'tool', tool_name: name, content: JSON.stringify(result) });
      if (name === 'finish' && result?.ok) return { reason: 'finish', turns: turn };
    }
  }
  return { reason: 'max_turns', turns: maxTurns };
}
function safeParse(s) { try { return JSON.parse(s); } catch { return { _unparsed: s }; } }
