import { getSettings } from './config.js';

const $ = (id) => document.getElementById(id);
const settings = await getSettings();
$('apiBase').value = settings.apiBase;
$('viewerBase').value = settings.viewerBase;
$('secret').value = settings.secret;

$('save').addEventListener('click', async () => {
  await chrome.storage.sync.set({
    apiBase: $('apiBase').value.trim() || 'http://localhost:3111',
    viewerBase: $('viewerBase').value.trim() || 'http://localhost:3113',
    secret: $('secret').value.trim()
  });
  $('message').textContent = '已保存';
  $('message').className = 'message ok';
});
