import express from 'express';
import { Client, middleware } from '@line/bot-sdk';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import cron from 'node-cron';
import moment from 'moment-timezone';
import dotenv from 'dotenv';
dotenv.config();

// 環境變數
const PORT = process.env.PORT || 3000;
const TIMEZONE = process.env.TIMEZONE || 'Asia/Taipei';
const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const USER_ID = process.env.USER_ID; // 你的 LINE userId 或 groupId

if (!CHANNEL_SECRET || !CHANNEL_ACCESS_TOKEN) {
  console.error('請先設定環境變數 CHANNEL_ACCESS_TOKEN 與 CHANNEL_SECRET');
  process.exit(1);
}

const client = new Client({
  channelAccessToken: CHANNEL_ACCESS_TOKEN,
  channelSecret: CHANNEL_SECRET,
});

// Express
const app = express();
app.use(express.json());
app.use(middleware({ channelSecret: CHANNEL_SECRET }));

// SQLite 初始化
let db;
(async () => {
  db = await open({
    filename: './bot.db',
    driver: sqlite3.Database
  });
  await db.run(`
    CREATE TABLE IF NOT EXISTS boss_status (
      boss TEXT PRIMARY KEY,
      respawn_hours REAL,
      last_dead_iso TEXT,
      next_spawn_iso TEXT,
      last_alert_sent_notify_iso TEXT
    )
  `);
  console.log('✅ SQLite 已連線並確保表格存在');
})();

// 處理 LINE webhook
app.post('/webhook', async (req, res) => {
  try {
    const events = req.body.events;
    for (const event of events) {
      if (event.type !== 'message' || event.message.type !== 'text') continue;
      const text = event.message.text.trim();
      const replyToken = event.replyToken;

      if (text === '/幫助') {
        await client.replyMessage(replyToken, {
          type: 'text',
          text: `
/幫助：顯示說明
/設定 王名 間隔(小時)：設定重生間隔
/死亡 王名 時間：記錄死亡時間
/BOSS：查詢所有王的狀態與最快重生
          `.trim()
        });
      } else if (text.startsWith('/設定')) {
        const [, boss, hours] = text.split(' ');
        if (!boss || !hours || isNaN(hours)) {
          await client.replyMessage(replyToken, { type: 'text', text: '格式錯誤 /設定 王名 間隔(小時)' });
          continue;
        }
        const nextSpawn = moment().add(Number(hours), 'hours').toISOString();
        await db.run(`
          INSERT INTO boss_status(boss, respawn_hours, next_spawn_iso)
          VALUES (?, ?, ?)
          ON CONFLICT(boss) DO UPDATE SET respawn_hours=?, next_spawn_iso=?
        `, boss, Number(hours), nextSpawn, Number(hours), nextSpawn);
        await client.replyMessage(replyToken, { type: 'text', text: `已設定 ${boss} 間隔 ${hours} 小時` });
      } else if (text.startsWith('/死亡')) {
        const [, boss, time] = text.split(' ');
        if (!boss || !time) {
          await client.replyMessage(replyToken, { type: 'text', text: '格式錯誤 /死亡 王名 時間(如 10:30)' });
          continue;
        }
        const lastDead = moment.tz(time, 'HH:mm', TIMEZONE);
        const respawnData = await db.get('SELECT respawn_hours FROM boss_status WHERE boss=?', boss);
        if (!respawnData) {
          await client.replyMessage(replyToken, { type: 'text', text: `${boss} 尚未設定間隔` });
          continue;
        }
        const nextSpawn = lastDead.add(respawnData.respawn_hours, 'hours').toISOString();
        await db.run('UPDATE boss_status SET last_dead_iso=?, next_spawn_iso=? WHERE boss=?', lastDead.toISOString(), nextSpawn, boss);
        await client.replyMessage(replyToken, { type: 'text', text: `${boss} 死亡時間已記錄，預計重生 ${moment(nextSpawn).tz(TIMEZONE).format('HH:mm')}` });
      } else if (text === '/BOSS') {
        const bosses = await db.all('SELECT * FROM boss_status WHERE next_spawn_iso IS NOT NULL ORDER BY next_spawn_iso ASC');
        if (!bosses.length) {
          await client.replyMessage(replyToken, { type: 'text', text: '目前沒有設定任何王' });
          continue;
        }
        let msg = '';
        bosses.forEach(b => {
          const next = moment(b.next_spawn_iso).tz(TIMEZONE).format('HH:mm');
          msg += `${b.boss} 預計重生 ${next}\n`;
        });
        await client.replyMessage(replyToken, { type: 'text', text: msg.trim() });
      }
    }
    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

// Cron 每分鐘檢查
cron.schedule('* * * * *', async () => {
  if (!db) return;
  const now = moment.tz(TIMEZONE);
  const bosses = await db.all('SELECT * FROM boss_status WHERE next_spawn_iso IS NOT NULL');

  for (const b of bosses) {
    const nextSpawn = moment.tz(b.next_spawn_iso, TIMEZONE);
    const diffMin = nextSpawn.diff(now, 'minutes');

    // 只在剩下 10 分鐘內提醒一次
    if (diffMin <= 10 && diffMin > 0 && b.last_alert_sent_notify_iso !== nextSpawn.toISOString()) {
      try {
        await client.pushMessage(USER_ID, {
          type: 'text',
          text: `@ALL ⚔️ ${b.boss} 即將在 ${diffMin} 分鐘後重生！（預定 ${nextSpawn.format('HH:mm')}）`
        });
        await db.run(
          'UPDATE boss_status SET last_alert_sent_notify_iso=? WHERE boss=?',
          nextSpawn.toISOString(),
          b.boss
        );
      } catch (err) {
        console.error('cron db read error', err);
      }
    }
  }
});

// 啟動
app.listen(PORT, () => {
  console.log(`🚀 LINE Boss Bot running on port ${PORT}`);
});
