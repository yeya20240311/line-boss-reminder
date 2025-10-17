import express from 'express';
import { Client, middleware } from '@line/bot-sdk';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import cron from 'node-cron';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
dayjs.extend(utc);
dayjs.extend(timezone);

dotenv.config();

const PORT = process.env.PORT || 10000;
const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const USER_ID = process.env.USER_ID; // 推播對象

if (!CHANNEL_SECRET || !CHANNEL_ACCESS_TOKEN || !USER_ID) {
  console.error('請先設定環境變數 LINE_CHANNEL_SECRET、LINE_CHANNEL_ACCESS_TOKEN 與 USER_ID');
  process.exit(1);
}

const client = new Client({
  channelAccessToken: CHANNEL_ACCESS_TOKEN,
  channelSecret: CHANNEL_SECRET,
});

const app = express();
const WEBHOOK_PATH = '/webhook';

// JSON 檔案存放
const DATA_FILE = path.resolve('./boss.json');
let bossData = {};

// 讀取 JSON
function loadBossData() {
  if (fs.existsSync(DATA_FILE)) {
    bossData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } else {
    bossData = {};
    fs.writeFileSync(DATA_FILE, JSON.stringify(bossData, null, 2));
  }
}

// 儲存 JSON
function saveBossData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(bossData, null, 2));
}

// 計算剩餘時間
function getRemaining(boss) {
  if (!boss.nextSpawn) return null;
  const now = dayjs();
  const diff = dayjs(boss.nextSpawn).diff(now, 'minute');
  if (diff <= 0) return '已重生';
  const hours = Math.floor(diff / 60);
  const minutes = diff % 60;
  return `${hours}小時${minutes}分`;
}

// webhook 用原始 body
app.post(WEBHOOK_PATH, express.raw({ type: 'application/json' }), middleware({ channelSecret: CHANNEL_SECRET }), async (req, res) => {
  try {
    const events = JSON.parse(req.body.toString()).events;

    for (const event of events) {
      if (event.type !== 'message' || event.message.type !== 'text') continue;
      const text = event.message.text.trim();
      const replyToken = event.replyToken;

      if (text === '/幫助') {
        await client.replyMessage(replyToken, {
          type: 'text',
          text: `指令列表：
/幫助
/設定 王名 小時
/重生 王名 剩餘小時.分
/刪除 王名
/BOSS`,
        });
      } else if (text.startsWith('/設定 ')) {
        const [, name, hours] = text.split(' ');
        if (!name || !hours) {
          await client.replyMessage(replyToken, { type: 'text', text: '格式錯誤：/設定 王名 小時' });
          continue;
        }
        bossData[name] = bossData[name] || {};
        bossData[name].intervalHours = Number(hours);
        saveBossData();
        await client.replyMessage(replyToken, { type: 'text', text: `📝 已設定 ${name} 重生間隔 ${hours} 小時` });
      } else if (text.startsWith('/重生 ')) {
        const [, name, remaining] = text.split(' ');
        if (!name || !remaining) {
          await client.replyMessage(replyToken, { type: 'text', text: '格式錯誤：/重生 王名 剩餘小時.分' });
          continue;
        }
        const [h, m] = remaining.split('.').map(Number);
        if (isNaN(h) || isNaN(m)) {
          await client.replyMessage(replyToken, { type: 'text', text: '剩餘時間格式錯誤，範例：3.06' });
          continue;
        }
        const now = dayjs();
        bossData[name] = bossData[name] || {};
        bossData[name].nextSpawn = now.add(h, 'hour').add(m, 'minute').toISOString();
        saveBossData();
        await client.replyMessage(replyToken, { type: 'text', text: `🕒 已登記 ${name} 將於 ${dayjs(bossData[name].nextSpawn).format('HH:mm')} 重生` });
      } else if (text.startsWith('/刪除 ')) {
        const [, name] = text.split(' ');
        if (bossData[name]) {
          delete bossData[name];
          saveBossData();
          await client.replyMessage(replyToken, { type: 'text', text: `❌ 已刪除 ${name}` });
        } else {
          await client.replyMessage(replyToken, { type: 'text', text: `${name} 不存在` });
        }
      } else if (text === '/BOSS') {
        const lines = [];
        const now = dayjs();
        for (const [name, boss] of Object.entries(bossData)) {
          if (!boss.nextSpawn) continue;
          const remaining = getRemaining(boss);
          lines.push(`🕓 ${name} 剩餘 ${remaining}（重生時間：${dayjs(boss.nextSpawn).format('YYYY-MM-DD HH:mm')}）`);
        }
        lines.sort((a, b) => {
          const aMin = dayjs(bossData[a.split(' ')[1]].nextSpawn).diff(now, 'minute');
          const bMin = dayjs(bossData[b.split(' ')[1]].nextSpawn).diff(now, 'minute');
          return aMin - bMin;
        });
        await client.replyMessage(replyToken, { type: 'text', text: lines.join('\n') || '目前沒有王' });
      } else {
        await client.replyMessage(replyToken, { type: 'text', text: '指令錯誤，請輸入 /幫助 查看指令' });
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

// cron 每分鐘檢查前10分鐘
cron.schedule('* * * * *', async () => {
  const now = dayjs();
  for (const [name, boss] of Object.entries(bossData)) {
    if (!boss.nextSpawn) continue;
    const diff = dayjs(boss.nextSpawn).diff(now, 'minute');
    if (diff === 10 && !boss.notified) {
      const text = `@ALL ⚔️ ${name} 即將在 10 分鐘後重生！（預定 ${dayjs(boss.nextSpawn).format('HH:mm')}）`;
      try {
        await client.pushMessage(USER_ID, { type: 'text', text });
        boss.notified = true;
        saveBossData();
      } catch (err) {
        console.error('cron 推播錯誤', err);
      }
    }
  }
});

loadBossData();
app.listen(PORT, () => {
  console.log(`🚀 LINE Boss Bot running on port ${PORT}`);
  console.log('✅ JSON 已載入並確保可用');
});
