// Telegram Bot API Helper Module

// Telegram Bot API Helper Module

const TelegramBot = {
  /**
   * Escape Markdown special characters for safe Telegram messages
   * @param {string} text
   * @returns {string}
   */
  escapeMarkdown(text) {
    if (!text) return "";
    return String(text).replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
  },

  /**
   * Internal fetch with timeout
   */
  async _fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  },

  /**
   * Send a message to Telegram
   */
  async sendMessage(botToken, chatId, text, options = {}) {
    if (!botToken || !chatId) return null;
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const body = {
      chat_id: chatId,
      text: text,
      parse_mode: options.parseMode || "Markdown"
    };

    if (options.replyMarkup) {
      body.reply_markup = options.replyMarkup;
    }

    try {
      return await this._fetchWithTimeout(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      }, options.timeoutMs || 15000);
    } catch (err) {
      console.warn("[TelegramBot] Error sending message:", err.message);
      return { ok: false, error: err.message };
    }
  },

  /**
   * Edit existing message
   */
  async editMessageText(botToken, chatId, messageId, text, options = {}) {
    if (!botToken || !chatId || !messageId) return null;
    const url = `https://api.telegram.org/bot${botToken}/editMessageText`;
    const body = {
      chat_id: chatId,
      message_id: messageId,
      text: text,
      parse_mode: options.parseMode || "Markdown"
    };

    if (options.replyMarkup) {
      body.reply_markup = options.replyMarkup;
    }

    try {
      return await this._fetchWithTimeout(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      }, options.timeoutMs || 15000);
    } catch (err) {
      console.warn("[TelegramBot] Error editing message:", err.message);
      return { ok: false, error: err.message };
    }
  },

  /**
   * Answer callback query (inline button click)
   */
  async answerCallbackQuery(botToken, callbackQueryId, text = "") {
    if (!botToken || !callbackQueryId) return null;
    const url = `https://api.telegram.org/bot${botToken}/answerCallbackQuery`;
    try {
      return await this._fetchWithTimeout(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          callback_query_id: callbackQueryId,
          text: text
        })
      }, 10000);
    } catch (err) {
      console.warn("[TelegramBot] Error answering callback query:", err.message);
      return { ok: false, error: err.message };
    }
  },

  /**
   * Long polling getUpdates
   */
  async getUpdates(botToken, offset = 0, timeout = 10) {
    if (!botToken) return [];
    const url = `https://api.telegram.org/bot${botToken}/getUpdates?offset=${offset}&timeout=${timeout}`;
    try {
      const data = await this._fetchWithTimeout(url, {}, (timeout + 5) * 1000);
      return data && data.ok ? data.result : [];
    } catch (e) {
      return [];
    }
  }
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = TelegramBot;
}
