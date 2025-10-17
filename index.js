// index.js
require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
const moment = require('moment-timezone');

const PORT = process.env.PORT || 3000;
const TZ = process.env.TIMEZONE || 'Asia/Taipei';

const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;

if (!CHANNEL_ACCESS_TOKEN || !CHANNEL_SECRET) {
  console.error('請先設定環境變數 LINE_CHANNEL_ACCESS_TOKEN 與 LINE_CHANNEL_SECRET');
  process.exit(1);
}

const config = {
  channelAccessToken: CHANNEL_ACCESS_TOKEN,
  channelSecret: CHANNEL_SECRET
};

const client = new line.Client(config);
const app = express();

// 使用 express 內建 JSON parser，保留原始 body 給 LINE middleware
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

const db = new sqlite3.Database('./bot.db');

// ------------------------ 建立資料表 ------------------------
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    userId TEXT PRIMARY KEY,
    displayName TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS boss_defs (
    boss TEXT PRIMARY KEY,
    interval_hours INTEGER
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS boss_status (
    boss TEXT PRIMARY KEY,
    last_death_iso TEXT,
    next_spawn_iso TEXT,
    last_alert_sent_notify_iso TEXT,
    updated_at TEXT
  )`);
});

// ------------------------ helpers ------------------------
function parseTimeInput(txt) {
  txt = txt.trim();
  let m;
  let now = moment().tz(TZ);
  if (/^\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}$/.test(txt)) {
    m = moment.tz(txt, 'YYYY-MM-DD HH:mm', TZ);
  } else if (/^\d{1,2}:\d{2}$/.test(txt)) {
    m = moment.tz(txt, 'HH:mm', TZ');
    m.year(now.year()); m.month(now.month()); m.date(now.date());
  } else {
    return null;
  }
  if (!m.isValid()) return null;
  return m;
}

function toIso(m) {
  return m.clone().tz(TZ).format();
}

function humanDiff(ms) {
  const sec = Math.floor(ms / 1000);
  if (sec <= 0) return '0 秒';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  let parts = [];
  if (h) parts.push(`${h} 小時`);
  if (m) parts.push(`${m} 分鐘`);
  if (!h && s) parts.push(`${s} 秒`);
  return parts.join(' ');
}

// ------------------------ LINE webhook ------------------------
app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    const events = req.body.events || [];
    await Promise.all(events.map(handleEvent));
    res.json({status: 'ok'});
  } catch (e) {
    console.error(e);
    res.status(500).end();
  }
});

app.get('/', (req, res) => res.send('LINE Boss Reminder Bot is running'));

// ------------------------ handle events ------------------------
async function handleEvent(event) {
  try {
    if (event.type === 'follow') {
      const userId = event.source.userId;
      const profile = await client.getProfile(userId);
      db.run(`INSERT OR IGNORE INTO users (userId, displayName) VALUES (?,?)`, [userId, profile.displayName]);
      return client.replyMessage(event.replyToken, { type: 'text', text: `歡迎 ${profile.displayName}！輸入「/BOSS」查看所有王狀態或輸入「/幫助」`});
    }

    if (event.type === 'message' && event.message.type === 'text') {
      const text = event.message.text.trim();
      const userId = event.source.userId;

      // 幫助
      if (/^\/?幫助$/i.test(text)) {
        const help = [
          '/設定 王名 間隔(小時) — 設定該王重生間隔 (例 /設定 地龍 8)',
          '/死亡 王名 時間 — 記錄死亡時間 (例 /死亡 地龍 14:30 或 /死亡 地龍 2025-10-16 14:30)',
          '/BOSS — 顯示所有王下次重生時間與最快重生'
        ].join('\n');
        return client.replyMessage(event.replyToken, { type: 'text', text: help });
      }

      // /設定 王名 間隔
      if (/^\/?設定\s+(.+?)\s+(\d+)$/.test(text)) {
        const m = text.match(/^\/?設定\s+(.+?)\s+(\d+)$/);
        const boss = m[1].trim();
        const interval = parseInt(m[2], 10);
        if (!boss || !interval) {
          return client.replyMessage(event.replyToken, { type: 'text', text: '格式錯誤，範例：/設定 地龍 8' });
        }
        db.run(`INSERT OR REPLACE INTO boss_defs (boss, interval_hours) VALUES (?,?)`, [boss, interval], function(err) {
          if (err) {
            console.error(err);
            return client.replyMessage(event.replyToken, { type: 'text', text: '儲存失敗' });
          }
          return client.replyMessage(event.replyToken, { type: 'text', text: `已設定 ${boss} 的重生間隔為 ${interval} 小時。` });
        });
        return;
      }

      // /死亡 王名 時間
      if (/^\/?死亡\s+(.+?)\s+(.+)$/.test(text)) {
        const m = text.match(/^\/?死亡\s+(.+?)\s+(.+)$/);
        const boss = m[1].trim();
        const timeStr = m[2].trim();
        const parsed = parseTimeInput(timeStr);
        if (!parsed) {
          return client.replyMessage(event.replyToken, { type: 'text', text: '時間格式錯誤。請使用 HH:MM 或 YYYY-MM-DD HH:MM' });
        }
        db.get(`SELECT interval_hours FROM boss_defs WHERE boss = ?`, [boss], (err,row) => {
          if (err) { console.error(err); return client.replyMessage(event.replyToken, { type: 'text', text: '查詢錯誤' }); }
          if (!row) {
            return client.replyMessage(event.replyToken, { type: 'text', text: `找不到 ${boss} 的重生間隔，請先用 /設定 設定間隔` });
          }
          const interval = row.interval_hours;
          const nextSpawn = parsed.clone().add(interval, 'hours');
          db.run(`INSERT OR REPLACE INTO boss_status (boss, last_death_iso, next_spawn_iso, last_alert_sent_notify_iso, updated_at)
                  VALUES (?,?,?,?,datetime('now'))`,
            [boss, toIso(parsed), toIso(nextSpawn), null],
            function(err2) {
              if (err2) console.error(err2);
              const txt = `✅ 已記錄 ${boss} 死亡於 ${parsed.tz(TZ).format('YYYY-MM-DD HH:mm')}\n下次重生：${nextSpawn.tz(TZ).format('YYYY-MM-DD HH:mm')}\n我們會在重生前 10 分鐘通知`;
              client.replyMessage(event.replyToken, { type: 'text', text: txt });
            });
        });
        return;
      }

      // /BOSS 查詢所有狀態
      if (/^\/?BOSS$/i.test(text) || /^\/?boss$/i.test(text)) {
        db.all(`SELECT b.boss, b.interval_hours, s.last_death_iso, s.next_spawn_iso
                FROM boss_defs b LEFT JOIN boss_status s ON b.boss = s.boss`, (err, rows) => {
          if (err) { console.error(err); return client.replyMessage(event.replyToken, { type: 'text', text: '查詢錯誤' }); }
          const now = moment().tz(TZ);
          let lines = [];
          let fastest = null;
          rows.forEach(r => {
            if (r.next_spawn_iso) {
              const next = moment.tz(r.next_spawn_iso, TZ);
              const diffSec = next.diff(now);
              const diffText = diffSec > 0 ? humanDiff(diffSec) : '已到或未知';
              lines.push(`${r.boss}：${next.format('MM-DD HH:mm')}（剩 ${diffText}）`);
              if (diffSec > 0 && (!fastest || diffSec < fastest.diff)) {
                fastest = { boss: r.boss, next, diff: diffSec };
              }
            } else {
              lines.push(`${r.boss}：尚未紀錄死亡時間`);
            }
          });
          let msg = lines.join('\n');
          if (fastest) msg += `\n\n⚡ 最快重生：${fastest.boss}（${fastest.next.format('MM-DD HH:mm')}，剩 ${humanDiff(fastest.diff)}）`;
          client.replyMessage(event.replyToken, { type: 'text', text: msg || '目前沒有任何 BOSS 資訊' });
        });
        return;
      }

      // 未識別
      return client.replyMessage(event.replyToken, { type: 'text', text: '未識別指令。輸入 /幫助 查看可用指令。' });
    }
  } catch (e) {
    console.error('handleEvent error', e);
  }
}

// ------------------------ cron: 自動前10分鐘通知 ------------------------
cron.schedule('* * * * *', () => {
  const now = moment().tz(TZ);
  db.all(`SELECT b.boss, s.next_spawn_iso, s.last_alert_sent_notify_iso
          FROM boss_defs b LEFT JOIN boss_status s ON b.boss = s.boss
          WHERE s.next_spawn_iso IS NOT NULL`, (err, rows) => {
    if (err) return console.error('cron db read error', err);
    rows.forEach(row => {
      const next = moment.tz(row.next_spawn_iso, TZ);
      const notifyTime = next.clone().subtract(10, 'minutes');
      const already = row.last_alert_sent_notify_iso ? moment.tz(row.last_alert_sent_notify_iso, TZ) : null;
      if (now.isSameOrAfter(notifyTime) && now.isBefore(notifyTime.clone().add(60, 'seconds')) &&
          (!already || already.isBefore(notifyTime))) {
        client.broadcast({
          type: 'text',
          text: `⚠️ ${row.boss} 即將重生！大約在 10 分鐘內`
        }).catch(console.error);
        db.run(`UPDATE boss_status SET last_alert_sent_notify_iso=? WHERE boss=?`, [toIso(now), row.boss]);
      }
    });
  });
});

app.listen(PORT, () => {
  console.log(`LINE Boss Reminder Bot running on port ${PORT}`);
});
