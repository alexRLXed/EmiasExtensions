// Background Service Worker (Manifest V3)
importScripts("utils/telegram.js");

function updateBadge(active) {
  const text = active ? "ON" : "";
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color: active ? "#16a34a" : "#64748b" });
}

// Initialize on extension install or update
chrome.runtime.onInstalled.addListener(async () => {
  console.log("[EMIAS Assistant] Расширение успешно установлено/обновлено.");
  const store = await chrome.storage.local.get("monitoringActive");
  updateBadge(Boolean(store.monitoringActive));
});

// Reactively keep badge in sync with monitoringActive in storage
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.monitoringActive) {
    updateBadge(Boolean(changes.monitoringActive.newValue));
  }
});

// Sync badge on service worker wake-up
chrome.storage.local.get("monitoringActive").then(store => {
  updateBadge(Boolean(store.monitoringActive));
});

// Message listener for popup & content requests
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 1. Send test message to Telegram
  if (message.type === "SEND_TELEGRAM_TEST") {
    (async () => {
      try {
        const { botToken, chatId } = message.payload || {};
        if (!botToken || !chatId) {
          sendResponse({ success: false, error: "Укажите Bot Token и Chat ID" });
          return;
        }

        const text = "🔔 *ЕМИАС Автоперенос*\nТестовое уведомление успешно доставлено!";
        const res = await TelegramBot.sendMessage(botToken, chatId, text);

        if (res && res.ok) {
          sendResponse({ success: true });
        } else {
          sendResponse({ success: false, error: res?.description || res?.error || "Ошибка Telegram API" });
        }
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true; // Keep message channel open for async response
  }

  // 2. Send actual success notification to Telegram
  if (message.type === "SEND_TELEGRAM_NOTIFICATION") {
    (async () => {
      try {
        const store = await chrome.storage.local.get(["tgToken", "tgChatId"]);
        const { tgToken, tgChatId } = store;
        if (!tgToken || !tgChatId) {
          console.log("[EMIAS Assistant] Telegram не настроен, уведомление пропущено");
          sendResponse({ success: false, reason: "Telegram not configured" });
          return;
        }

        const text = message.payload?.text || "🎉 Запись в ЕМИАС успешно перенесена!";
        const res = await TelegramBot.sendMessage(tgToken, tgChatId, text);
        sendResponse({ success: Boolean(res && res.ok) });
      } catch (err) {
        console.error("[EMIAS Assistant] Telegram send error:", err);
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  // 3. Explicit badge update command fallback
  if (message.type === "UPDATE_MONITOR_BADGE") {
    updateBadge(Boolean(message.active));
    sendResponse({ status: "ok" });
    return false;
  }

  return false;
});
