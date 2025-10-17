import express from 'express';
import { Client, middleware } from '@line/bot-sdk';
import fs from 'fs';
import moment from 'moment-timezone';
import cron from 'node-cron';
import bodyParser from 'body-parser';

const app = express();
const PORT = process.env.PORT || 3000;
const TZ = process.env.TIMEZONE || 'Asia/Taipei';
const USER_ID = process.env.USER_ID; // 推播的使用者或群組ID

if (!process.env.LINE_CHANNEL_SECRET || !process.env.LINE_CHANNEL_ACCESS_TOKEN || !USER_ID) {
    console.error('請先設定環境變數 LINE_CHANNEL_SECRET、LINE_CHANNEL_ACCESS_TOKEN 與 USER_ID');
    process.exit(1);
}

const config = {
    channelSecret: process.env.LINE_CHANNEL_SECRET,
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN
};
const client = new Client(config);

app.use(bodyParser.json());
app.use(middleware(config));

let bosses = {}; // JSON 物件存放王資訊
const DATA_FILE = './boss.json';

// 讀取 JSON
if (fs.existsSync(DATA_FILE)) {
    try {
        bosses = JSON.parse(fs.readFileSync(DATA_FILE));
    } catch (e) {
        console.error('讀取 boss.json 失敗，使用空資料');
        bosses = {};
    }
}

// 儲存 JSON
function saveJSON() {
    fs.writeFileSync(DATA_FILE, JSON.stringify(bosses, null, 2));
}

// 計算剩餘時間
function getRemaining(boss) {
    const now = moment().tz(TZ);
    const spawn = moment(boss.next_spawn, 'YYYY-MM-DD HH:mm').tz(TZ);
    const diff = spawn.diff(now);
    if (diff <= 0) return '已重生';
    const duration = moment.duration(diff);
    const hours = Math.floor(duration.asHours());
    const minutes = duration.minutes();
    return `${hours}小時${minutes}分`;
}

// 處理 LINE 指令
app.post('/webhook', async (req, res) => {
    const events = req.body.events;
    for (const event of events) {
        if (event.type !== 'message' || event.message.type !== 'text') continue;
        const msg = event.message.text.trim();
        const replyToken = event.replyToken;

        if (msg === '/幫助') {
            await client.replyMessage(replyToken, {
                type: 'text',
                text: `/幫助：顯示說明\n/重生 王名 剩餘時間(例如3.06)：設定重生時間\n/刪除 王名：刪除王\n/BOSS：查詢所有王`
            });
        } else if (msg.startsWith('/重生 ')) {
            const parts = msg.split(' ');
            if (parts.length !== 3) {
                await client.replyMessage(replyToken, { type: 'text', text: '格式錯誤，範例：/重生 激3南 3.06' });
                continue;
            }
            const name = parts[1];
            const timeStr = parts[2];
            const [h, m] = timeStr.split('.').map(Number);
            if (isNaN(h) || isNaN(m)) {
                await client.replyMessage(replyToken, { type: 'text', text: '時間格式錯誤，範例：/重生 激3南 3.06' });
                continue;
            }
            const next_spawn = moment().tz(TZ).add(h, 'hours').add(m, 'minutes').format('YYYY-MM-DD HH:mm');
            bosses[name] = { next_spawn, alertSent: false };
            saveJSON();
            await client.replyMessage(replyToken, { type: 'text', text: `🕒 已登記 ${name} 將於 ${next_spawn} 重生` });
        } else if (msg.startsWith('/刪除 ')) {
            const name = msg.split(' ')[1];
            if (bosses[name]) {
                delete bosses[name];
                saveJSON();
                await client.replyMessage(replyToken, { type: 'text', text: `已刪除 ${name}` });
            } else {
                await client.replyMessage(replyToken, { type: 'text', text: `${name} 不存在` });
            }
        } else if (msg === '/BOSS') {
            if (Object.keys(bosses).length === 0) {
                await client.replyMessage(replyToken, { type: 'text', text: '目前沒有登記任何王' });
                continue;
            }
            let text = '';
            const now = moment().tz(TZ);
            const sorted = Object.entries(bosses).sort((a, b) => {
                const t1 = moment(a[1].next_spawn, 'YYYY-MM-DD HH:mm').tz(TZ);
                const t2 = moment(b[1].next_spawn, 'YYYY-MM-DD HH:mm').tz(TZ);
                return t1 - t2;
            });
            for (const [name, boss] of sorted) {
                const spawn = moment(boss.next_spawn, 'YYYY-MM-DD HH:mm').tz(TZ);
                const diff = spawn.diff(now);
                let remaining;
                if (diff <= 0) {
                    remaining = '已重生';
                } else {
                    const duration = moment.duration(diff);
                    remaining = `${duration.hours()}小時${duration.minutes()}分`;
                }
                text += `🕓 ${name} 剩餘 ${remaining}（重生時間：${boss.next_spawn}）\n`;
            }
            await client.replyMessage(replyToken, { type: 'text', text });
        }
    }
    res.sendStatus(200);
});

// 每分鐘檢查提醒前10分鐘
cron.schedule('* * * * *', async () => {
    const now = moment().tz(TZ);
    for (const [name, boss] of Object.entries(bosses)) {
        const spawn = moment(boss.next_spawn, 'YYYY-MM-DD HH:mm').tz(TZ);
        const diff = spawn.diff(now);
        const minutesLeft = Math.floor(diff / 60000);
        if (minutesLeft === 10 && !boss.alertSent) {
            try {
                await client.pushMessage(USER_ID, {
                    type: 'text',
                    text: `@ALL ⚔️ ${name} 即將在 10 分鐘後重生！（預定 ${spawn.format('HH:mm')}）`
                });
                boss.alertSent = true;
                saveJSON();
            } catch (err) {
                console.error('推播失敗', err);
            }
        }
        // 避免 alertSent 永遠 true，重生後清掉
        if (minutesLeft < 0 && boss.alertSent) {
            boss.alertSent = false;
            saveJSON();
        }
    }
});

app.listen(PORT, () => {
    console.log(`🚀 LINE Boss Bot running on port ${PORT}`);
    console.log('✅ JSON 已載入並確保可用');
});
