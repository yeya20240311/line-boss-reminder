// 將你提供的完整 index.js 程式碼放在這裡
// index.js
require('dotenv').config();
const express = require('express');
const { middleware, Client } = require('@line/bot-sdk');

const app = express();

// 讀取環境變數
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

// LINE SDK client
const client = new Client(config);

// middleware 用來驗證 LINE webhook
app.use(middleware(config));

app.use(express.json());

app.post('/webhook', async (req, res) => {
  try {
    console.log('Webhook payload:', JSON.stringify(req.body, null, 2));

    const events = req.body.events;
    if (!events) return res.status(200).end();

    for (let event of events) {
      if (event.type === 'message' && event.message.type === 'text') {
        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: `你說了: ${event.message.text}`,
        });
      }
    }

    res.status(200).send('OK');
  } catch (err) {
    console.error('Webhook handling error:', err);
    res.status(500).send('Internal Server Error');
  }
});

// 監聽 Render 分配的 PORT
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`LINE Boss Reminder Bot running on port ${PORT}`);
});
