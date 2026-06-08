import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

function read(file) {
  return readFileSync(file, 'utf8');
}

function readJson(file) {
  return JSON.parse(read(file));
}

function pass(value) {
  if (value === true) return true;
  const text = String(value || '').toLowerCase();
  return ['通过', '已通过', 'pass', 'passed', 'ok'].some((word) => text.includes(word));
}

function providerName(value) {
  const text = String(value || '').toLowerCase();
  if (text.includes('chatgpt')) return 'ChatGPT';
  if (text.includes('claude')) return 'Claude';
  if (text.includes('gemini')) return 'Gemini';
  if (text.includes('perplexity')) return 'Perplexity';
  if (text.includes('grok')) return 'Grok';
  if (text.includes('deepseek')) return 'DeepSeek';
  return String(value || 'Unknown').trim();
}

function evidencePassed(item) {
  const ai = item.data.ai || {};
  const manual = item.data.manualValidation || {};
  const matched = ai.matchedSelectors || {};
  return !!(
    ai.supportedAiPage &&
    ai.provider &&
    ai.editorFound &&
    matched.editor &&
    ai.anchorFound &&
    matched.anchor &&
    ai.memoryWidgetVisible &&
    ai.placement &&
    matched.send &&
    matched.turn &&
    ai.checkedAt &&
    pass(manual.memoryInsertPassed) &&
    pass(manual.diagnosticsCopied) &&
    pass(manual.siteInputStillWorks)
  );
}

function dateOf(item) {
  const value = item.data.ai?.checkedAt || item.data.generatedAt || '';
  return value ? String(value).slice(0, 10) : '-';
}

function evidenceRow(product, domain, item) {
  if (!item) {
    return `| ${product} | \`${domain}\` | 待验收 | 待验收 | 待验收 | 待验收 | 待验收 | 待验收 | - | - |`;
  }
  const ai = item.data.ai || {};
  const manual = item.data.manualValidation || {};
  const matched = ai.matchedSelectors || {};
  const ok = evidencePassed(item);
  const status = ok ? '已通过' : '待修复';
  return [
    `| ${product}`,
    ` \`${domain}\``,
    ` ${providerName(ai.provider) === product ? '已通过' : '待修复'}`,
    ` ${ai.editorFound && matched.editor ? '已通过' : '待修复'}`,
    ` ${ai.memoryWidgetVisible ? '已通过' : '待修复'}`,
    ` ${pass(manual.memoryInsertPassed) ? '已通过' : '待修复'}`,
    ` ${pass(manual.diagnosticsCopied) ? '已通过' : '待修复'}`,
    ` ${status}`,
    ` ${dateOf(item)}`,
    ` ${item.file}${matched.editor || matched.anchor || matched.send || matched.turn ? `；selector: ${[matched.editor, matched.anchor, matched.send, matched.turn].filter(Boolean).join(' / ')}` : ''} |`
  ].join(' |').replace(/\| \|/g, '|');
}

function latestEvidenceByProvider() {
  const dir = 'docs/validation/browser-extension-ai-sites';
  if (!existsSync(dir)) return new Map();
  const items = readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => {
      const fullPath = path.join(dir, file);
      const data = readJson(fullPath);
      return { file: fullPath, data, provider: providerName(data.ai?.provider), checkedAt: data.ai?.checkedAt || data.generatedAt || '' };
    })
    .sort((a, b) => String(b.checkedAt).localeCompare(String(a.checkedAt)));
  const byProvider = new Map();
  for (const item of items) {
    if (!byProvider.has(item.provider)) byProvider.set(item.provider, item);
  }
  return byProvider;
}

const write = process.argv.includes('--write');
const check = process.argv.includes('--check');
const validationPath = 'docs/browser-extension-ai-validation-cn.md';
const products = [
  ['ChatGPT', 'chatgpt.com'],
  ['Claude', 'claude.ai'],
  ['Gemini', 'gemini.google.com'],
  ['Perplexity', 'www.perplexity.ai'],
  ['Grok', 'grok.com'],
  ['DeepSeek', 'chat.deepseek.com']
];

const evidence = latestEvidenceByProvider();
const rows = [
  '| 产品 | 目标域名 | Provider | 输入框 | 记忆提示 | 插入 | 复制诊断 | 结果 | 日期 | 证据/备注 |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ...products.map(([product, domain]) => evidenceRow(product, domain, evidence.get(product)))
].join('\n');

const markdown = read(validationPath);
const pattern = /\| 产品 \| 目标域名 \| Provider \| 输入框 \| 记忆提示 \| 插入 \| 复制诊断 \| 结果 \| 日期 \| 证据\/备注 \|\n\| --- \| --- \| --- \| --- \| --- \| --- \| --- \| --- \| --- \| --- \|\n(?:\|.*\|\n?)+?(?=\n## 诊断 JSON 示例)/;
if (!pattern.test(markdown)) throw new Error('Could not locate AI validation table.');
const next = markdown.replace(pattern, rows);

if (check && next !== markdown) {
  console.error('AI validation table is out of sync. Run npm run sync:ai-validation-table.');
  process.exit(1);
}

if (write && next !== markdown) {
  writeFileSync(validationPath, next);
  console.log(`updated ${validationPath}`);
} else if (write) {
  console.log('AI validation table already up to date');
} else if (!check) {
  console.log(rows);
}

if (check) console.log('AI validation table sync check ok');
