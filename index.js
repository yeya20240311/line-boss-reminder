import express from 'express';
import { Client, middleware } from '@line/bot-sdk';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import moment from 'moment-timezone';
import bodyParser from 'body-parser';
import cron from 'node-cron';

const app = express();
const PORT = process.env.PORT || 3000;
const TZ = process.env.TIMEZONE || 'Asia/Taipei';

const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const USER_ID = process.env.USER_ID;

if (!LINE_CHANNEL_ACCESS_TOKEN || !LINE_CHANNEL_SECRET || !USER_ID) {
  console.error('請先設定環境變數 LINE_CHANNEL_ACCESS_TOKEN、LINE_CHANNEL_SECRET 與 USER_ID');
  process.exit(1);
}

const client = new Client({
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: LINE_CHANNEL_SECRET
});

// SQLite 初始化
const db = await open({
  filename: './bot.db',
  driver: sqlite3.Database
});
await db.exec(`CREATE TABLE IF NOT EXISTS boss_status (
  boss TEXT PRIMARY KEY,
  interval_hours REAL,
  next_spawn_iso TEXT,
  alert_10min_sent INTEGER DEFAULT 0
)`);

app.use(bodyParser.json());
app.post('/webhook', middleware({ channelSecret: LINE_CHANNEL_SECRET }), async (req, res) => {
  try {
    const events = req.body.events;
    for (const event of events) {
      if (event.type !== 'message' || event.message.type !== 'text') continue;
      const text = event.message.text.trim();
      const replyToken = event.replyToken;

      // /幫助
      if (text === '/幫助') {
        await client.replyMessage(replyToken, {
          type: 'text',
          text: `指令列表：
/幫助 → 顯示說明
/設定 王名 間隔(小時) → 設定重生間隔
/重生 王名 剩餘時間 → 設定剩餘重生時間（格式 小時.分鐘）
/BOSS → 查詢所有王狀態
/刪除 王名 → 刪除王`
        });
        continue;
      }

      // /設定 王名 間隔
      if (text.startsWith('/設定 ')) {
        const [, boss, interval] = text.match(/^\/設定\s+(\S+)\s+([\d.]+)/) || [];
        if (boss && interval) {
          await db.run(
            `INSERT INTO boss_status(boss, interval_hours) VALUES(?, ?)
            ON CONFLICT(boss) DO UPDATE SET interval_hours = ?`,
            boss, parseFloat(interval), parseFloat(interval)
          );
          await client.replyMessage(replyToken, { type: 'text', text: `${boss} 間隔已設定為 ${interval} 小時` });
        } else {
          await client.replyMessage(replyToken, { type: 'text', text: '指令格式錯誤，範例: /設定 激3南 18' });
        }
        continue;
      }

      // /重生 王名 剩餘時間
      if (text.startsWith('/重生 ')) {
        const [, boss, remaining] = text.match(/^\/重生\s+(\S+)\s+(\d+(?:\.\d+)?)/) || [];
        if (boss && remaining) {
          const parts = remaining.split('.');
          const hours = Number(parts[0]);
          const minutes = parts[1] ? Number(parts[1].padEnd(2,'0')) : 0;
          const nextSpawn = moment().tz(TZ).add(hours, 'hours').add(minutes, 'minutes').toISOString();

          const bossData = await db.get(`SELECT * FROM boss_status WHERE boss = ?`, boss);
          if (!bossData) {
            await client.replyMessage(replyToken, { type: 'text', text: `${boss} 尚未設定` });
            continue;
          }

          await db.run(
            `UPDATE boss_status SET next_spawn_iso = ?, alert_10min_sent = 0 WHERE boss = ?`,
            nextSpawn, boss
          );

          await client.replyMessage(replyToken, {
            type: 'text',
            text: `${boss} 已更新剩餘時間，預定 ${moment(nextSpawn).tz(TZ).format('HH:mm')}`
          });
        } else {
          await client.replyMessage(replyToken, { type: 'text', text: '指令格式錯誤，範例: /重生 激3南 3.06' });
        }
        continue;
      }

      // /BOSS
      if (text === '/BOSS') {
        const bosses = await db.all(`SELECT * FROM boss_status ORDER BY next_spawn_iso ASC`);
        const now = moment().tz(TZ);
        let msg = bosses.map(b => {
          if (!b.next_spawn_iso) return `${b.boss} → 尚未設定`;
          const next = moment(b.next_spawn_iso).tz(TZ);
          const diff = moment.duration(next.diff(now));
          const h = Math.floor(diff.asHours());
          const m = diff.minutes();
          return `${b.boss} → 剩餘 ${h}小時${m}分`;
        }).join('\n');
        if (!msg) msg = '尚無資料';
        await client.replyMessage(replyToken, { type: 'text', text: msg });
        continue;
      }

      // /刪除 王名
      if (text.startsWith('/刪除 ')) {
        const [, boss] = text.match(/^\/刪除\s+(\S+)/) || [];
        if (boss) {
          await db.run(`DELETE FROM boss_status WHERE boss = ?`, boss);
          await client.replyMessage(replyToken, { type: 'text', text: `${boss} 已刪除` });
        } else {
          await client.replyMessage(replyToken, { type: 'text', text: '指令格式錯誤，範例: /刪除 激3南' });
        }
        continue;
      }
    }
    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

// Cron 每分鐘檢查是否需要推播前10分鐘
cron.schedule('* * * * *', async () => {
  const bosses = await db.all(`SELECT * FROM boss_status WHERE next_spawn_iso IS NOT NULL`);
  const now = moment().tz(TZ);
  for (const b of bosses) {
    const next = moment(b.next_spawn_iso).tz(TZ);
    const diffMinutes = next.diff(now, 'minutes');
    if (diffMinutes <= 10 && diffMinutes > 9 && b.alert_10min_sent === 0) {
      await client.pushMessage(USER_ID, {
        type: 'text',
        text: `@ALL ⚔️ ${b.boss} 即將在 10 分鐘後重生！（預定 ${next.format('HH:mm')}）`
      });
      await db.run(`UPDATE boss_status SET alert_10min_sent = 1 WHERE boss = ?`, b.boss);
    }
  }
});

app.listen(PORT, () => {
  console.log(`🚀 LINE Boss Bot running on port ${PORT}`);
  console.log('✅ SQLite 已連線並確保表格存在');
});
