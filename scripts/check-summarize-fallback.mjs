import { registerSummarizeFunction } from '../src/functions/summarize.ts';
import { StateKV } from '../src/state/kv.ts';
import { KV } from '../src/state/schema.ts';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

class MemorySdk {
  constructor() {
    this.functions = new Map();
    this.store = new Map();
  }

  registerFunction(id, fn) {
    this.functions.set(id, fn);
  }

  async trigger({ function_id, payload }) {
    if (function_id === 'state::get') {
      return this.store.get(`${payload.scope}:${payload.key}`) || null;
    }
    if (function_id === 'state::set') {
      this.store.set(`${payload.scope}:${payload.key}`, payload.value);
      return payload.value;
    }
    if (function_id === 'state::list') {
      const prefix = `${payload.scope}:`;
      return Array.from(this.store.entries())
        .filter(([key]) => key.startsWith(prefix))
        .map(([, value]) => value);
    }
    const fn = this.functions.get(function_id);
    if (!fn) throw new Error(`Unknown function: ${function_id}`);
    return fn(payload);
  }
}

const sdk = new MemorySdk();
const kv = new StateKV(sdk);
const session = {
  id: 'ses_fallback_test',
  project: 'agentmemory-lab',
  cwd: '/tmp/agentmemory-lab',
  startedAt: '2026-06-09T00:00:00.000Z',
  status: 'completed',
  observationCount: 3,
  firstPrompt: '修复会话摘要按钮老是失败的问题'
};
const observations = [
  {
    id: 'obs_1',
    sessionId: session.id,
    timestamp: '2026-06-09T00:00:01.000Z',
    type: 'conversation',
    title: '用户指出问题',
    facts: ['会话详情里的生成摘要按钮经常显示生成失败'],
    narrative: '用户希望摘要按钮不要在缺少模型配置时直接失败。',
    concepts: ['viewer', 'summary'],
    files: [],
    importance: 8
  },
  {
    id: 'obs_2',
    sessionId: session.id,
    timestamp: '2026-06-09T00:00:02.000Z',
    type: 'decision',
    title: '增加本地摘要兜底',
    facts: ['没有 LLM provider 时用本地规则从 observation 生成摘要'],
    narrative: '摘要生成需要符合本地优先，不应依赖远端模型才可用。',
    concepts: ['local-first', 'fallback'],
    files: ['src/functions/summarize.ts'],
    importance: 9
  },
  {
    id: 'obs_3',
    sessionId: session.id,
    timestamp: '2026-06-09T00:00:03.000Z',
    type: 'file_edit',
    title: '更新前端提示',
    facts: ['按钮区分已生成摘要和已生成本地摘要'],
    narrative: '前端不再把所有失败都显示成生成失败。',
    concepts: ['ux'],
    files: ['src/viewer/index.html'],
    importance: 7
  }
];

await kv.set(KV.sessions, session.id, session);
for (const observation of observations) {
  await kv.set(KV.observations(session.id), observation.id, observation);
}

registerSummarizeFunction(sdk, kv, {
  name: 'noop',
  async compress() {
    return '';
  },
  async summarize() {
    throw new Error('noop provider should not be called');
  }
});

const result = await sdk.trigger({ function_id: 'mem::summarize', payload: { sessionId: session.id } });
assert(result && result.success === true, 'No-provider summarize should succeed with local fallback.');
assert(result.fallback === true, 'No-provider summarize result should be marked as fallback.');
assert(result.reason === 'no_provider', 'No-provider summarize should preserve the fallback reason.');
assert(result.summary && result.summary.sessionId === session.id, 'Fallback summary should include the session id.');
assert(result.summary.narrative.includes('本地规则兜底'), 'Fallback summary should explain that it used local rules.');
assert(result.summary.keyDecisions.length > 0, 'Fallback summary should extract readable key decisions.');

const stored = await kv.get(KV.summaries, session.id);
assert(stored && stored.sessionId === session.id, 'Fallback summary should be saved to the summaries store.');

console.log('summarize fallback checks ok');
