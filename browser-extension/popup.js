import { getSettings } from './config.js';

const $ = (id) => document.getElementById(id);
let settings = await getSettings();

function setMessage(text, kind = '') {
  $('message').textContent = text || '';
  $('message').className = `message ${kind}`.trim();
}

async function send(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response || !response.ok) throw new Error((response && response.error) || '操作失败');
  return response.data;
}

async function refresh() {
  try {
    const health = await send('HEALTH');
    $('status').textContent = health && health.status === 'ok' ? '本地服务已连接' : '本地服务可访问';
  } catch {
    $('status').textContent = '未连接本地服务';
  }

  try {
    const page = await send('COLLECT_PAGE');
    $('pageTitle').textContent = page.title || '当前页面';
    $('pageUrl').textContent = page.url || '';
  } catch (err) {
    $('pageTitle').textContent = '无法读取当前页面';
    $('pageUrl').textContent = err.message || '';
  }
}

$('saveMemory').addEventListener('click', async () => {
  $('saveMemory').disabled = true;
  setMessage('正在保存网页线索...');
  try {
    await send('SAVE_PAGE_MEMORY');
    setMessage('已保存为记忆线索', 'ok');
  } catch (err) {
    setMessage(err.message || '保存失败', 'error');
  } finally {
    $('saveMemory').disabled = false;
  }
});

$('saveLesson').addEventListener('click', async () => {
  const note = $('lessonNote').value.trim();
  if (!note) return setMessage('先写一条经验再保存', 'error');
  $('saveLesson').disabled = true;
  setMessage('正在保存经验...');
  try {
    await send('SAVE_PAGE_LESSON', { note });
    $('lessonNote').value = '';
    setMessage('经验已保存', 'ok');
  } catch (err) {
    setMessage(err.message || '保存失败', 'error');
  } finally {
    $('saveLesson').disabled = false;
  }
});

$('openWorkbench').addEventListener('click', () => chrome.tabs.create({ url: `${settings.viewerBase}/#dashboard` }));
$('openSkills').addEventListener('click', () => chrome.tabs.create({ url: `${settings.viewerBase}/#lessons` }));
$('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());

refresh();
