import { buildBrowserMemoryDraft, captureToMemoryPayload, createPageCapture } from '../browser-extension/shared/schema.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const concreteConversation = createPageCapture({
  title: '了解用户背景',
  url: 'https://chatgpt.com/c/example',
  host: 'chatgpt.com',
  aiProvider: 'ChatGPT',
  description: 'ChatGPT 是一款供日常使用的 AI 聊天机器人。',
  turns: [
    {
      role: 'assistant',
      text: '我知道你是刘欣（Liu Xin），是一位有着 UI/UX、交互设计和产品设计背景的学生及产品设计师。在我们的交流中，你经常关注 AI 产品和用户体验。'
    },
    {
      role: 'user',
      text: '对，这个背景需要被记住，后续做 Agent Memory Lab 的产品迭代时要结合我的设计和用户体验背景。'
    }
  ]
});

const concreteDraft = buildBrowserMemoryDraft(concreteConversation);
assert(concreteDraft.content.includes('刘欣（Liu Xin）'), 'Concrete chat memory draft should keep the person identity.');
assert(/UI\/?UX|交互设计|产品设计/.test(concreteDraft.content), 'Concrete chat memory draft should keep design background facts.');
assert(!concreteDraft.content.includes('ChatGPT 是一款供日常使用'), 'Concrete chat memory draft must ignore generic product page descriptions.');
assert(!concreteDraft.content.includes('https://chatgpt.com'), 'Concrete chat memory draft must not be a link bookmark.');
assert(!concreteDraft.emptyReason, 'Concrete chat memory draft should not be empty.');

const concretePayload = captureToMemoryPayload(concreteConversation);
assert(concretePayload.content === concreteDraft.content, 'Memory payload should preserve the concrete draft content.');

const emptyConversation = createPageCapture({
  title: '了解用户背景',
  url: 'https://chatgpt.com/c/empty',
  host: 'chatgpt.com',
  aiProvider: 'ChatGPT',
  description: 'ChatGPT 是一款供日常使用的 AI 聊天机器人。',
  turns: []
});

const emptyDraft = buildBrowserMemoryDraft(emptyConversation);
assert(emptyDraft.content === '', 'Empty AI pages must not produce vague memory content.');
assert(emptyDraft.emptyReason, 'Empty AI pages should explain why there is no memory candidate.');
assert(!emptyDraft.title.includes('了解用户背景') || emptyDraft.title.includes('需要具体对话'), 'Empty AI pages must not use page title as memory fact.');

let threw = false;
try {
  captureToMemoryPayload(emptyConversation);
} catch (err) {
  threw = /具体对话|具体记忆|保存/.test(String(err && err.message ? err.message : err));
}
assert(threw, 'Empty AI pages must be blocked before entering the memory review payload.');

console.log('browser extension memory draft checks ok');
