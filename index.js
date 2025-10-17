import express from 'express';
import { Client, middleware } from '@line/bot-sdk';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import moment from 'moment-timezone';
import cron from 'node-cron';

const PORT = process.env.PORT || 3000;
const TZ = process.env.TIMEZONE || 'Asia/Taipei';

// LINE Bot 設定
const client = new Client({
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET
});

// 建立 Express App
const app = express();
app.use(express.json());

// SQLite 建立資料庫
const dbPromise = open({
  filename: './bot.db',
  driver: sqlite3.Database
});

// 初始化資料表
async function initDB() {
  const db = await dbPromise;
  await db.exec(`
    CREATE TABLE IF NOT EXISTS boss_status (
      boss TEXT PRIMARY KEY,
      interval_hours INTEGER,
      last_dead_iso TEXT,
      next_spawn_iso TEXT,
      alerted_10min INTEGER DEFAULT 0
    )
  `);
  console.log('✅ SQLite 已連線並確保表格存在');
}

// LINE Webhook
app.post('/webhook', middleware({ channelSecret: process.env.CHANNEL_SECRET }), async (req, res) => {
  try {
    const events = req.body.events;
    for (const event of events) {
      if (event.type === 'message' && event.message.type === 'text') {
        await handleMessage(event);
      }
    }
    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

// 處理使用者訊息
async function handleMessage(event) {
  const text = event.message.text.trim();
  const userId = event.source.userId;
  const db = await dbPromise;

  if (text.startsWith('/幫助')) {
    await client.replyMessage(event.replyToken, {
      type: 'text',
      text: `功能列表：
/幫助：顯示說明
/設定 王名 間隔(小時)：設定重生間隔
/死亡 王名 時間：記錄死亡時間 (時間格式 HH:mm)
/BOSS：查詢所有王的狀態與最快重生
/修改名稱 舊王名 新王名：修改王名稱
/修改間隔 王名 新間隔(小時)：修改重生間隔`
    });
  }

  else if (text.startsWith('/設定')) {
    const [, boss, hours] = text.split(' ');
    if (!boss || !hours || isNaN(hours)) {
      return client.replyMessage(event.replyToken, { type: 'text', text: '格式錯誤，範例：/設定 奇岩1 6' });
    }
    const nextSpawn = moment().add(Number(hours), 'hours').toISOString();
    await db.run(`
      INSERT INTO boss_status (boss, interval_hours, last_dead_iso, next_spawn_iso, alerted_10min)
      VALUES (?, ?, ?, ?, 0)
      ON CONFLICT(boss) DO UPDATE SET interval_hours=excluded.interval_hours
    `, [boss, hours, null, nextSpawn]);
    await client.replyMessage(event.replyToken, { type: 'text', text: `${boss} 的重生間隔已設定為 ${hours} 小時` });
  }

  else if (text.startsWith('/死亡')) {
    const [, boss, timeStr] = text.split(' ');
    if (!boss || !timeStr) return client.replyMessage(event.replyToken, { type: 'text', text: '格式錯誤，範例：/死亡 奇岩1 10:30' });
    const deadTime = moment.tz(timeStr, 'HH:mm', TZ).toISOString();
    const row = await db.get('SELECT interval_hours FROM boss_status WHERE boss=?', boss);
    if (!row) return client.replyMessage(event.replyToken, { type: 'text', text: '王不存在，請先 /設定' });
    const nextSpawn = moment(deadTime).add(row.interval_hours, 'hours').toISOString();
    await db.run('UPDATE boss_status SET last_dead_iso=?, next_spawn_iso=?, alerted_10min=0 WHERE boss=?', [deadTime, nextSpawn, boss]);
    await client.replyMessage(event.replyToken, { type: 'text', text: `${boss} 死亡時間已記錄，預計重生時間 ${moment(nextSpawn).tz(TZ).format('HH:mm')}` });
  }

  else if (text.startsWith('/BOSS')) {
    const rows = await db.all('SELECT * FROM boss_status ORDER BY next_spawn_iso ASC');
    const lines = rows.map(r => `${r.boss}：${r.next_spawn_iso ? moment(r.next_spawn_iso).tz(TZ).format('HH:mm') : '未知'}`);
    await client.replyMessage(event.replyToken, { type: 'text', text: lines.join('\n') || '目前沒有王資料' });
  }

  // 新增：修改王名稱
  else if (text.startsWith('/修改名稱')) {
    const [, oldName, newName] = text.split(' ');
    if (!oldName || !newName) return client.replyMessage(event.replyToken, { type: 'text', text: '格式錯誤，範例：/修改名稱 奇岩1 奇岩A' });
    const row = await db.get('SELECT * FROM boss_status WHERE boss=?', oldName);
    if (!row) return client.replyMessage(event.replyToken, { type: 'text', text: '舊王名不存在' });
    await db.run('UPDATE boss_status SET boss=? WHERE boss=?', [newName, oldName]);
    await client.replyMessage(event.replyToken, { type: 'text', text: `王名稱已修改：${oldName} → ${newName}` });
  }

  // 新增：修改間隔
  else if (text.startsWith('/修改間隔')) {
    const [, boss, hours] = text.split(' ');
    if (!boss || !hours || isNaN(hours)) return client.replyMessage(event.replyToken, { type: 'text', text: '格式錯誤，範例：/修改間隔 奇岩1 8' });
    const row = await db.get('SELECT * FROM boss_status WHERE boss=?', boss);
    if (!row) return client.replyMessage(event.replyToken, { type: 'text', text: '王不存在' });
    const nextSpawn = row.last_dead_iso ? moment(row.last_dead_iso).add(Number(hours), 'hours').toISOString() : moment().add(Number(hours), 'hours').toISOString();
    await db.run('UPDATE boss_status SET interval_hours=?, next_spawn_iso=?, alerted_10min=0 WHERE boss=?', [hours, nextSpawn, boss]);
    await client.replyMessage(event.replyToken, { type: 'text', text: `${boss} 的重生間隔已修改為 ${hours} 小時` });
  }
}

// 前10分鐘提醒
cron.schedule('*/1 * * * *', async () => {
  const db = await dbPromise;
  const now = moment().tz(TZ);
  const bosses = await db.all('SELECT * FROM boss_status WHERE next_spawn_iso IS NOT NULL');

  for (const boss of bosses) {
    const nextSpawn = moment(boss.next_spawn_iso);
    const diffMinutes = nextSpawn.diff(now, 'minutes');

    if (diffMinutes <= 10 && diffMinutes > 0 && boss.alerted_10min === 0) {
      // 推播訊息給所有人
      await client.pushMessage(process.env.USER_ID, [{
        type: 'text',
        text: `@ALL ⚔️ ${boss.boss} 即將在 10 分鐘後重生！（預定 ${nextSpawn.tz(TZ).format('HH:mm')}）`
      }]);

      await db.run('UPDATE boss_status SET alerted_10min=1 WHERE boss=?', boss.boss);
    }
  }
});

initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 LINE Boss Bot running on port ${PORT}`);
  });
});
