import { writeFileSync } from 'node:fs';
import sharp from 'sharp';

const outDir = 'docs/feishu/whiteboards';

function esc(text) {
  return String(text).replace(/[&<>"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'
  }[char]));
}

function card({ x, y, w, h, title, body, fill = '#ffffff', stroke = '#d8d0c3', accent = '#ff6b35' }) {
  return `
    <g>
      <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>
      <rect x="${x}" y="${y}" width="6" height="${h}" rx="3" fill="${accent}"/>
      <text x="${x + 24}" y="${y + 34}" font-size="24" font-weight="700" fill="#171717">${esc(title)}</text>
      ${body.map((line, i) => `<text x="${x + 24}" y="${y + 72 + i * 28}" font-size="17" fill="#57534e">${esc(line)}</text>`).join('')}
    </g>`;
}

function arrow(x1, y1, x2, y2, label = '') {
  const lx = (x1 + x2) / 2;
  const ly = (y1 + y2) / 2 - 12;
  return `
    <path d="M ${x1} ${y1} C ${(x1 + x2) / 2} ${y1}, ${(x1 + x2) / 2} ${y2}, ${x2} ${y2}" fill="none" stroke="#78716c" stroke-width="2.5" marker-end="url(#arrow)"/>
    ${label ? `<text x="${lx}" y="${ly}" text-anchor="middle" font-size="15" fill="#78716c">${esc(label)}</text>` : ''}`;
}

function shell({ title, subtitle, content }) {
  return `<svg width="1600" height="1000" viewBox="0 0 1600 1000" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" fill="#78716c"/>
      </marker>
      <filter id="soft" x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="0" dy="10" stdDeviation="12" flood-color="#292524" flood-opacity="0.10"/>
      </filter>
    </defs>
    <rect width="1600" height="1000" fill="#f7f2ea"/>
    <circle cx="1400" cy="150" r="90" fill="#ff6b35" opacity="0.08"/>
    <circle cx="150" cy="870" r="110" fill="#2f6f73" opacity="0.08"/>
    <text x="96" y="92" font-size="44" font-weight="800" fill="#171717">${esc(title)}</text>
    <text x="96" y="132" font-size="20" fill="#57534e">${esc(subtitle)}</text>
    <g filter="url(#soft)">${content}</g>
  </svg>`;
}

const workflow = shell({
  title: 'Agent Memory Lab 产品工作流',
  subtitle: '插件负责捕捉线索，工作台负责审阅，记忆库负责长期复用。',
  content: `
    ${card({ x: 92, y: 220, w: 300, h: 170, title: '网页 / AI 对话', body: ['当前页面、选中文本', 'ChatGPT / Claude 等对话', '只读取用户主动打开的页面'], accent: '#2f6f73' })}
    ${card({ x: 474, y: 180, w: 310, h: 210, title: '浏览器插件', body: ['生成 PageCapture', '提炼具体候选记忆', '显示本地记忆建议', '复制结构化诊断信息'], accent: '#ff6b35' })}
    ${card({ x: 866, y: 220, w: 300, h: 170, title: '本地 API', body: ['统一接收候选内容', '写入待审阅队列', '连接 Viewer 和本地数据'], accent: '#8b5cf6' })}
    ${card({ x: 1248, y: 180, w: 300, h: 210, title: 'Viewer 工作台', body: ['总览、记忆、会话', 'Skill、行动、活动', '保存前编辑和确认'], accent: '#0f766e' })}
    ${card({ x: 474, y: 590, w: 310, h: 190, title: '长期记忆 / 经验', body: ['长期记忆来自审阅', '经验可沉淀为 Skill 草稿', '不把临时噪音直接写死'], accent: '#f59e0b' })}
    ${card({ x: 866, y: 590, w: 300, h: 190, title: '可交付检查', body: ['插件打包', '隐私诊断保护', '真实 AI 站点证据'], accent: '#2563eb' })}
    ${arrow(392, 305, 474, 285, '捕捉')}
    ${arrow(784, 285, 866, 305, '送审')}
    ${arrow(1166, 305, 1248, 285, '展示')}
    ${arrow(1398, 390, 1020, 590, '确认后写入')}
    ${arrow(784, 685, 866, 685, '验证')}
  `
});

const structure = shell({
  title: '仓库结构与交付边界',
  subtitle: '主仓库包含工作台、浏览器入口、文档和交付检查；公开发布仍由真实站点证据把关。',
  content: `
    ${card({ x: 90, y: 180, w: 330, h: 220, title: 'src / dist', body: ['Viewer 与本地服务源码', '构建后进入 dist', '负责工作台主体验'], accent: '#0f766e' })}
    ${card({ x: 480, y: 180, w: 330, h: 220, title: 'browser-extension', body: ['Chrome 插件 MVP', 'popup / sidepanel / content script', '统一 PageCapture 数据'], accent: '#ff6b35' })}
    ${card({ x: 870, y: 180, w: 330, h: 220, title: 'docs / feishu', body: ['README 图文版', '飞书项目说明源稿', '隐私、验收、交付文档'], accent: '#8b5cf6' })}
    ${card({ x: 1260, y: 180, w: 250, h: 220, title: 'scripts', body: ['打包插件', '交付检查', '真实站点证据检查'], accent: '#2563eb' })}
    ${card({ x: 220, y: 570, w: 360, h: 210, title: '公司仓库 PR', body: ['novitalabs/agentmemory-lab', '受保护分支必须走 PR', '当前交付进入审核流'], accent: '#111827' })}
    ${card({ x: 700, y: 570, w: 360, h: 210, title: '试用可交付', body: ['本地 Viewer', '插件 zip', '外测说明和反馈模板'], accent: '#f59e0b' })}
    ${card({ x: 1180, y: 570, w: 300, h: 210, title: '公开发布门槛', body: ['真实 AI 站点 4/4', 'ChatGPT / Claude', 'Gemini / Perplexity'], accent: '#dc2626' })}
    ${arrow(420, 290, 480, 290, '连接')}
    ${arrow(810, 290, 870, 290, '说明')}
    ${arrow(1200, 290, 1260, 290, '检查')}
    ${arrow(645, 400, 430, 570, '推送')}
    ${arrow(1035, 400, 880, 570, '打包')}
    ${arrow(1385, 400, 1330, 570, '门槛')}
  `
});

for (const [name, svg] of Object.entries({ workflow, structure })) {
  const svgPath = `${outDir}/${name}.svg`;
  const pngPath = `${outDir}/${name}.png`;
  writeFileSync(svgPath, svg);
  await sharp(Buffer.from(svg)).png().toFile(pngPath);
  console.log(`${pngPath}`);
}
