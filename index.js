import express from 'express';
import { Client, middleware } from '@line/bot-sdk';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import cron from 'node-cron';
import moment from 'moment-timezone';
import dotenv from 'dotenv';

dotenv.config();

const PORT = process.env.PORT || 10000;
const TZ = process.env.TIMEZONE || 'Asia/Taipei';
const USER_ID = process.env.USER_ID;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;

if (!LINE_CHANNEL_ACCESS_TOKEN || !LINE_CHANNEL_SECRET || !USER_ID) {
  console.error('請先設定環境變數 LINE_CHANNEL_SECRET、LINE_CHANNEL_ACCESS_TOKEN 與 USER_ID');
  process.exit(1);
}

const config = {
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: LINE_CHANNEL_SECRET,
};

const client = new Client(config);
const app = express();

// LINE middleware 要在 JSON parser 前
app.post('/webhook', middleware(config), async (req, res) => {
  if (!req.body.events) return res.sendStatus(200);

  for (const event of req.body.events) {
    if (event.type !== 'message' || event.message.type !== 'text') continue;

    const text = event.message.text.trim();
    const replyToken = event.replyToken;

    // 幫助
    if (text === '/幫助') {
      await client.replyMessage(replyToken, {
        type: 'text',
        text: `/幫助\n/設定 王名 間隔(小時)\n/死亡 王名 時間\n/BOSS\n/刪除 王名\n/我的ID`,
      });
    }

    // 我的ID
    else if (text === '/我的ID') {
      const userId = event.source.userId || '無法取得ID';
      await client.replyMessage(replyToken, { type: 'text', text: `你的ID: ${userId}` });
    }

    // 其他指令保留原本邏輯
    else if (text.startsWith('/設定 ')) {
      const [, boss, interval] = text.match(/^\/設定\s+(\S+)\s+(\d+)/) || [];
      if (boss && interval) {
        const nextSpawn = moment().add(Number(interval), 'hours').tz(TZ).toISOString();
        await db.run(
          `INSERT INTO boss_status (boss, interval_hours, last_dead_iso, next_spawn_iso, alert_10min_sent)
           VALUES (?, ?, NULL, ?, 0)
           ON CONFLICT(boss) DO UPDATE SET interval_hours = ?, next_spawn_iso = ?, alert_10min_sent = 0`,
          boss, Number(interval), nextSpawn, Number(interval), nextSpawn
        );
        await client.replyMessage(replyToken, { type: 'text', text: `設定 ${boss} 重生間隔 ${interval} 小時` });
      } else {
        await client.replyMessage(replyToken, { type: 'text', text: '指令格式錯誤' });
      }
    } else if (text.startsWith('/死亡 ')) {
      const [, boss, time] = text.match(/^\/死亡\s+(\S+)\s*(\S*)/) || [];
      if (boss) {
        const deadTime = time ? moment.tz(time, 'HH:mm', TZ) : moment().tz(TZ);
        const bossData = await db.get(`SELECT interval_hours FROM boss_status WHERE boss = ?`, boss);
        if (!bossData) {
          await client.replyMessage(replyToken, { type: 'text', text: `${boss} 尚未設定` });
          continue;
        }
        const nextSpawn = deadTime.clone().add(bossData.interval_hours, 'hours').toISOString();
        await db.run(
          `UPDATE boss_status SET last_dead_iso = ?, next_spawn_iso = ?, alert_10min_sent = 0 WHERE boss = ?`,
          deadTime.toISOString(), nextSpawn, boss
        );
        await client.replyMessage(replyToken, { type: 'text', text: `${boss} 記錄死亡，下一次重生預定 ${moment(nextSpawn).tz(TZ).format('HH:mm')}` });
      } else {
        await client.replyMessage(replyToken, { type: 'text', text: '指令格式錯誤' });
      }
    } else if (text === '/BOSS') {
      const bosses = await db.all(`SELECT * FROM boss_status ORDER BY next_spawn_iso ASC`);
      let msg = '';
      for (const b of bosses) {
        const next = b.next_spawn_iso ? moment.tz(b.next_spawn_iso, TZ).format('HH:mm') : '未設定';
        msg += `${b.boss} -> 下次重生: ${next}\n`;
      }
      await client.replyMessage(replyToken, { type: 'text', text: msg || '尚無資料' });
    } else if (text.startsWith('/刪除 ')) {
      const [, boss] = text.match(/^\/刪除\s+(\S+)/) || [];
      if (boss) {
        await db.run(`DELETE FROM boss_status WHERE boss = ?`, boss);
        await client.replyMessage(replyToken, { type: 'text', text: `${boss} 已刪除` });
      } else {
        await client.replyMessage(replyToken, { type: 'text', text: '指令格式錯誤' });
      }
    }
  }
  res.sendStatus(200);
});

// JSON parser for other routes
app.use(express.json());

// SQLite 初始化
let db;
async function initDB() {
  db = await open({ filename: './bot.db', driver: sqlite3.Database });
  await db.run(`CREATE TABLE IF NOT EXISTS boss_status (
    boss TEXT PRIMARY KEY,
    interval_hours INTEGER,
    last_dead_iso TEXT,
    next_spawn_iso TEXT,
    alert_10min_sent INTEGER DEFAULT 0
  )`);
  console.log('✅ SQLite 已連線並確保表格存在');
}
await initDB();

// 推播提醒
async function checkBosses() {
  const now = moment().tz(TZ);
  const bosses = await db.all(`SELECT * FROM boss_status WHERE next_spawn_iso IS NOT NULL`);
  for (const b of bosses) {
    const nextSpawn = moment.tz(b.next_spawn_iso, TZ);
    const diffMinutes = nextSpawn.diff(now, 'minutes');
    if (diffMinutes <= 10 && diffMinutes > 0 && b.alert_10min_sent === 0) {
      const message = {
        type: 'text',
        text: `@ALL ⚔️ ${b.boss} 即將在 ${diffMinutes} 分鐘後重生！（預定 ${nextSpawn.format('HH:mm')}）`,
      };
      await client.pushMessage(USER_ID, message);
      await db.run(`UPDATE boss_status SET alert_10min_sent = 1 WHERE boss = ?`, b.boss);
    }
  }
}
cron.schedule('* * * * *', checkBosses);

app.listen(PORT, () => console.log(`🚀 LINE Boss Bot running on port ${PORT}`));
