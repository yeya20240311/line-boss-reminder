import express from 'express';
import { Client, middleware } from '@line/bot-sdk';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import cron from 'node-cron';
import moment from 'moment-timezone';

const PORT = process.env.PORT || 3000;
const TZ = process.env.TIMEZONE || 'Asia/Taipei';
const USER_ID = process.env.USER_ID;

if (!process.env.LINE_CHANNEL_SECRET || !process.env.LINE_CHANNEL_ACCESS_TOKEN || !USER_ID) {
  console.error('請先設定環境變數 LINE_CHANNEL_SECRET、LINE_CHANNEL_ACCESS_TOKEN 與 USER_ID');
  process.exit(1);
}

const config = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
};

const client = new Client(config);
const app = express();

// LINE webhook middleware
app.post('/webhook', middleware(config), async (req, res) => {
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
          text: `
/幫助：顯示說明
/設定 王名 間隔(小時)：設定重生間隔
/死亡 王名 時間：記錄死亡時間
/BOSS：查詢所有王的狀態與最快重生
/刪除 王名：刪除王
          `,
        });
      }

      // /設定 王名 間隔(小時)
      else if (text.startsWith('/設定 ')) {
        const [, bossName, intervalStr] = text.split(' ');
        const interval = parseFloat(intervalStr);
        if (!bossName || isNaN(interval)) {
          await client.replyMessage(replyToken, { type: 'text', text: '格式錯誤，正確：/設定 王名 間隔(小時)' });
        } else {
          const now = moment().tz(TZ).toISOString();
          await db.run(
            `INSERT INTO boss_status(boss, respawn_interval_hours, last_death_iso, last_alert_sent_notify_iso)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(boss) DO UPDATE SET respawn_interval_hours=?, last_death_iso=?, last_alert_sent_notify_iso=?`,
            bossName, interval, now, null, interval, now, null
          );
          await client.replyMessage(replyToken, { type: 'text', text: `已設定 ${bossName} 間隔 ${interval} 小時` });
        }
      }

      // /死亡 王名 時間
      else if (text.startsWith('/死亡 ')) {
        const [, bossName, timeStr] = text.split(' ');
        const deathTime = timeStr ? moment.tz(timeStr, 'HH:mm', TZ).toISOString() : moment().tz(TZ).toISOString();
        await db.run(
          `UPDATE boss_status SET last_death_iso=?, last_alert_sent_notify_iso=NULL WHERE boss=?`,
          deathTime, bossName
        );
        await client.replyMessage(replyToken, { type: 'text', text: `已記錄 ${bossName} 死亡時間 ${deathTime}` });
      }

      // /BOSS
      else if (text === '/BOSS') {
        const bosses = await db.all(`SELECT * FROM boss_status`);
        const now = moment().tz(TZ);
        const lines = bosses.map(b => {
          const lastDeath = moment(b.last_death_iso).tz(TZ);
          const nextSpawn = lastDeath.clone().add(b.respawn_interval_hours, 'hours');
          const diffMin = Math.max(0, nextSpawn.diff(now, 'minutes'));
          return `${b.boss}：${diffMin} 分鐘後重生（預定 ${nextSpawn.format('HH:mm')}）`;
        }).sort((a,b)=>a.localeCompare(b));
        await client.replyMessage(replyToken, { type: 'text', text: lines.join('\n') || '目前沒有王資料' });
      }

      // /刪除 王名
      else if (text.startsWith('/刪除 ')) {
        const [, bossName] = text.split(' ');
        await db.run(`DELETE FROM boss_status WHERE boss=?`, bossName);
        await client.replyMessage(replyToken, { type: 'text', text: `已刪除 ${bossName}` });
      }
    }
    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

// SQLite 初始化
let db;
(async () => {
  db = await open({ filename: './bot.db', driver: sqlite3.Database });
  await db.run(`CREATE TABLE IF NOT EXISTS boss_status(
    boss TEXT PRIMARY KEY,
    respawn_interval_hours REAL NOT NULL,
    last_death_iso TEXT NOT NULL,
    last_alert_sent_notify_iso TEXT
  )`);
  console.log('✅ SQLite 已連線並確保表格存在');
})();

// cron 每分鐘檢查前 10 分鐘推播
cron.schedule('* * * * *', async () => {
  if (!db) return;
  const bosses = await db.all(`SELECT * FROM boss_status`);
  const now = moment().tz(TZ);
  for (const b of bosses) {
    const lastDeath = moment(b.last_death_iso).tz(TZ);
    const nextSpawn = lastDeath.clone().add(b.respawn_interval_hours, 'hours');
    const diffMin = nextSpawn.diff(now, 'minutes');

    if (diffMin <= 10 && diffMin > 9 && !b.last_alert_sent_notify_iso) {
      // 前10分鐘推播
      try {
        await client.pushMessage(USER_ID, {
          type: 'text',
          text: `@ALL ⚔️ ${b.boss} 即將在 10 分鐘後重生！（預定 ${nextSpawn.format('HH:mm')}）`,
        });
        await db.run(`UPDATE boss_status SET last_alert_sent_notify_iso=? WHERE boss=?`, now.toISOString(), b.boss);
        console.log(`推播前10分鐘：${b.boss}`);
      } catch (err) {
        console.error('cron db read error', err);
      }
    }
  }
});

app.listen(PORT, () => {
  console.log(`🚀 LINE Boss Bot running on port ${PORT}`);
});
