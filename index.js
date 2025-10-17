import express from 'express';
import { Client, middleware } from '@line/bot-sdk';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import cron from 'node-cron';
import moment from 'moment-timezone';
import dotenv from 'dotenv';

dotenv.config();

const PORT = process.env.PORT || 3000;
const TZ = process.env.TIMEZONE || 'Asia/Taipei';
const USER_ID = process.env.USER_ID; // 推播對象 ID

if (!process.env.LINE_CHANNEL_SECRET || !process.env.LINE_CHANNEL_ACCESS_TOKEN || !USER_ID) {
    console.error('請先設定環境變數 CHANNEL_ACCESS_TOKEN、CHANNEL_SECRET 與 USER_ID');
    process.exit(1);
}

const client = new Client({
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.LINE_CHANNEL_SECRET,
});

const app = express();
app.use(express.json());
app.use(middleware({
    channelSecret: process.env.LINE_CHANNEL_SECRET
}));

let db;
(async () => {
    db = await open({
        filename: './bot.db',
        driver: sqlite3.Database
    });
    await db.run(`CREATE TABLE IF NOT EXISTS boss_status (
        boss TEXT PRIMARY KEY,
        interval_hour INTEGER,
        last_dead TEXT,
        next_spawn_iso TEXT,
        alert_sent_10min INTEGER DEFAULT 0
    )`);
    console.log('✅ SQLite 已連線並確保表格存在');
})();

// LINE webhook
app.post('/webhook', async (req, res) => {
    try {
        const events = req.body.events;
        for (let event of events) {
            if (event.type !== 'message' || event.message.type !== 'text') continue;
            const text = event.message.text.trim();
            const userId = event.source.userId || event.source.groupId || event.source.roomId;

            if (text === '/幫助') {
                await client.replyMessage(event.replyToken, { type: 'text', text: `
/幫助：顯示說明
/設定 王名 間隔(小時)：設定重生間隔
/死亡 王名 時間：記錄死亡時間
/BOSS：查詢所有王的狀態
/刪除 王名：刪除王
/我的ID：取得你的 LINE ID
                `.trim()});
            } else if (text.startsWith('/設定')) {
                const parts = text.split(' ');
                if (parts.length >= 3) {
                    const boss = parts[1];
                    const interval = parseFloat(parts[2]);
                    if (isNaN(interval)) {
                        await client.replyMessage(event.replyToken, { type: 'text', text: '請輸入正確間隔數字' });
                    } else {
                        await db.run(`INSERT INTO boss_status (boss, interval_hour) VALUES (?, ?) 
                            ON CONFLICT(boss) DO UPDATE SET interval_hour=?`, [boss, interval, interval]);
                        await client.replyMessage(event.replyToken, { type: 'text', text: `已設定 ${boss} 間隔 ${interval} 小時` });
                    }
                }
            } else if (text.startsWith('/死亡')) {
                const parts = text.split(' ');
                if (parts.length >= 3) {
                    const boss = parts[1];
                    const time = parts[2];
                    const last_dead = moment.tz(time, 'HH:mm', TZ).format();
                    const intervalRow = await db.get(`SELECT interval_hour FROM boss_status WHERE boss=?`, [boss]);
                    if (!intervalRow) {
                        await client.replyMessage(event.replyToken, { type: 'text', text: `${boss} 尚未設定間隔` });
                    } else {
                        const next_spawn = moment(last_dead).add(intervalRow.interval_hour, 'hours').toISOString();
                        await db.run(`UPDATE boss_status SET last_dead=?, next_spawn_iso=?, alert_sent_10min=0 WHERE boss=?`, [last_dead, next_spawn, boss]);
                        await client.replyMessage(event.replyToken, { type: 'text', text: `${boss} 死亡時間已記錄，預計重生 ${moment(next_spawn).tz(TZ).format('HH:mm')}` });
                    }
                }
            } else if (text.startsWith('/BOSS')) {
                const bosses = await db.all(`SELECT boss, next_spawn_iso FROM boss_status WHERE next_spawn_iso IS NOT NULL ORDER BY next_spawn_iso ASC`);
                if (bosses.length === 0) {
                    await client.replyMessage(event.replyToken, { type: 'text', text: '尚無任何王狀態' });
                } else {
                    const msg = bosses.map(b => `${b.boss}：${moment(b.next_spawn_iso).tz(TZ).format('HH:mm')}`).join('\n');
                    await client.replyMessage(event.replyToken, { type: 'text', text: msg });
                }
            } else if (text.startsWith('/刪除')) {
                const parts = text.split(' ');
                if (parts.length >= 2) {
                    const boss = parts[1];
                    await db.run(`DELETE FROM boss_status WHERE boss=?`, [boss]);
                    await client.replyMessage(event.replyToken, { type: 'text', text: `${boss} 已刪除` });
                }
            } else if (text.startsWith('/我的ID')) {
                await client.replyMessage(event.replyToken, { type: 'text', text: `你的 LINE ID 是: ${userId}` });
            }
        }
        res.sendStatus(200);
    } catch (err) {
        console.error(err);
        res.sendStatus(500);
    }
});

// 前 10 分鐘自動提醒
cron.schedule('* * * * *', async () => {
    try {
        const now = moment().tz(TZ);
        const bosses = await db.all(`SELECT boss, next_spawn_iso, alert_sent_10min FROM boss_status WHERE next_spawn_iso IS NOT NULL`);
        for (let b of bosses) {
            const nextSpawn = moment(b.next_spawn_iso);
            const diff = nextSpawn.diff(now, 'minutes');
            if (diff === 10 && b.alert_sent_10min === 0) {
                const msg = `@ALL ⚔️ ${b.boss} 即將在 10 分鐘後重生！（預定 ${nextSpawn.tz(TZ).format('HH:mm')}）`;
                await client.pushMessage(USER_ID, { type: 'text', text: msg });
                await db.run(`UPDATE boss_status SET alert_sent_10min=1 WHERE boss=?`, [b.boss]);
            }
        }
    } catch (err) {
        console.error('cron db read error', err);
    }
});

app.listen(PORT, () => {
    console.log(`🚀 LINE Boss Bot running on port ${PORT}`);
});
