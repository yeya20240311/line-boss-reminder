// index.js - Single-sheet Google Sheets + LINE bot
import { Client, middleware } from "@line/bot-sdk";
import express from "express";
import { google } from "googleapis";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import cron from "node-cron";

dayjs.extend(utc);
dayjs.extend(timezone);
const TW_ZONE = "Asia/Taipei";

// ====== env / LINE 設定 ======
const LINE_CONFIG = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new Client(LINE_CONFIG);
const app = express();

// ====== Google Sheets 設定 ======
const SHEET_ID = process.env.GOOGLE_SHEETS_ID || process.env.GOOGLE_SHEET_ID;
const CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n") : null;

if (!SHEET_ID || !CLIENT_EMAIL || !PRIVATE_KEY) {
  console.error("請設定 GOOGLE_SHEETS_ID, GOOGLE_CLIENT_EMAIL, GOOGLE_PRIVATE_KEY 等環境變數");
  process.exit(1);
}

const auth = new google.auth.JWT({
  email: CLIENT_EMAIL,
  key: PRIVATE_KEY,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

// ====== 資料快取 ======
let bossData = {}; // { name: { interval: number, nextRespawn: ISOstring|null, notified: bool } }
let notifyEnabled = true; // 會與 Boss!E1 同步
const pushTarget = process.env.USER_ID || ""; // 推播目的地（需設定）

// ====== 載入 / 儲存 Google Sheet ======
async function loadFromSheet() {
  try {
    // 讀取 A2:D（資料列）
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: "Boss!A2:D",
    });
    const rows = res.data.values || [];
    bossData = {};
    for (const row of rows) {
      const name = row[0];
      if (!name) continue;
      const interval = parseFloat(row[1]) || 0;
      const nextIso = row[2] || null;
      const notified = (row[3] || "").toUpperCase() === "TRUE";
      bossData[name] = {
        interval,
        nextRespawn: nextIso || null,
        notified,
      };
    }

    // 讀取 E1（notify 狀態），若沒有則預設 true
    const meta = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: "Boss!E1",
    });
    const metaVal = (meta.data.values && meta.data.values[0] && meta.data.values[0][0]) || "";
    notifyEnabled = metaVal === "" ? true : metaVal.toUpperCase() === "TRUE";

    console.log("✅ 已從 Google Sheets 載入資料（單表 Boss）");
  } catch (err) {
    console.error("❌ 載入 Google Sheets 失敗：", err.message || err);
  }
}

async function saveToSheet() {
  try {
    // 把 bossData 轉為 rows
    const rows = Object.entries(bossData).map(([name, b]) => [
      name,
      b.interval != null ? String(b.interval) : "",
      b.nextRespawn || "",
      b.notified ? "TRUE" : "FALSE",
    ]);

    // 若沒有任何 row，則寫入空陣列以清空 A2:D
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: "Boss!A2:D",
      valueInputOption: "RAW",
      requestBody: { values: rows },
    });

    // 儲存 notifyEnabled 到 E1
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: "Boss!E1",
      valueInputOption: "RAW",
      requestBody: { values: [[notifyEnabled ? "TRUE" : "FALSE"]] },
    });
  } catch (err) {
    console.error("❌ 儲存到 Google Sheets 失敗：", err.message || err);
  }
}

// ====== 工具 ======
function parseHourDotMin(str) {
  // 接受 "5" 或 "5.3" 或 "0.45" 或 "1.07"
  if (typeof str !== "string" && typeof str !== "number") return null;
  const s = String(str).trim();
  if (s === "") return null;
  if (!s.includes(".")) {
    const h = parseInt(s, 10);
    return isNaN(h) ? null : { h, m: 0 };
  }
  const parts = s.split(".");
  const h = parseInt(parts[0] || "0", 10);
  // 分可能是 1 or 2 digits; padEnd(2,"0")
  const mStr = (parts[1] || "0").padEnd(2, "0").slice(0, 2);
  const m = parseInt(mStr, 10);
  if (isNaN(h) || isNaN(m) || m < 0 || m >= 60) return null;
  return { h, m };
}
function addHoursMinutesToNow(h, m) {
  return dayjs().tz(TW_ZONE).add(h, "hour").add(m, "minute").toISOString();
}
function diffMinutesFromNow(iso) {
  if (!iso) return Infinity;
  const then = dayjs(iso).tz(TW_ZONE);
  const now = dayjs().tz(TW_ZONE);
  const diff = then.diff(now, "minute");
  return diff;
}
function formatHHmm(iso) {
  return iso ? dayjs(iso).tz(TW_ZONE).format("HH:mm") : "—";
}

// ====== LINE webhook 路由（middleware 正確） ======
app.post("/webhook", middleware(LINE_CONFIG), async (req, res) => {
  try {
    const events = req.body.events || [];
    await Promise.all(events.map(handleEvent));
    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook 處理錯誤：", err);
    res.sendStatus(500);
  }
});
app.get("/", (req, res) => res.send("LINE Boss Reminder Bot (single-sheet Boss) running"));

// ====== 處理指令 ======
async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;
  const text = event.message.text.trim();
  const args = text.split(/\s+/);
  const replyToken = event.replyToken;
  const sourceId = event.source.userId || event.source.groupId || event.source.roomId;

  const replyText = async (t) => {
    try {
      await client.replyMessage(replyToken, { type: "text", text: t });
    } catch (e) {
      console.error("replyMessage 失敗：", e);
    }
  };

  // /幫助
  if (text === "/幫助") {
    return replyText(`可用指令：
/設定 王名 間隔(小時.分)   例如 /設定 冰1 5 或 /設定 冰1 5.30
/重生 王名 剩餘時間(小時.分) 例如 /重生 冰1 0.45 或 /重生 冰1 1.07
/刪除 王名
/王
/開啟通知
/關閉通知
/我的ID`);
  }

  // /我的ID
  if (text === "/我的ID") {
    return replyText(`你的 ID：${sourceId || "無法取得"}`);
  }

  // /設定 王名 間隔(小時.分)
  if (args[0] === "/設定" && args.length === 3) {
    const [, name, intervalStr] = args;
    const parsed = parseHourDotMin(intervalStr);
    if (!parsed) return replyText("❌ 間隔格式錯誤，請輸入 小時 或 小時.分（分鐘兩位數）例如 5 或 5.30");
    const { h, m } = parsed;
    // 將 interval 存為小時小數（例如 1.30 => 1.5? NO — 我們會保留原格式數字：h.m as number string）
    // 儲存為「小時.分」字串形式比較直觀，也方便你在 Sheets 看到
    const intervalValue = `${h}.${String(m).padStart(2, "0")}`;
    bossData[name] = bossData[name] || {};
    bossData[name].interval = intervalValue; // keep as string like "5.30"
    // NOTE: interval 用於下次自動加時間時計算時會 parse 回來
    await saveToSheet();
    return replyText(`✅ 已設定 ${name} 重生間隔 ${intervalValue} （小時.分）`);
  }

  // /重生 王名 剩餘時間(小時.分)
  if (args[0] === "/重生" && args.length === 3) {
    const [, name, remainStr] = args;
    if (!bossData[name] || !bossData[name].interval) {
      return replyText(`請先用 /設定 ${name} 間隔(小時.分)`);
    }
    const parsed = parseHourDotMin(remainStr);
    if (!parsed) return replyText("❌ 剩餘時間格式錯誤，請輸入 小時.分 例如 0.45 或 1.07");
    const { h, m } = parsed;
    const iso = addHoursMinutesToNow(h, m);
    bossData[name].nextRespawn = iso;
    bossData[name].notified = false;
    await saveToSheet();
    const respTime = formatHHmm(iso);
    return replyText(`🕒 已設定 ${name} 將於 ${respTime} 重生（剩餘 ${h} 小時 ${m} 分）`);
  }

  // /刪除 王名
  if (args[0] === "/刪除" && args.length === 2) {
    const name = args[1];
    if (!bossData[name]) return replyText(`${name} 不存在`);
    delete bossData[name];
    await saveToSheet();
    return replyText(`🗑 已刪除 ${name}`);
  }

  // /王
  if (text === "/王") {
    const now = dayjs().tz(TW_ZONE);
    const list = Object.keys(bossData)
      .map((name) => {
        const b = bossData[name];
        if (!b.nextRespawn) return { name, diff: Infinity, text: `❌ ${name} 尚未設定重生時間` };
        const diff = diffMinutesFromNow(b.nextRespawn);
        if (!isFinite(diff)) return { name, diff: Infinity, text: `❌ ${name} 重生時間格式錯誤` };
        const hh = Math.floor(diff / 60);
        const mm = diff % 60;
        const resp = formatHHmm(b.nextRespawn);
        return { name, diff, text: `⚔️ ${name} 剩餘 ${hh}小${mm}分（預計 ${resp}）` };
      })
      .sort((a, b) => a.diff - b.diff)
      .map((i) => i.text)
      .join("\n");
    return replyText(list || "尚無任何王的資料");
  }

  // /開啟通知
  if (text === "/開啟通知") {
    notifyEnabled = true;
    await saveToSheet();
    return replyText("✅ 已開啟所有前10分鐘通知");
  }

  // /關閉通知
  if (text === "/關閉通知") {
    notifyEnabled = false;
    await saveToSheet();
    return replyText("❌ 已關閉所有前10分鐘通知");
  }

  // 未知指令
  return replyText("無效指令，可輸入 /幫助 查看指令列表");
}

// ====== 每分鐘檢查重生前10分鐘提醒 ======
cron.schedule("* * * * *", async () => {
  try {
    const now = dayjs().tz(TW_ZONE);
    const hour = now.hour();

    for (const [name, b] of Object.entries(bossData)) {
      if (!b.nextRespawn || !b.interval) continue;
      const diff = diffMinutesFromNow(b.nextRespawn);
      if (!isFinite(diff)) continue;

      // 前10分鐘提醒（剛好在 minute 間隔落在 10）
      if (diff <= 10 && diff > 9 && !b.notified && notifyEnabled) {
        const respTime = formatHHmm(b.nextRespawn);
        const message = `${hour >= 9 && hour < 24 ? "@ALL " : ""}⚠️ ${name} 將於 ${respTime} 重生！（剩餘 10 分鐘）`;
        try {
          if (!pushTarget) console.warn("警告：環境變數 USER_ID 未設定，推播會失敗");
          else await client.pushMessage(pushTarget, { type: "text", text: message });
          b.notified = true;
          await saveToSheet();
          console.log("已推播提醒：", name);
        } catch (err) {
          console.error("推播失敗：", err);
        }
      }

      // 到時候（或逾時）自動更新下一次重生時間（若 interval 有填）
      if (diff <= 0) {
        // interval 以「小時.分」字串儲存，例如 "5.30"
        const parsed = parseHourDotMin(String(b.interval || ""));
        if (parsed) {
          const { h: ih, m: im } = parsed;
          // 下一次 = current nextRespawn + interval
          const next = dayjs(b.nextRespawn).tz(TW_ZONE).add(ih, "hour").add(im, "minute").toISOString();
          b.nextRespawn = next;
          b.notified = false;
          await saveToSheet();
          console.log(`${name} 重生後下一次時間已更新為 ${next}`);
        } else {
          // 若 interval 解析失敗，清除 notified 讓管理者修正
          b.notified = false;
          await saveToSheet();
          console.warn(`${name} 的 interval 解析失敗，請使用 /設定 ${name} 小時.分 更新`);
        }
      }
    }
  } catch (err) {
    console.error("cron 發生錯誤：", err);
  }
});

// ====== 啟動伺服器並載入資料 ======
const PORT = process.env.PORT || 10000;
app.listen(PORT, async () => {
  console.log(`🚀 LINE Boss Reminder Bot 上線，Port: ${PORT}`);
  await loadFromSheet();
});
