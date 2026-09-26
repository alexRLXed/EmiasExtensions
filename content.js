// Content Script (Isolated World) with Semi-Auto Telegram Support
(() => {
  // Centralized monitoring state
  const MonitorState = {
    capturedCount: 0,
    monitoringTimer: null,
    countdownTimer: null,
    nextCheckTimestamp: 0,
    isTgPollingActive: false,
    lastTgUpdateId: 0,
    pendingSlotToShift: null
  };

  // Safe timer disposal
  function cleanupTimers() {
    if (MonitorState.monitoringTimer) {
      clearTimeout(MonitorState.monitoringTimer);
      MonitorState.monitoringTimer = null;
    }
    if (MonitorState.countdownTimer) {
      clearInterval(MonitorState.countdownTimer);
      MonitorState.countdownTimer = null;
    }
  }

  // Sound chime synthesizer (Web Audio API)
  function playSuccessChime() {
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return;
      const audioCtx = new AudioContextClass();
      if (audioCtx.state === "suspended") {
        audioCtx.resume();
      }
      const notes = [523.25, 659.25, 783.99, 1046.50];
      notes.forEach((freq, idx) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.2, audioCtx.currentTime + idx * 0.12);
        gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + idx * 0.12 + 0.35);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(audioCtx.currentTime + idx * 0.12);
        osc.stop(audioCtx.currentTime + idx * 0.12 + 0.35);
      });
    } catch (e) {
      console.warn("AudioContext chime not available:", e);
    }
  }

  // Mini-log recording
  async function addLog(text, type = "info") {
    const time = new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const store = await chrome.storage.local.get("monitoringLogs");
    const logs = store.monitoringLogs || [];
    logs.push({ time, text, type });
    if (logs.length > 20) logs.shift();
    await chrome.storage.local.set({ monitoringLogs: logs });
    renderMiniLogUi(logs);
  }

  // Prevent accidental tab closure while monitoring is active
  function beforeUnloadHandler(e) {
    e.preventDefault();
    e.returnValue = "Мониторинг ЕМИАС активен. Если закрыть вкладку, поиск остановится!";
    return e.returnValue;
  }

  function setUnloadProtection(enable) {
    if (enable) {
      window.addEventListener("beforeunload", beforeUnloadHandler);
    } else {
      window.removeEventListener("beforeunload", beforeUnloadHandler);
    }
  }

  // -------------------------------------------------------------
  // Bridge to MAIN world interceptor
  // -------------------------------------------------------------
  const pendingRequests = new Map();

  function executeBridgeCmd(action, payload, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const reqId = "cmd_" + Date.now() + "_" + Math.random().toString(36).substring(2, 7);

      const timer = setTimeout(() => {
        pendingRequests.delete(reqId);
        reject(new Error("Timeout waiting for bridge response: " + action));
      }, timeoutMs);

      pendingRequests.set(reqId, { resolve, reject, timer });

      window.postMessage({
        source: "EMIAS_EXTENSION_CONTENT",
        action,
        reqId,
        payload
      }, "*");
    });
  }

  // Listen for bridge responses & events from MAIN world
  window.addEventListener("message", async (event) => {
    if (event.source !== window || !event.data || event.data.source !== "EMIAS_INTERCEPTOR") {
      return;
    }

    const { action, type, reqId, payload, data, error } = event.data;

    if (reqId && pendingRequests.has(reqId)) {
      const req = pendingRequests.get(reqId);
      clearTimeout(req.timer);
      pendingRequests.delete(reqId);

      if (error) req.reject(new Error(error));
      else req.resolve(data);
      return;
    }

    // Patient Context Sync
    if (type === "PATIENT_CONTEXT_SYNC" && payload) {
      const store = await chrome.storage.local.get("patientContext");
      const merged = { ...(store.patientContext || {}), ...payload };
      await chrome.storage.local.set({ patientContext: merged });
    }

    // EI-Token Sync
    if (type === "EI_TOKEN_SYNC" && payload && payload.eiToken) {
      await chrome.storage.local.set({ eiToken: payload.eiToken });
    }

    // Appointments Sync
    if (type === "APPOINTMENTS_SYNC" && payload) {
      await chrome.storage.local.set({
        appointments: payload.appointments,
        lastAppointmentsSync: Date.now()
      });
      renderFloatingUi();
    }

    // Doctors Info Sync
    if (type === "DOCTORS_INFO_SYNC" && payload) {
      const { appointmentId, doctorsInfo } = payload;
      const stored = await chrome.storage.local.get("doctorsInfoMap");
      const map = stored.doctorsInfoMap || {};
      if (appointmentId) {
        map[appointmentId] = doctorsInfo;
        map[String(appointmentId)] = doctorsInfo;
      }
      map["last"] = doctorsInfo;
      await chrome.storage.local.set({ doctorsInfoMap: map });
    }

    // Sniffer log
    if (type === "API_CAPTURED" && payload) {
      const store = await chrome.storage.local.get("capturedRequests");
      const list = store.capturedRequests || [];
      list.push(payload);
      if (list.length > 60) list.shift();
      await chrome.storage.local.set({ capturedRequests: list });
      MonitorState.capturedCount = list.length;
      updateFloatingCounter(MonitorState.capturedCount);
    }
  });

  // -------------------------------------------------------------
  // Helpers: Appointments Sync & Resilient Doctors List
  // -------------------------------------------------------------
  async function refreshAppointmentsAfterShift() {
    try {
      const patientStore = await chrome.storage.local.get("patientContext");
      const pCtx = patientStore.patientContext;
      if (pCtx) {
        const refreshed = await executeBridgeCmd("CMD_REFRESH_APPOINTMENTS", {
          omsNumber: String(pCtx.omsNumber),
          birthDate: String(pCtx.birthDate),
          patientId: pCtx.patientId ? String(pCtx.patientId) : null
        });
        if (refreshed && refreshed.payload && refreshed.payload.appointment) {
          await chrome.storage.local.set({
            appointments: refreshed.payload.appointment,
            lastAppointmentsSync: Date.now()
          });
          renderFloatingUi();
        }
      }
    } catch (e) {
      console.warn("[EMIAS] Не удалось синхронизировать записи после переноса:", e);
    }
  }

  async function getResilientDoctorsList(appointment, queryBridgeIfMissing = false) {
    const store = await chrome.storage.local.get(["doctorsInfoMap", "capturedRequests", "patientContext", "eiToken"]);
    const doctorsMap = store.doctorsInfoMap || {};
    let list = (appointment && (doctorsMap[appointment.id] || doctorsMap[String(appointment.id)])) || doctorsMap["last"] || null;

    if (!list || !Array.isArray(list) || list.length === 0) {
      const allLists = Object.values(doctorsMap).filter(v => Array.isArray(v) && v.length > 0);
      if (allLists.length > 0) {
        list = allLists[allLists.length - 1];
      }
    }

    if (!list || !Array.isArray(list) || list.length === 0) {
      const reqs = store.capturedRequests || [];
      const docReq = reqs.slice().reverse().find(r => r.url && (r.url.includes("getDoctorsInfoForLI") || r.url.includes("getDoctorsInfo")) && r.responseBody?.payload?.doctorsInfo);
      if (docReq && Array.isArray(docReq.responseBody.payload.doctorsInfo)) {
        list = docReq.responseBody.payload.doctorsInfo;
      }
    }

    if ((!list || !Array.isArray(list) || list.length === 0) && queryBridgeIfMissing && appointment) {
      const pCtx = store.patientContext;
      if (pCtx) {
        const isBM = Boolean(appointment.toBM || appointment.type === "BM");
        const res = await executeBridgeCmd("CMD_GET_DOCTORS_INFO", {
          appointmentId: Number(appointment.id),
          lpuId: Number(appointment.lpuId || 10000367),
          isBM,
          samplingTypeId: appointment.toBM?.id || 1,
          omsNumber: String(pCtx.omsNumber),
          birthDate: String(pCtx.birthDate),
          eiToken: store.eiToken || null
        });
        if (res && res.payload && Array.isArray(res.payload.doctorsInfo)) {
          list = res.payload.doctorsInfo;
          doctorsMap[appointment.id] = list;
          doctorsMap[String(appointment.id)] = list;
          doctorsMap["last"] = list;
          await chrome.storage.local.set({ doctorsInfoMap: doctorsMap });
        }
      }
    }

    return Array.isArray(list) ? list : [];
  }

  // -------------------------------------------------------------
  // Schedule & Shift API
  // -------------------------------------------------------------
  async function fetchAvailableSchedule(appointment, targetDateStr, configOverride = null) {
    const store = await chrome.storage.local.get(["patientContext", "monitoringConfig", "eiToken"]);
    const patientContext = store.patientContext;
    if (!patientContext || !patientContext.omsNumber || !patientContext.birthDate) {
      throw new Error("Сессия не синхронизирована. Обновите страницу ЕМИАС (F5)");
    }

    const doctorsInfoList = await getResilientDoctorsList(appointment, false);

    // Calculate dates: EMIAS mandates that dateFrom MUST ALWAYS BE today!
    // Querying with dateFrom in the future causes SA_REFERRAL_FOR_FUTURE (HTTP 400).
    const todayStr = getTodayDateStr();
    const dateFrom = todayStr;

    // Period: 7 days window starting from today (matches official EMIAS web portal)
    const fromObj = new Date(todayStr + "T00:00:00");
    const toObj = new Date(fromObj);
    toObj.setDate(toObj.getDate() + 7);

    // If target date is further than 7 days, extend dateTo (up to 14 days max)
    const cleanTargetDate = targetDateStr ? targetDateStr.split("T")[0] : todayStr;
    if (cleanTargetDate > todayStr) {
      const targetObj = new Date(cleanTargetDate + "T00:00:00");
      const diffDays = Math.ceil((targetObj - fromObj) / (1000 * 60 * 60 * 24));
      if (diffDays > 7) {
        toObj.setTime(fromObj.getTime() + Math.min(diffDays + 2, 14) * 86400000);
      }
    }
    const dateTo = formatIsoDate(toObj);

    const allCandidateResources = [];

    // 1. Current appointment's resource
    allCandidateResources.push({
      availableResourceId: Number(appointment.availableResourceId),
      complexResourceId: Number(appointment.complexResourceId),
      lpuId: Number(appointment.lpuId),
      lpuName: appointment.nameLpu || "",
      name: appointment.roomNumber || ""
    });

    // 2. Other resources ONLY if complexResourceId is known
    const config = configOverride || store.monitoringConfig || {};
    if (config.anyDoctor && Array.isArray(doctorsInfoList) && doctorsInfoList.length > 0) {
      for (const doc of doctorsInfoList) {
        if (Array.isArray(doc.availableResources)) {
          for (const res of doc.availableResources) {
            const resId = Number(res.id);
            if (resId !== Number(appointment.availableResourceId)) {
              const crList = res.complexResource;
              const compId = (Array.isArray(crList) && crList[0] && crList[0].id) ? Number(crList[0].id) : null;
              if (compId) {
                allCandidateResources.push({
                  availableResourceId: resId,
                  complexResourceId: compId,
                  lpuId: Number(doc.lpuId || res.lpuId),
                  lpuName: doc.lpuShortName || doc.defaultAddress || "",
                  name: res.name || ""
                });
              }
            }
          }
        }
      }
    }

    // Filter candidate resources by allowedLpuIds if configured
    const allowedLpus = Array.isArray(config.allowedLpuIds) && config.allowedLpuIds.length > 0
      ? config.allowedLpuIds.map(String)
      : null;

    const resourcesToQuery = allCandidateResources.filter(r => {
      if (!allowedLpus) return true;
      return allowedLpus.includes(String(r.lpuId));
    });

    let allSlots = [];

    for (const resInfo of resourcesToQuery) {
      try {
        const payload = {
          appointmentId: Number(appointment.id),
          availableResourceId: Number(resInfo.availableResourceId),
          complexResourceId: Number(resInfo.complexResourceId),
          omsNumber: String(patientContext.omsNumber),
          birthDate: String(patientContext.birthDate),
          eiToken: store.eiToken || null,
          period: {
            dateFrom: dateFrom,
            dateTo: dateTo
          }
        };

        const res = await executeBridgeCmd("CMD_GET_SCHEDULE", payload);
        if (res && res.payload && res.payload.scheduleOfDay) {
          const slots = extractSlotsFromSchedule(res.payload.scheduleOfDay, resInfo);
          allSlots = allSlots.concat(slots);
        }
      } catch (err) {
        console.warn("[EMIAS] Ошибка получения расписания ресурса:", resInfo.availableResourceId, err.message);
      }
    }

    return allSlots;
  }

  async function performShift(appointment, targetSlot) {
    const store = await chrome.storage.local.get(["patientContext", "eiToken"]);
    const patientContext = store.patientContext;
    if (!patientContext || !patientContext.omsNumber || !patientContext.birthDate) {
      throw new Error("Нет данных сессии пациента");
    }

    const payload = {
      appointmentId: Number(appointment.id),
      availableResourceId: Number(targetSlot.availableResourceId || appointment.availableResourceId),
      complexResourceId: Number(targetSlot.complexResourceId || appointment.complexResourceId),
      startTime: targetSlot.startTime,
      endTime: targetSlot.endTime,
      omsNumber: String(patientContext.omsNumber),
      birthDate: String(patientContext.birthDate),
      eiToken: store.eiToken || null
    };

    console.log("[EMIAS Assistant] Отправка запроса на сдвиг записи:", payload);
    const result = await executeBridgeCmd("CMD_SHIFT_APPOINTMENT", payload);

    if (result && result.payload && result.payload.appointmentId) {
      return result.payload;
    } else {
      const errMsg = (result && result.message) || (result && result.error && result.error.message) || "Ошибка переноса записи";
      throw new Error(errMsg);
    }
  }

  // -------------------------------------------------------------
  // Telegram Message Builders
  // -------------------------------------------------------------
  function buildTelegramConfirmationPrompt(appointment, bestSlot) {
    const apptName = appointment?.toBM ? appointment.toBM.name : (appointment?.specialityName || "Приём");
    const apptNum = appointment?.number ? ` (${appointment.number})` : "";
    const shortBranch = bestSlot.lpuName ? (bestSlot.lpuName.replace(/ГБУЗ|ДЗМ/gi, '').trim().split(" ").slice(-2).join(" ")) : "";
    const btnLabel = shortBranch ? `✅ Перенести на ${bestSlot.formattedTime} (${shortBranch})` : `✅ Перенести на ${bestSlot.formattedTime}`;

    const text = `🔔 *Найден подходящий талон в ЕМИАС!*\n\n` +
      `📋 *Процедура:* ${apptName}${apptNum}\n` +
      `🏥 *Филиал / Адрес:* *${bestSlot.lpuName}*\n` +
      `🩺 *Кабинет/Врач:* ${bestSlot.doctorName || bestSlot.cabinet || "Кабинет"}\n` +
      `🕒 *Новое время:* *${bestSlot.formattedFull}*\n` +
      `⏱️ *Отклонение:* ${bestSlot.absDiffMinutes} мин. от цели\n\n` +
      `Подтвердите перенос нажатием кнопки на телефоне:`;

    const keyboard = {
      inline_keyboard: [
        [{ text: btnLabel, callback_data: "shift_confirm" }],
        [{ text: "❌ Пропустить этот слот", callback_data: "shift_skip" }],
        [{ text: "⏹️ Прекратить поиск", callback_data: "shift_stop" }]
      ]
    };

    return { text, keyboard };
  }

  function buildTelegramSuccessMessage(appointment, targetSlot) {
    const apptNum = appointment?.number ? `\n📋 Номер: ${appointment.number}` : "";
    return `🎉 *Запись успешно перенесена!*${apptNum}\n\n` +
      `🕒 Новое время: *${targetSlot.formattedFull}*\n` +
      `🩺 Врач/Кабинет: ${targetSlot.doctorName || targetSlot.cabinet || "Кабинет"}\n` +
      `🏥 Место: ${targetSlot.lpuName}`;
  }

  function buildTelegramStatusMessage(appointment, monitoringConfig, monitoringActive) {
    const apptName = appointment?.toBM ? appointment.toBM.name : (appointment?.specialityName || "Приём");
    const target = monitoringConfig?.targetDatetime ? new Date(monitoringConfig.targetDatetime).toLocaleString("ru-RU") : "не указана";

    return `📊 *Текущий статус мониторинга:*\n\n` +
      `🔘 *Состояние:* ${monitoringActive ? "🟢 Активен (поиск слотов)" : "⏹️ Остановлен"}\n` +
      `📋 *Запись:* ${apptName} (${appointment?.number || ""})\n` +
      `📅 *Текущий приём:* ${appointment?.startTime ? new Date(appointment.startTime).toLocaleString("ru-RU") : ""}\n` +
      `🏥 *Филиал:* ${appointment?.nameLpu || ""}\n` +
      `🎯 *Цель переноса:* ${target}\n` +
      `🔄 *Проверок выполнено:* ${monitoringConfig?.checkCount || 0}\n` +
      `⏳ *Последняя проверка:* ${monitoringConfig?.lastCheckTime || "только что"}`;
  }

  function buildTelegramStartMessage(appointment, targetDatetime, modeLabel) {
    const apptName = appointment?.toBM ? appointment.toBM.name : (appointment?.specialityName || "Приём");
    return `🚀 *Мониторинг ЕМИАС запущен!*\n\n` +
      `📋 *Запись:* ${apptName}\n` +
      `🎯 *Целевое время:* ${new Date(targetDatetime).toLocaleString("ru-RU")}\n` +
      `⚙️ *Режим:* ${modeLabel}\n\n` +
      `Вы можете остановить поиск или запросить статус кнопками ниже:`;
  }

  // -------------------------------------------------------------
  // Telegram 2-Way Bot Polling (/stop, /status, inline confirm)
  // -------------------------------------------------------------
  async function startTelegramPoller() {
    if (MonitorState.isTgPollingActive) return;
    MonitorState.isTgPollingActive = true;

    // Restore lastTgUpdateId from persistent storage if available
    const initStore = await chrome.storage.local.get("lastTgUpdateId");
    if (initStore.lastTgUpdateId) {
      MonitorState.lastTgUpdateId = Math.max(MonitorState.lastTgUpdateId, initStore.lastTgUpdateId);
    }

    while (MonitorState.isTgPollingActive) {
      try {
        const store = await chrome.storage.local.get(["monitoringActive", "tgToken", "tgChatId", "monitoringConfig", "appointments"]);
        if (!store.tgToken) {
          MonitorState.isTgPollingActive = false;
          break;
        }

        const updates = await TelegramBot.getUpdates(store.tgToken, MonitorState.lastTgUpdateId + 1, 10);
        if (Array.isArray(updates) && updates.length > 0) {
          for (const u of updates) {
            MonitorState.lastTgUpdateId = Math.max(MonitorState.lastTgUpdateId, u.update_id);
            await chrome.storage.local.set({ lastTgUpdateId: MonitorState.lastTgUpdateId });

            // Handle callback_query (inline buttons)
            if (u.callback_query) {
              const cb = u.callback_query;
              const fromId = String(cb.from?.id || "");
              const targetChatId = String(store.tgChatId || "");

              if (fromId === targetChatId || targetChatId.includes(fromId)) {
                await handleTelegramCallback(cb, store);
              }
            }

            // Handle text commands (/stop, /status)
            if (u.message && u.message.text) {
              const text = u.message.text.trim();
              const fromId = String(u.message.from?.id || "");
              const targetChatId = String(store.tgChatId || "");

              if (fromId === targetChatId || targetChatId.includes(fromId)) {
                await handleTelegramCommand(text, store);
              }
            }
          }
        }
      } catch (err) {
        console.warn("[TG Poller Error]", err);
        await new Promise(r => setTimeout(r, 4000));
      }

      await new Promise(r => setTimeout(r, 1500));
    }
  }

  async function handleTelegramCommand(cmdText, store) {
    const { tgToken, tgChatId, monitoringConfig, appointments, monitoringActive } = store;

    if (cmdText === "/stop" || cmdText.includes("Прекратить") || cmdText.includes("Остановить")) {
      await stopMonitoring();
      await addLog("⏹️ Мониторинг остановлен по команде из Telegram", "stop");
      await TelegramBot.sendMessage(tgToken, tgChatId, "⏹️ *Мониторинг ЕМИАС остановлен.*\nЗапросы к порталу прекращены по вашей команде.", {
        replyMarkup: {
          keyboard: [
            [{ text: "📊 Проверить статус" }]
          ],
          resize_keyboard: true
        }
      });
    } else if (cmdText === "/status" || cmdText.includes("Статус") || cmdText.includes("статус")) {
      const appt = appointments?.find(a => String(a.id) === String(monitoringConfig?.appointmentId)) || appointments?.[0];
      const statusMsg = buildTelegramStatusMessage(appt, monitoringConfig, monitoringActive);

      await TelegramBot.sendMessage(tgToken, tgChatId, statusMsg, {
        replyMarkup: {
          keyboard: monitoringActive ? [
            [{ text: "📊 Проверить статус" }],
            [{ text: "⏹️ Прекратить поиск" }]
          ] : [
            [{ text: "📊 Проверить статус" }]
          ],
          resize_keyboard: true
        }
      });
    }
  }

  async function handleTelegramCallback(cb, store) {
    const { tgToken, tgChatId, appointments, monitoringConfig } = store;
    const action = cb.data;
    const msgId = cb.message?.message_id;

    if (action === "shift_confirm") {
      await TelegramBot.answerCallbackQuery(tgToken, cb.id, "Выполняется бронирование слота...");

      if (!MonitorState.pendingSlotToShift) {
        await TelegramBot.editMessageText(tgToken, tgChatId, msgId, "⚠️ Время ожидания подтверждения истекло или слот не найден. Мониторинг продолжается.");
        return;
      }

      // Keep targetSlot safe before stopMonitoring() clears pendingSlotToShift!
      const targetSlot = { ...MonitorState.pendingSlotToShift };

      await TelegramBot.editMessageText(tgToken, tgChatId, msgId, `⏳ Бронируем слот: *${targetSlot.formattedFull}* (${targetSlot.lpuName})...`);

      const appt = appointments?.find(a => String(a.id) === String(monitoringConfig?.appointmentId)) || appointments?.[0];
      try {
        await performShift(appt, targetSlot);
        playSuccessChime();
        await stopMonitoring();

        // Refresh active appointments from EMIAS server so popup and page show the new appointment!
        await refreshAppointmentsAfterShift();

        await addLog(`🎉 Успешно перенесено на ${targetSlot.formattedFull} (${targetSlot.lpuName})!`, "success");
        await TelegramBot.editMessageText(tgToken, tgChatId, msgId, buildTelegramSuccessMessage(appt, targetSlot));
        MonitorState.pendingSlotToShift = null;
      } catch (err) {
        await addLog(`⚠️ Ошибка бронирования: ${err.message}`, "error");
        await TelegramBot.editMessageText(tgToken, tgChatId, msgId, `⚠️ *Слот не удалось занять*: ${err.message}.\nПродолжаю поиск других слотов...`);
        MonitorState.pendingSlotToShift = null;
        scheduleNextCycle(10);
      }
    } else if (action === "shift_skip") {
      await TelegramBot.answerCallbackQuery(tgToken, cb.id, "Слот пропущен");
      await TelegramBot.editMessageText(tgToken, tgChatId, msgId, "❌ Слот пропущен. Продолжаем поиск подходящего времени...");
      MonitorState.pendingSlotToShift = null;
      scheduleNextCycle(10);
    } else if (action === "shift_stop") {
      await TelegramBot.answerCallbackQuery(tgToken, cb.id, "Мониторинг остановлен");
      await stopMonitoring();
      await addLog("⏹️ Мониторинг остановлен из Telegram", "stop");
      await TelegramBot.editMessageText(tgToken, tgChatId, msgId, "⏹️ Мониторинг остановлен.");
      MonitorState.pendingSlotToShift = null;
    }
  }

  // -------------------------------------------------------------
  // Monitoring Engine (Auto-Sniper / Semi-Auto)
  // -------------------------------------------------------------
  async function runMonitoringCycle() {
    const store = await chrome.storage.local.get(["monitoringActive", "monitoringConfig", "appointments", "tgToken", "tgChatId", "transferMode"]);
    if (!store.monitoringActive || !store.monitoringConfig) {
      stopMonitoring();
      return;
    }

    const config = store.monitoringConfig;
    const appointments = store.appointments || [];
    const appointment = appointments.find(a => String(a.id) === String(config.appointmentId)) || appointments[0];
    const transferMode = store.transferMode || "semi";

    if (!appointment) {
      await addLog("⚠️ Запись для переноса не найдена в списке активных", "error");
      scheduleNextCycle(30);
      return;
    }

    const checkCount = (config.checkCount || 0) + 1;
    config.checkCount = checkCount;
    config.lastCheckTime = new Date().toLocaleTimeString();
    await chrome.storage.local.set({ monitoringConfig: config });

    updateStatusUi(`Проверка №${checkCount}... Запрос расписания`);

    try {
      const targetDateStr = config.targetDatetime ? config.targetDatetime.split("T")[0] : "";
      const slots = await fetchAvailableSchedule(appointment, targetDateStr);

      const matched = findBestSlots(slots, config.targetDatetime, {
        windowMinutes: config.timeWindow === "any" ? null : parseInt(config.timeWindow, 10),
        onlyTargetDate: true
      });

      console.log(`[EMIAS Monitoring #${checkCount}] Всего слотов: ${slots.length}, подходящих: ${matched.length}`);

      if (matched.length > 0) {
        const bestSlot = matched[0];

        // 1. SEMI-AUTO MODE (Default): Ask via interactive Telegram button
        if (transferMode === "semi" && store.tgToken && store.tgChatId) {
          MonitorState.pendingSlotToShift = bestSlot;
          await addLog(`🎯 Найден слот ${bestSlot.formattedFull} (Δ ${bestSlot.absDiffMinutes} мин). Запрос подтверждения отправлен в Telegram`, "match");
          updateStatusUi(`🎯 Найден слот ${bestSlot.formattedTime}! Ожидание подтверждения в Telegram...`);

          const { text: promptText, keyboard } = buildTelegramConfirmationPrompt(appointment, bestSlot);
          await TelegramBot.sendMessage(store.tgToken, store.tgChatId, promptText, { replyMarkup: keyboard });
          scheduleNextCycle(90);
          return;
        }

        // 2. FULL-AUTO MODE: shift immediately
        updateStatusUi(`🎯 Автоперенос: найден слот ${bestSlot.formattedFull}. Бронируем...`);
        try {
          await performShift(appointment, bestSlot);
          playSuccessChime();
          await stopMonitoring();
          await refreshAppointmentsAfterShift();

          await addLog(`🎉 Успешно перенесено на ${bestSlot.formattedFull}!`, "success");
          updateStatusUi(`🎉 Запись перенесена на ${bestSlot.formattedFull}!`, true);

          if (store.tgToken && store.tgChatId) {
            await TelegramBot.sendMessage(store.tgToken, store.tgChatId, buildTelegramSuccessMessage(appointment, bestSlot));
          }
          return;
        } catch (shiftErr) {
          await addLog(`⚠️ Слот перехвачен: ${shiftErr.message}`, "error");
          updateStatusUi(`⚠️ Слот перехвачен. Продолжаем поиск...`);
        }
      } else {
        await addLog(`Проверка #${checkCount}: проверено слотов: ${slots.length}. Подходящих пока нет.`, "info");
        updateStatusUi(`Проверка #${checkCount}: подходящих слотов пока нет. Ждём отмен...`);
      }
    } catch (err) {
      await addLog(`Ошибка проверки: ${err.message}`, "error");
      updateStatusUi(`Ошибка проверки: ${err.message}`);
    }

    // Next cycle: base interval from settings (default 22) + random jitter 0-11 sec
    const configuredInterval = parseInt(config.intervalSeconds, 10);
    const baseInterval = Number.isFinite(configuredInterval) && configuredInterval > 0
      ? configuredInterval
      : 22;
    const jitterSeconds = baseInterval + Math.floor(Math.random() * 12);
    scheduleNextCycle(jitterSeconds);
  }

  // -------------------------------------------------------------
  // Monitoring Scheduler & Stop Controls
  // -------------------------------------------------------------
  function scheduleNextCycle(delaySeconds) {
    cleanupTimers();

    MonitorState.nextCheckTimestamp = Date.now() + delaySeconds * 1000;

    MonitorState.countdownTimer = setInterval(() => {
      const remaining = Math.max(0, Math.round((MonitorState.nextCheckTimestamp - Date.now()) / 1000));
      updateCountdownUi(remaining);
      if (remaining <= 0) {
        clearInterval(MonitorState.countdownTimer);
        MonitorState.countdownTimer = null;
      }
    }, 1000);

    MonitorState.monitoringTimer = setTimeout(runMonitoringCycle, delaySeconds * 1000);
  }

  async function stopMonitoring() {
    cleanupTimers();
    MonitorState.pendingSlotToShift = null;

    setUnloadProtection(false);

    const store = await chrome.storage.local.get("monitoringConfig");
    const config = store.monitoringConfig || {};
    config.active = false;
    await chrome.storage.local.set({
      monitoringActive: false,
      monitoringConfig: config
    });

    chrome.runtime.sendMessage({ type: "UPDATE_MONITOR_BADGE", active: false });
    renderFloatingUi();
  }

  // -------------------------------------------------------------
  // In-Page Floating UI & Indicators (Matches Popup Design)
  // -------------------------------------------------------------
  function updateFloatingCounter(count) {
    const counterEl = document.getElementById("requests-count");
    if (counterEl) {
      counterEl.textContent = String(count);
    }
    const snifferTab = document.getElementById("tab-sniffer");
    if (snifferTab && snifferTab.classList.contains("active")) {
      loadDrawerRequests();
    }
  }

  function updateStatusUi(text, isSuccess = false) {
    const badgeEl = document.getElementById("monitor-badge");
    const detailEl = document.getElementById("monitor-detail");
    if (detailEl) detailEl.textContent = text;
    if (badgeEl && isSuccess) {
      badgeEl.textContent = "🟢 Перенесено!";
      badgeEl.style.color = "#16a34a";
    }
  }

  function updateCountdownUi(seconds) {
    const counterEl = document.getElementById("monitor-counter");
    if (counterEl) {
      counterEl.textContent = seconds > 0 ? `(след. через ${seconds}с)` : "";
    }
  }

  function renderMiniLogUi(logs) {
    const logContainer = document.getElementById("popup-log-list");
    if (!logContainer) return;
    if (!logs || logs.length === 0) {
      logContainer.innerHTML = '<div class="empty-state">История проверок пока пуста</div>';
      return;
    }
    logContainer.innerHTML = logs.slice().reverse().map(l => {
      const cls = l.type === "success" ? "log-success" : (l.type === "match" ? "log-match" : (l.type === "error" ? "log-error" : (l.type === "stop" ? "log-stop" : "log-info")));
      return `
        <div class="log-item ${cls}">
          <span class="log-time">${l.time}</span> ${l.text}
        </div>
      `;
    }).join("");
  }

  async function loadDrawerRequests() {
    const data = await chrome.storage.local.get("capturedRequests");
    const list = data.capturedRequests || [];
    const countEl = document.getElementById("requests-count");
    if (countEl) countEl.textContent = list.length;

    const container = document.getElementById("requests-container");
    if (!container) return;

    if (list.length === 0) {
      container.innerHTML = '<div class="empty-state">Ожидание сетевой активности на emias.info...</div>';
      return;
    }

    container.innerHTML = list.slice().reverse().map(r => {
      const isGet = r.method === "GET";
      const isPost = r.method === "POST";
      const badgeCls = isGet ? "req-get" : (isPost ? "req-post" : "req-other");
      const urlShort = r.url.length > 52 ? r.url.substring(0, 49) + "..." : r.url;
      const timeStr = r.timestamp ? new Date(r.timestamp).toLocaleTimeString() : "";

      return `
        <div class="req-item">
          <div class="req-header">
            <span class="req-badge ${badgeCls}">${r.method}</span>
            <span class="req-time">${timeStr}</span>
          </div>
          <div class="req-url" title="${r.url}">${urlShort}</div>
        </div>
      `;
    }).join("");
  }

  function showFloatingToast(text, duration = 2200) {
    let toast = document.getElementById("floating-toast");
    if (!toast) return;
    toast.textContent = text;
    toast.classList.remove("hidden");
    setTimeout(() => toast.classList.add("hidden"), duration);
  }

  async function renderFloatingUi() {
    let container = document.getElementById("emias-assistant-root");
    if (!container) {
      container = document.createElement("div");
      container.id = "emias-assistant-root";
      document.body.appendChild(container);
    }

    const oldDrawer = document.getElementById("emias-drawer");
    const wasDrawerOpen = oldDrawer ? oldDrawer.style.display === "flex" : false;
    const activeTabId = oldDrawer?.querySelector(".tab-btn.active")?.getAttribute("data-tab") || "tab-control";

    const store = await chrome.storage.local.get([
      "monitoringActive",
      "monitoringConfig",
      "appointments",
      "patientContext",
      "monitoringLogs",
      "transferMode",
      "tgToken",
      "tgChatId",
      "capturedRequests"
    ]);

    const isMonitoring = Boolean(store.monitoringActive);
    const appointments = store.appointments || [];
    const hasAppointments = appointments.length > 0;
    const transferMode = store.transferMode || "semi";
    const config = store.monitoringConfig || {};
    const currentInterval = config.intervalSeconds || 22;

    const selectedApptId = config.appointmentId || (appointments[0] ? appointments[0].id : null);
    const currentAppt = appointments.find(a => String(a.id) === String(selectedApptId)) || appointments[0] || null;

    let targetDtVal = config.targetDatetime || "";
    if (!targetDtVal) {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      d.setHours(10, 0, 0, 0);
      targetDtVal = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    }

    container.innerHTML = `
      <style>
        #emias-assistant-root {
          all: initial;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
          z-index: 9999999;
          position: relative;
        }
        #emias-assistant-root * {
          box-sizing: border-box;
          margin: 0;
          padding: 0;
          font-family: inherit;
        }
        @keyframes emiasPulse {
          0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.7); }
          70% { transform: scale(1); box-shadow: 0 0 0 7px rgba(34, 197, 94, 0); }
          100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(34, 197, 94, 0); }
        }
        #emias-assistant-root .live-pulse {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: #22c55e;
          display: inline-block;
          animation: emiasPulse 1.8s infinite;
          flex-shrink: 0;
        }
        #emias-assistant-root .live-pulse.hidden {
          display: none !important;
        }

        #emias-badge-btn {
          position: fixed;
          bottom: 24px;
          right: 24px;
          z-index: 999999;
          background: ${isMonitoring ? "linear-gradient(135deg, #15803d, #166534)" : "linear-gradient(135deg, #00897B, #004D40)"};
          color: white;
          padding: 10px 16px;
          border-radius: 28px;
          font-size: 13px;
          font-weight: 600;
          box-shadow: 0 4px 18px rgba(0, 0, 0, 0.25);
          cursor: pointer;
          display: flex;
          align-items: center;
          gap: 8px;
          user-select: none;
          transition: transform 0.15s ease, box-shadow 0.15s ease;
        }
        #emias-badge-btn:hover {
          transform: translateY(-2px);
          box-shadow: 0 6px 22px rgba(0, 0, 0, 0.3);
        }
        #emias-badge-tag {
          background: rgba(255, 255, 255, 0.25);
          padding: 2px 8px;
          border-radius: 12px;
          font-size: 11px;
        }

        #emias-drawer {
          display: none;
          position: fixed;
          bottom: 76px;
          right: 24px;
          width: 420px;
          height: 600px;
          max-height: calc(100vh - 100px);
          background-color: #f8fafc;
          color: #1e293b;
          border-radius: 12px;
          box-shadow: 0 16px 44px rgba(0, 0, 0, 0.28);
          border: 1px solid #cbd5e1;
          flex-direction: column;
          overflow: hidden;
          z-index: 999999;
        }

        #emias-drawer .header {
          background: linear-gradient(135deg, #00897B, #004D40);
          color: white;
          padding: 11px 14px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          flex-shrink: 0;
        }
        #emias-drawer .logo-area {
          display: flex;
          align-items: center;
          gap: 10px;
        }
        #emias-drawer .logo-icon {
          font-size: 22px;
        }
        #emias-drawer .title {
          font-size: 14px;
          font-weight: 700;
          letter-spacing: -0.2px;
          line-height: 1.2;
        }
        #emias-drawer .version {
          font-size: 10px;
          opacity: 0.85;
        }
        #emias-drawer .status-pill {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 4px 10px;
          border-radius: 12px;
          font-size: 11px;
          font-weight: 500;
          background: rgba(255, 255, 255, 0.15);
        }
        #emias-drawer .status-pill .dot {
          width: 7px;
          height: 7px;
          border-radius: 50%;
          background-color: #4ade80;
          box-shadow: 0 0 6px #4ade80;
        }
        #emias-drawer .close-btn {
          background: none;
          border: none;
          color: white;
          font-size: 18px;
          cursor: pointer;
          padding: 2px 6px;
          border-radius: 4px;
          opacity: 0.85;
          line-height: 1;
        }
        #emias-drawer .close-btn:hover {
          opacity: 1;
          background: rgba(255, 255, 255, 0.2);
        }

        #emias-drawer .tabs {
          display: flex;
          background: #ffffff;
          border-bottom: 1px solid #e2e8f0;
          flex-shrink: 0;
        }
        #emias-drawer .tab-btn {
          flex: 1;
          background: none;
          border: none;
          padding: 10px 4px;
          font-size: 11.5px;
          font-weight: 600;
          color: #64748b;
          cursor: pointer;
          transition: all 0.15s;
          border-bottom: 2px solid transparent;
          text-align: center;
        }
        #emias-drawer .tab-btn:hover {
          color: #0f172a;
          background: #f1f5f9;
        }
        #emias-drawer .tab-btn.active {
          color: #00897B;
          border-bottom-color: #00897B;
        }

        #emias-drawer .tab-content {
          display: none;
          padding: 14px 16px;
          flex: 1;
          overflow-y: auto;
        }
        #emias-drawer .tab-content.active {
          display: block;
        }

        #emias-drawer .tab-warning {
          background: #fffbeb;
          border: 1px solid #fef3c7;
          border-radius: 8px;
          padding: 8px 10px;
          font-size: 11px;
          color: #92400e;
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 12px;
          line-height: 1.35;
        }

        #emias-drawer .monitor-card {
          border-radius: 8px;
          padding: 10px 12px;
          margin-bottom: 12px;
          border: 1px solid #e2e8f0;
        }
        #emias-drawer .monitor-card.inactive {
          background: #f1f5f9;
        }
        #emias-drawer .monitor-card.active {
          background: #f0fdf4;
          border-color: #bbf7d0;
        }
        #emias-drawer .monitor-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 4px;
        }
        #emias-drawer .badge {
          font-weight: 600;
          font-size: 12px;
        }
        #emias-drawer .subtext {
          font-size: 11px;
          color: #64748b;
        }
        #emias-drawer .monitor-detail {
          font-size: 11px;
          color: #334155;
          line-height: 1.35;
        }

        #emias-drawer .rich-card {
          background: white;
          border: 1px solid #cbd5e1;
          border-radius: 8px;
          padding: 10px 12px;
          margin-top: 4px;
          box-shadow: 0 1px 3px rgba(0,0,0,0.03);
        }
        #emias-drawer .rich-card-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 4px;
        }
        #emias-drawer .rich-badge {
          font-size: 10px;
          font-weight: 700;
          color: #00897B;
          background: #e6fffa;
          padding: 2px 6px;
          border-radius: 4px;
        }
        #emias-drawer .rich-sub {
          font-size: 11px;
          color: #64748b;
        }
        #emias-drawer .rich-title {
          font-weight: 700;
          font-size: 13px;
          color: #0f172a;
          margin-bottom: 4px;
        }
        #emias-drawer .rich-time {
          font-size: 11px;
          font-weight: 600;
          color: #1e293b;
          margin-bottom: 2px;
        }
        #emias-drawer .rich-lpu {
          font-size: 11px;
          color: #64748b;
        }
        #emias-drawer .form-select-inline {
          padding: 4px 8px;
          border-radius: 6px;
          border: 1px solid #cbd5e1;
          font-size: 11px;
          outline: none;
          background: white;
          max-width: 170px;
          color: #0f172a;
        }

        #emias-drawer .mode-selector {
          display: flex;
          gap: 8px;
        }
        #emias-drawer .mode-pill {
          flex: 1;
          border: 1px solid #cbd5e1;
          background: white;
          border-radius: 8px;
          padding: 8px 10px;
          cursor: pointer;
          display: flex;
          align-items: flex-start;
          gap: 8px;
          transition: all 0.15s;
        }
        #emias-drawer .mode-pill input {
          margin-top: 3px;
        }
        #emias-drawer .mode-pill.selected {
          border-color: #00897B;
          background: #f0fdfa;
        }
        #emias-drawer .mode-title {
          font-size: 12px;
          font-weight: 600;
          color: #0f172a;
        }
        #emias-drawer .mode-desc {
          font-size: 10px;
          color: #64748b;
          line-height: 1.25;
          margin-top: 2px;
        }

        #emias-drawer .form-group {
          margin-bottom: 12px;
        }
        #emias-drawer .form-row {
          display: flex;
          gap: 10px;
          align-items: flex-start;
        }
        #emias-drawer .checkbox-cell {
          display: flex;
          align-items: center;
          padding-top: 24px;
        }
        #emias-drawer .form-label {
          display: block;
          font-size: 12px;
          font-weight: 600;
          color: #334155;
          margin-bottom: 4px;
        }
        #emias-drawer .form-input, #emias-drawer .form-select {
          width: 100%;
          padding: 8px 10px;
          border-radius: 6px;
          border: 1px solid #cbd5e1;
          font-size: 12px;
          color: #0f172a;
          outline: none;
          background: white;
        }
        #emias-drawer .form-input:focus, #emias-drawer .form-select:focus {
          border-color: #00897B;
          box-shadow: 0 0 0 2px rgba(0, 137, 123, 0.15);
        }
        #emias-drawer .form-hint {
          display: block;
          font-size: 11px;
          color: #64748b;
          margin-top: 3px;
        }
        #emias-drawer .checkbox-label {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 11px;
          cursor: pointer;
          user-select: none;
          color: #334155;
        }

        #emias-drawer .branch-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 6px;
        }
        #emias-drawer .branch-actions {
          display: flex;
          align-items: center;
          gap: 6px;
        }
        #emias-drawer .branch-sep {
          color: #cbd5e1;
          font-size: 11px;
        }
        #emias-drawer .branch-list {
          background: white;
          border: 1px solid #cbd5e1;
          border-radius: 8px;
          padding: 6px;
          max-height: 140px;
          overflow-y: auto;
          display: flex;
          flex-direction: column;
          gap: 5px;
        }
        #emias-drawer .branch-item {
          display: flex;
          align-items: flex-start;
          gap: 8px;
          padding: 6px 8px;
          border-radius: 6px;
          background: #f8fafc;
          border: 1px solid #f1f5f9;
          cursor: pointer;
          transition: background-color 0.15s;
        }
        #emias-drawer .branch-item:hover {
          background: #f0fdfa;
          border-color: #ccfbf1;
        }
        #emias-drawer .branch-item input[type="checkbox"] {
          margin-top: 3px;
          accent-color: #00897B;
          cursor: pointer;
        }
        #emias-drawer .branch-item-info {
          display: flex;
          flex-direction: column;
          gap: 2px;
          flex: 1;
        }
        #emias-drawer .branch-item-name {
          font-size: 11px;
          font-weight: 600;
          color: #0f172a;
          display: flex;
          align-items: center;
          gap: 6px;
        }
        #emias-drawer .branch-current-tag {
          font-size: 9px;
          font-weight: 700;
          color: #00897B;
          background: #e6fffa;
          padding: 1px 5px;
          border-radius: 4px;
          text-transform: uppercase;
        }
        #emias-drawer .branch-item-address {
          font-size: 10px;
          color: #64748b;
          line-height: 1.25;
        }
        #emias-drawer .branch-empty {
          font-size: 11px;
          color: #64748b;
          padding: 10px 8px;
          text-align: center;
        }

        #emias-drawer .button-row {
          display: flex;
          gap: 8px;
          margin-top: 6px;
          margin-bottom: 12px;
        }
        #emias-drawer .btn {
          border: none;
          border-radius: 6px;
          padding: 8px 12px;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.15s ease;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 4px;
        }
        #emias-drawer .btn-primary {
          background: #00897B;
          color: white;
          flex: 1.2;
        }
        #emias-drawer .btn-primary:hover {
          background: #00796B;
        }
        #emias-drawer .btn-secondary {
          background: #e2e8f0;
          color: #334155;
          flex: 1;
        }
        #emias-drawer .btn-secondary:hover {
          background: #cbd5e1;
        }
        #emias-drawer .btn-danger {
          background: #dc2626 !important;
          color: white !important;
        }
        #emias-drawer .btn-danger:hover {
          background: #b91c1c !important;
        }
        #emias-drawer .btn-text {
          background: none;
          border: none;
          color: #00897B;
          font-size: 11px;
          font-weight: 600;
          cursor: pointer;
        }

        #emias-drawer .slots-box {
          background: white;
          border: 1px solid #e2e8f0;
          border-radius: 8px;
          padding: 10px;
          margin-top: 10px;
          max-height: 160px;
          overflow-y: auto;
        }
        #emias-drawer .slots-box.hidden {
          display: none;
        }
        #emias-drawer .slots-list {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        #emias-drawer .slot-card {
          display: flex;
          justify-content: space-between;
          align-items: center;
          background: #f8fafc;
          border: 1px solid #e2e8f0;
          border-radius: 6px;
          padding: 6px 8px;
        }
        #emias-drawer .slot-time {
          font-weight: 700;
          font-size: 13px;
          color: #0f172a;
        }
        #emias-drawer .slot-meta {
          font-size: 10px;
          color: #64748b;
        }
        #emias-drawer .slot-delta {
          font-size: 10px;
          background: #e0f2fe;
          color: #0284c7;
          padding: 1px 5px;
          border-radius: 4px;
          font-weight: 600;
        }
        #emias-drawer .slot-shift-btn {
          background: #00897B;
          color: white;
          border: none;
          padding: 4px 8px;
          border-radius: 4px;
          font-size: 11px;
          font-weight: 600;
          cursor: pointer;
        }

        #emias-drawer .mini-log-list {
          background: white;
          border: 1px solid #e2e8f0;
          border-radius: 8px;
          padding: 8px;
          max-height: 380px;
          overflow-y: auto;
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        #emias-drawer .log-item {
          font-size: 11px;
          line-height: 1.35;
          padding-bottom: 4px;
          border-bottom: 1px dashed #f1f5f9;
        }
        #emias-drawer .log-time {
          color: #94a3b8;
          font-size: 10px;
          font-family: monospace;
        }
        #emias-drawer .log-info { color: #475569; }
        #emias-drawer .log-match { color: #0284c7; font-weight: 600; }
        #emias-drawer .log-success { color: #16a34a; font-weight: 600; }
        #emias-drawer .log-error { color: #dc2626; }
        #emias-drawer .log-stop { color: #d97706; }

        #emias-drawer .info-card {
          background: #f0fdfa;
          border: 1px solid #ccfbf1;
          border-radius: 8px;
          padding: 10px 12px;
          display: flex;
          gap: 8px;
          margin-bottom: 12px;
        }
        #emias-drawer .info-text {
          font-size: 12px;
          color: #134e4a;
        }
        #emias-drawer .stats-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
          background: white;
          padding: 10px 12px;
          border-radius: 8px;
          border: 1px solid #e2e8f0;
          margin-bottom: 12px;
        }
        #emias-drawer .stat-value {
          font-size: 20px;
          font-weight: 700;
          color: #00897B;
        }
        #emias-drawer .requests-list {
          background: white;
          border: 1px solid #e2e8f0;
          border-radius: 8px;
          max-height: 320px;
          overflow-y: auto;
          display: flex;
          flex-direction: column;
          gap: 6px;
          padding: 8px;
        }
        #emias-drawer .req-item {
          background: #f8fafc;
          border: 1px solid #e2e8f0;
          border-radius: 6px;
          padding: 8px;
        }
        #emias-drawer .req-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 4px;
        }
        #emias-drawer .req-badge {
          font-size: 10px;
          font-weight: 700;
          padding: 1px 5px;
          border-radius: 3px;
          color: white;
        }
        #emias-drawer .req-get { background: #2563eb; }
        #emias-drawer .req-post { background: #16a34a; }
        #emias-drawer .req-other { background: #d97706; }
        #emias-drawer .req-time {
          font-size: 10px;
          color: #94a3b8;
        }
        #emias-drawer .req-url {
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
          font-size: 11px;
          color: #0f172a;
          word-break: break-all;
        }
        #emias-drawer .empty-state {
          text-align: center;
          color: #94a3b8;
          padding: 24px 12px;
          font-size: 12px;
        }
        #emias-drawer .status-msg {
          font-size: 11px;
          margin-top: 6px;
          min-height: 16px;
        }
        #emias-drawer .status-msg.success { color: #16a34a; }
        #emias-drawer .status-msg.error { color: #dc2626; }

        #emias-assistant-root .toast {
          position: fixed;
          bottom: 24px;
          left: 50%;
          transform: translateX(-50%);
          background: #1e293b;
          color: white;
          padding: 8px 16px;
          border-radius: 20px;
          font-size: 12px;
          box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25);
          transition: opacity 0.2s ease, transform 0.2s ease;
          z-index: 10000000;
        }
        #emias-assistant-root .toast.hidden {
          opacity: 0;
          pointer-events: none;
          transform: translateX(-50%) translateY(10px);
        }
      </style>

      <div id="emias-badge-btn">
        ${isMonitoring ? '<span class="live-pulse"></span>' : '<span style="font-size: 16px;">🩺</span>'}
        <span>${isMonitoring ? "Мониторинг активен" : "ЕМИАС Автоперенос"}</span>
        <span id="emias-badge-tag">${isMonitoring ? "Поиск..." : (hasAppointments ? `${appointments.length} зап.` : "Готов")}</span>
      </div>

      <div id="emias-drawer">
        <!-- Header -->
        <div class="header">
          <div class="logo-area">
            <span class="logo-icon">🩺</span>
            <div>
              <div class="title">ЕМИАС Автоперенос</div>
              <span class="version">v1.2.2 (Полуавтомат + TG)</span>
            </div>
          </div>
          <div style="display: flex; align-items: center; gap: 8px;">
            <div class="status-pill status-connected">
              <span class="dot"></span>
              <span class="status-text">ЕМИАС подключен</span>
            </div>
            <button id="emias-drawer-close" class="close-btn" title="Закрыть">✕</button>
          </div>
        </div>

        <!-- Navigation Tabs -->
        <div class="tabs">
          <button class="tab-btn active" data-tab="tab-control">⚡ Перенос</button>
          <button class="tab-btn" data-tab="tab-log">📜 Журнал</button>
          <button class="tab-btn" data-tab="tab-telegram">📱 Telegram</button>
          <button class="tab-btn" data-tab="tab-sniffer">🔍 API</button>
        </div>

        <!-- Tab 1: Control & Reschedule -->
        <div id="tab-control" class="tab-content active">
          <!-- Closing tab warning notice -->
          <div class="tab-warning">
            <span style="font-size: 14px;">💡</span>
            <span>Для работы автопоиска держите вкладку ЕМИАС открытой (её можно свернуть).</span>
          </div>

          <!-- Live Monitor Status Card -->
          <div id="monitor-status-card" class="monitor-card ${isMonitoring ? "active" : "inactive"}">
            <div class="monitor-header">
              <div style="display: flex; align-items: center; gap: 6px;">
                <span id="monitor-pulse-dot" class="live-pulse ${isMonitoring ? "" : "hidden"}"></span>
                <span id="monitor-badge" class="badge" style="color: ${isMonitoring ? "#15803d" : "#475569"};">
                  ${isMonitoring ? "Автопоиск запущен" : "⚪ Мониторинг выключен"}
                </span>
              </div>
              <span id="monitor-counter" class="subtext"></span>
            </div>
            <div id="monitor-detail" class="monitor-detail">
              ${isMonitoring ? "Режим: " + (transferMode === "semi" ? "Полуавтомат (кнопка в TG)" : "Полный автомат") + ". Опрос каждые ~" + currentInterval + "с (+случайный разброс)." : "Выберите параметры и запустите поиск или проверьте слоты прямо сейчас."}
            </div>
          </div>

          <!-- Rich Appointment Card -->
          <div class="form-group">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
              <label class="form-label" style="margin-bottom: 0;">Запись для переноса:</label>
              <select id="appointment-select" class="form-select-inline">
                ${appointments.length === 0 ? '<option value="">Нет сохраненных записей</option>' : appointments.map((a, idx) => {
                  const title = a.toBM ? a.toBM.name : (a.specialityName || "Приём");
                  const dStr = formatDate(a.startTime);
                  const tStr = formatTime(a.startTime);
                  return `<option value="${a.id}" ${String(a.id) === String(selectedApptId) ? "selected" : ""}>Запись #${idx + 1} (${title} · ${dStr} ${tStr})</option>`;
                }).join("")}
              </select>
            </div>

            <div id="rich-appointment-card" class="rich-card">
              ${currentAppt ? `
                <div class="rich-card-header">
                  <span id="card-appt-num" class="rich-badge">${currentAppt.number || "АКТИВНАЯ ЗАПИСЬ"}</span>
                  <span id="card-appt-branch-short" class="rich-sub">${currentAppt.nameLpu ? currentAppt.nameLpu.split(" ").slice(-2).join(" ") : ""}</span>
                </div>
                <div id="card-appt-title" class="rich-title">🩺 ${currentAppt.toBM ? currentAppt.toBM.name : (currentAppt.specialityName || "Приём врача")}</div>
                <div id="card-appt-time" class="rich-time">📅 ${formatDateTimeNice(currentAppt.startTime)}</div>
                <div id="card-appt-lpu" class="rich-lpu">📍 ${currentAppt.nameLpu || "Поликлиника"} (${currentAppt.roomNumber || ""})</div>
              ` : `
                <div class="rich-title" style="color: #64748b; font-weight: normal; text-align: center; padding: 6px;">🩺 Откройте emias.info для загрузки записей</div>
              `}
            </div>
          </div>

          <!-- Mode selection pills -->
          <div class="form-group">
            <label class="form-label">Режим бронирования:</label>
            <div class="mode-selector">
              <label class="mode-pill ${transferMode === "semi" ? "selected" : ""}">
                <input type="radio" name="drawer-transfer-mode" value="semi" ${transferMode === "semi" ? "checked" : ""}>
                <div>
                  <div class="mode-title">📲 Полуавтомат (TG)</div>
                  <div class="mode-desc">Присылает кнопку подтверждения на телефон</div>
                </div>
              </label>
              <label class="mode-pill ${transferMode === "auto" ? "selected" : ""}">
                <input type="radio" name="drawer-transfer-mode" value="auto" ${transferMode === "auto" ? "checked" : ""}>
                <div>
                  <div class="mode-title">⚡ Полный автомат</div>
                  <div class="mode-desc">Мгновенный перенос без вопросов</div>
                </div>
              </label>
            </div>
          </div>

          <!-- Target datetime -->
          <div class="form-group">
            <label class="form-label">Желаемое целевое время:</label>
            <input type="datetime-local" id="target-datetime" class="form-input" value="${targetDtVal}">
            <span class="form-hint">Система ищет слоты с наименьшим отклонением от этой даты и времени</span>
          </div>

          <!-- Tolerance window & Any doctor row -->
          <div class="form-group">
            <div class="form-row">
              <div style="flex: 1.4;">
                <label class="form-label">Окно допуска:</label>
                <select id="time-window" class="form-select">
                  <option value="15" ${config.timeWindow === "15" ? "selected" : ""}>±15 минут</option>
                  <option value="30" ${config.timeWindow === "30" ? "selected" : ""}>±30 минут</option>
                  <option value="60" ${config.timeWindow === "60" || !config.timeWindow ? "selected" : ""}>±1 час</option>
                  <option value="120" ${config.timeWindow === "120" ? "selected" : ""}>±2 часа</option>
                  <option value="any" ${config.timeWindow === "any" ? "selected" : ""}>Весь день</option>
                </select>
              </div>
              <div class="checkbox-cell" style="flex: 1;">
                <label class="checkbox-label">
                  <input type="checkbox" id="any-doctor" ${config.anyDoctor !== false ? "checked" : ""}>
                  <span>Любой врач</span>
                </label>
              </div>
            </div>
          </div>

          <!-- Interval slider -->
          <div class="form-group">
            <label class="form-label">Интервал проверки расписания:</label>
            <div style="display: flex; align-items: center; gap: 10px;">
              <input type="range" id="interval-range" min="10" max="120" step="1"
                     value="${currentInterval}" style="flex: 1; accent-color: #00897B;">
              <span id="interval-value" style="font-size: 12px; font-weight: 600; color: #00897B; min-width: 80px; text-align: right;">
                ${currentInterval} сек
              </span>
            </div>
            <span class="form-hint">Базовая пауза между проверками. К ней добавляется случайный разброс 0–11 сек. Если оставить 22 — как раньше.</span>
          </div>

          <!-- Branch Selection Container -->
          <div id="branch-selection-container" class="form-group">
            <div class="branch-header">
              <label class="form-label" style="margin-bottom: 0;">🏥 Подходящие филиалы:</label>
              <div class="branch-actions">
                <button type="button" id="branch-select-all-btn" class="btn-text">Выбрать все</button>
                <span class="branch-sep">|</span>
                <button type="button" id="branch-deselect-all-btn" class="btn-text">Снять все</button>
              </div>
            </div>
            <div id="branch-list" class="branch-list">
              <div class="branch-empty">Загрузка филиалов...</div>
            </div>
            <span class="form-hint">Слоты будут искаться только в отмеченных филиалах</span>
          </div>

          <!-- Action buttons -->
          <div class="button-row">
            <button id="find-now-btn" class="btn btn-secondary">🔍 Найти слоты сейчас</button>
            <button id="toggle-monitor-btn" class="btn ${isMonitoring ? "btn-danger" : "btn-primary"}">
              ${isMonitoring ? "⏹️ Остановить поиск" : "🚀 Запустить автоперенос"}
            </button>
          </div>

          <!-- Slots preview box -->
          <div id="quick-slots-container" class="slots-box hidden">
            <div class="slots-title">Подходящие слоты:</div>
            <div id="slots-list" class="slots-list"></div>
          </div>
        </div>

        <!-- Tab 2: Logs -->
        <div id="tab-log" class="tab-content">
          <div class="log-header">
            <span style="font-weight: 600; font-size: 12px; color: #475569;">История проверок:</span>
            <button id="popup-clear-log-btn" class="btn-text">Очистить</button>
          </div>
          <div id="popup-log-list" class="mini-log-list"></div>
        </div>

        <!-- Tab 3: Telegram Settings -->
        <div id="tab-telegram" class="tab-content">
          <div class="info-card">
            <span class="info-icon">💡</span>
            <div class="info-text">
              Создайте бота в <b>@BotFather</b> и скопируйте токен. Затем узнайте свой Chat ID в <b>@userinfobot</b>.
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">Telegram Bot Token:</label>
            <input type="password" id="tg-token" class="form-input" placeholder="123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ" value="${store.tgToken || ""}">
            <span class="form-hint">Токен из диалога с ботом @BotFather</span>
          </div>
          <div class="form-group">
            <label class="form-label">Telegram Chat ID:</label>
            <input type="text" id="tg-chat-id" class="form-input" placeholder="123456789" value="${store.tgChatId || ""}">
            <span class="form-hint">Ваш ID (можно узнать у бота @userinfobot)</span>
          </div>
          <div class="button-row">
            <button id="save-tg-btn" class="btn btn-primary">💾 Сохранить</button>
            <button id="test-tg-btn" class="btn btn-secondary">🔔 Проверить связь</button>
          </div>
          <div id="tg-test-status" class="status-msg"></div>
        </div>

        <!-- Tab 4: API Sniffer -->
        <div id="tab-sniffer" class="tab-content">
          <div class="stats-row">
            <div class="stat-box">
              <span class="stat-label">Перехвачено запросов:</span>
              <span id="requests-count" class="stat-value">${(store.capturedRequests || []).length}</span>
            </div>
            <div class="stat-actions">
              <button id="copy-summary-btn" class="btn btn-primary" style="padding: 6px 10px; font-size: 11px;">📋 Скопировать</button>
              <button id="clear-requests-btn" class="btn btn-secondary" style="padding: 6px 10px; font-size: 11px;">Очистить</button>
            </div>
          </div>
          <div class="section-title">Журнал API:</div>
          <div id="requests-container" class="requests-list"></div>
        </div>

        <!-- Footer Toast -->
        <div id="floating-toast" class="toast hidden"></div>
      </div>
    `;

    // Elements
    const badgeBtn = document.getElementById("emias-badge-btn");
    const drawer = document.getElementById("emias-drawer");
    const closeBtn = document.getElementById("emias-drawer-close");
    const tabButtons = drawer.querySelectorAll(".tab-btn");
    const tabContents = drawer.querySelectorAll(".tab-content");

    const apptSelect = document.getElementById("appointment-select");
    const targetDtInput = document.getElementById("target-datetime");
    const timeWindowSelect = document.getElementById("time-window");
    const anyDoctorCb = document.getElementById("any-doctor");
    const intervalRange = document.getElementById("interval-range");
    const intervalValue = document.getElementById("interval-value");
    const branchList = document.getElementById("branch-list");
    const branchSelectAllBtn = document.getElementById("branch-select-all-btn");
    const branchDeselectAllBtn = document.getElementById("branch-deselect-all-btn");
    const modePills = drawer.querySelectorAll(".mode-pill");
    const modeInputs = drawer.querySelectorAll("input[name='drawer-transfer-mode']");

    const findNowBtn = document.getElementById("find-now-btn");
    const toggleMonitorBtn = document.getElementById("toggle-monitor-btn");
    const quickSlotsContainer = document.getElementById("quick-slots-container");
    const slotsList = document.getElementById("slots-list");

    const popupClearLogBtn = document.getElementById("popup-clear-log-btn");
    const tgTokenInput = document.getElementById("tg-token");
    const tgChatIdInput = document.getElementById("tg-chat-id");
    const saveTgBtn = document.getElementById("save-tg-btn");
    const testTgBtn = document.getElementById("test-tg-btn");
    const tgTestStatus = document.getElementById("tg-test-status");

    const copySummaryBtn = document.getElementById("copy-summary-btn");
    const clearRequestsBtn = document.getElementById("clear-requests-btn");

    // Drawer toggle
    badgeBtn.addEventListener("click", () => {
      drawer.style.display = drawer.style.display === "none" ? "flex" : "none";
    });

    closeBtn.addEventListener("click", () => {
      drawer.style.display = "none";
    });

    // Tab switching
    function switchTab(targetId) {
      tabButtons.forEach(b => {
        if (b.getAttribute("data-tab") === targetId) b.classList.add("active");
        else b.classList.remove("active");
      });
      tabContents.forEach(c => {
        if (c.id === targetId) c.classList.add("active");
        else c.classList.remove("active");
      });
      if (targetId === "tab-log") {
        chrome.storage.local.get("monitoringLogs").then(s => renderMiniLogUi(s.monitoringLogs || []));
      }
      if (targetId === "tab-sniffer") {
        loadDrawerRequests();
      }
    }

    tabButtons.forEach(btn => {
      btn.addEventListener("click", () => {
        switchTab(btn.getAttribute("data-tab"));
      });
    });

    // Render branches
    async function loadBranchesForAppt(appt) {
      if (!branchList) return;
      if (!appt) {
        branchList.innerHTML = '<div class="branch-empty">Нет выбранной записи</div>';
        return;
      }
      const docsList = await getResilientDoctorsList(appt, true);
      const branches = extractBranches(appt, docsList);

      if (branches.length === 0) {
        branchList.innerHTML = `
          <div class="branch-empty">
            <div>Филиалы не определены</div>
            <div style="font-size: 10px; color: #94a3b8; margin-top: 3px;">💡 Откройте запись на сайте emias.info для загрузки филиалов</div>
          </div>
        `;
        return;
      }

      const savedAllowed = store.monitoringConfig?.allowedLpuIds;
      const fragment = document.createDocumentFragment();

      branches.forEach(b => {
        const isChecked = Array.isArray(savedAllowed)
          ? savedAllowed.map(String).includes(b.lpuId)
          : true;

        const item = document.createElement("label");
        item.className = "branch-item";
        item.innerHTML = `
          <input type="checkbox" class="branch-checkbox" value="${b.lpuId}" ${isChecked ? "checked" : ""}>
          <div class="branch-item-info">
            <div class="branch-item-name">
              <span>${b.name}</span>
              ${b.isCurrent ? '<span class="branch-current-tag">Текущий</span>' : ""}
            </div>
            ${b.address ? `<div class="branch-item-address">📍 ${b.address}</div>` : ""}
          </div>
        `;

        const cb = item.querySelector(".branch-checkbox");
        cb.addEventListener("change", async () => {
          const checked = Array.from(branchList.querySelectorAll(".branch-checkbox:checked")).map(c => c.value);
          const s = await chrome.storage.local.get("monitoringConfig");
          const cfg = s.monitoringConfig || {};
          cfg.allowedLpuIds = checked;
          await chrome.storage.local.set({ monitoringConfig: cfg });
        });

        fragment.appendChild(item);
      });

      branchList.innerHTML = "";
      branchList.appendChild(fragment);
    }

    await loadBranchesForAppt(currentAppt);

    // Branch select all / deselect all
    branchSelectAllBtn?.addEventListener("click", async () => {
      branchList.querySelectorAll(".branch-checkbox").forEach(cb => { cb.checked = true; });
      const checked = Array.from(branchList.querySelectorAll(".branch-checkbox:checked")).map(c => c.value);
      const s = await chrome.storage.local.get("monitoringConfig");
      const cfg = s.monitoringConfig || {};
      cfg.allowedLpuIds = checked;
      await chrome.storage.local.set({ monitoringConfig: cfg });
      showFloatingToast("Выбраны все филиалы");
    });

    branchDeselectAllBtn?.addEventListener("click", async () => {
      branchList.querySelectorAll(".branch-checkbox").forEach(cb => { cb.checked = false; });
      const s = await chrome.storage.local.get("monitoringConfig");
      const cfg = s.monitoringConfig || {};
      cfg.allowedLpuIds = [];
      await chrome.storage.local.set({ monitoringConfig: cfg });
      showFloatingToast("Все филиалы отключены");
    });

    // Appointment change
    apptSelect?.addEventListener("change", async () => {
      const selected = appointments.find(a => String(a.id) === String(apptSelect.value));
      const s = await chrome.storage.local.get("monitoringConfig");
      const cfg = s.monitoringConfig || {};
      cfg.appointmentId = apptSelect.value;
      await chrome.storage.local.set({ monitoringConfig: cfg });
      renderFloatingUi();
    });

    // Mode selection
    modeInputs.forEach(input => {
      input.addEventListener("change", async () => {
        modePills.forEach(p => p.classList.remove("selected"));
        input.closest(".mode-pill").classList.add("selected");
        await chrome.storage.local.set({ transferMode: input.value });
      });
    });

    // Interval slider handlers
    intervalRange?.addEventListener("input", () => {
      intervalValue.textContent = intervalRange.value + " сек";
    });

    intervalRange?.addEventListener("change", async () => {
      const s = await chrome.storage.local.get("monitoringConfig");
      const cfg = s.monitoringConfig || {};
      cfg.intervalSeconds = parseInt(intervalRange.value, 10);
      await chrome.storage.local.set({ monitoringConfig: cfg });
      showFloatingToast(`Интервал: ${cfg.intervalSeconds} сек`);
    });

    // Find now button
    findNowBtn.addEventListener("click", async () => {
      const targetDt = targetDtInput.value;
      if (!targetDt) {
        alert("Укажите желаемую дату и время");
        return;
      }
      const selectedLpus = Array.from(branchList.querySelectorAll(".branch-checkbox:checked")).map(cb => cb.value);
      if (selectedLpus.length === 0) {
        alert("Выберите хотя бы один подходящий филиал для поиска!");
        return;
      }

      findNowBtn.disabled = true;
      findNowBtn.innerText = "🔍 Поиск слотов...";
      quickSlotsContainer.classList.remove("hidden");
      slotsList.innerHTML = `<div style="color:#64748b;text-align:center;padding:10px;">Запрос расписания...</div>`;

      try {
        const apptId = apptSelect.value;
        const appt = appointments.find(a => String(a.id) === String(apptId)) || currentAppt;
        const slots = await fetchAvailableSchedule(appt, targetDt.split("T")[0], {
          anyDoctor: anyDoctorCb.checked,
          allowedLpuIds: selectedLpus
        });

        const matched = findBestSlots(slots, targetDt, {
          windowMinutes: timeWindowSelect.value === "any" ? null : parseInt(timeWindowSelect.value, 10),
          onlyTargetDate: true
        });

        if (matched.length === 0) {
          slotsList.innerHTML = `<div style="color:#64748b;text-align:center;padding:10px;">На эту дату подходящих слотов не найдено (проверено: ${slots.length}). Запустите автоперенос для ожидания отмен.</div>`;
        } else {
          slotsList.innerHTML = "";
          const fragment = document.createDocumentFragment();
          matched.slice(0, 6).forEach(slot => {
            const card = document.createElement("div");
            card.className = "slot-card";
            card.innerHTML = `
              <div>
                <div style="display:flex;align-items:center;gap:6px;">
                  <span class="slot-time">${slot.formattedTime}</span>
                  <span class="slot-delta">Δ ${slot.absDiffMinutes} мин</span>
                </div>
                <div class="slot-meta">${slot.doctorName || slot.cabinet || ""} · ${slot.lpuName}</div>
              </div>
              <button class="slot-shift-btn">Перенести</button>
            `;

            const btn = card.querySelector(".slot-shift-btn");
            btn.addEventListener("click", async () => {
              if (confirm(`Подтвердите перенос записи на ${slot.formattedFull}?`)) {
                btn.disabled = true;
                btn.innerText = "...";
                try {
                  await performShift(appt, slot);
                  playSuccessChime();
                  await refreshAppointmentsAfterShift();
                  await addLog(`Ручной перенос на ${slot.formattedFull} (${slot.lpuName})`, "success");
                  showFloatingToast("✅ Запись успешно перенесена!");
                  setTimeout(() => { drawer.style.display = "none"; }, 1000);
                } catch (err) {
                  alert("Ошибка переноса: " + err.message);
                  btn.disabled = false;
                  btn.innerText = "Перенести";
                }
              }
            });

            fragment.appendChild(card);
          });
          slotsList.appendChild(fragment);
        }
      } catch (err) {
        slotsList.innerHTML = `<div style="color:#dc2626;padding:8px;">Ошибка: ${err.message}</div>`;
      } finally {
        findNowBtn.disabled = false;
        findNowBtn.innerText = "🔍 Найти слоты сейчас";
      }
    });

    // Toggle monitor button
    toggleMonitorBtn.addEventListener("click", async () => {
      if (isMonitoring) {
        await stopMonitoring();
        await addLog("⏹️ Мониторинг остановлен пользователем", "stop");
        showFloatingToast("Мониторинг остановлен");
      } else {
        const apptId = apptSelect.value;
        const targetDt = targetDtInput.value;
        if (!targetDt) {
          alert("Укажите желаемое время для переноса");
          return;
        }

        const selectedLpus = Array.from(branchList.querySelectorAll(".branch-checkbox:checked")).map(cb => cb.value);
        if (selectedLpus.length === 0) {
          alert("Выберите хотя бы один подходящий филиал для поиска!");
          return;
        }

        const checkedRadio = drawer.querySelector("input[name='drawer-transfer-mode']:checked");
        const chosenMode = checkedRadio ? checkedRadio.value : "semi";

        const cfg = {
          appointmentId: apptId,
          targetDatetime: targetDt,
          timeWindow: timeWindowSelect.value,
          anyDoctor: anyDoctorCb.checked,
          transferMode: chosenMode,
          allowedLpuIds: selectedLpus,
          intervalSeconds: parseInt(intervalRange?.value, 10) || 22,
          checkCount: 0
        };

        await chrome.storage.local.set({
          monitoringActive: true,
          monitoringConfig: cfg,
          transferMode: chosenMode
        });

        setUnloadProtection(true);
        chrome.runtime.sendMessage({ type: "UPDATE_MONITOR_BADGE", active: true });

        const tgData = await chrome.storage.local.get(["tgToken", "tgChatId"]);
        if (tgData.tgToken && tgData.tgChatId) {
          const appt = appointments.find(a => String(a.id) === String(apptId)) || currentAppt;
          const modeLabel = chosenMode === "semi" ? "📲 Полуавтомат (подтверждение кнопкой)" : "⚡ Полный автомат";
          const startMsg = buildTelegramStartMessage(appt, targetDt, modeLabel);
          const keyboard = {
            keyboard: [
              [{ text: "📊 Проверить статус" }],
              [{ text: "⏹️ Прекратить поиск" }]
            ],
            resize_keyboard: true,
            persistent: true
          };
          await TelegramBot.sendMessage(tgData.tgToken, tgData.tgChatId, startMsg, { replyMarkup: keyboard });
          startTelegramPoller();
        }

        await addLog(`🚀 Запущен мониторинг (${chosenMode === "semi" ? "полуавтомат" : "полный автомат"}), интервал ~${cfg.intervalSeconds}с`, "info");
        showFloatingToast("🚀 Автоперенос запущен!");
        renderFloatingUi();
        runMonitoringCycle();
      }
    });

    // Clear logs
    popupClearLogBtn?.addEventListener("click", async () => {
      await chrome.storage.local.set({ monitoringLogs: [] });
      renderMiniLogUi([]);
      showFloatingToast("Журнал очищен");
    });

    // Save Telegram
    saveTgBtn?.addEventListener("click", async () => {
      const token = tgTokenInput.value.trim();
      const chatId = tgChatIdInput.value.trim();
      await chrome.storage.local.set({ tgToken: token, tgChatId: chatId });
      tgTestStatus.className = "status-msg success";
      tgTestStatus.textContent = "✅ Настройки сохранены";
      showFloatingToast("Настройки Telegram сохранены");
    });

    // Test Telegram
    testTgBtn?.addEventListener("click", async () => {
      const token = tgTokenInput.value.trim();
      const chatId = tgChatIdInput.value.trim();
      if (!token || !chatId) {
        tgTestStatus.className = "status-msg error";
        tgTestStatus.textContent = "⚠️ Заполните токен и Chat ID";
        return;
      }
      testTgBtn.disabled = true;
      tgTestStatus.className = "status-msg";
      tgTestStatus.textContent = "⏳ Отправка тестового сообщения...";
      try {
        const res = await TelegramBot.sendMessage(token, chatId, "🔔 *Тестовое сообщение* от расширения «ЕМИАС Автоперенос»!\nСвязь настроена успешно.");
        if (res && res.ok) {
          tgTestStatus.className = "status-msg success";
          tgTestStatus.textContent = "✅ Сообщение успешно отправлено в Telegram!";
        } else {
          tgTestStatus.className = "status-msg error";
          tgTestStatus.textContent = "❌ Ошибка: " + ((res && res.error) || "Не удалось отправить");
        }
      } catch (e) {
        tgTestStatus.className = "status-msg error";
        tgTestStatus.textContent = "❌ Ошибка сети: " + e.message;
      } finally {
        testTgBtn.disabled = false;
      }
    });

    // Copy API Summary
    copySummaryBtn?.addEventListener("click", async () => {
      const data = await chrome.storage.local.get("capturedRequests");
      const list = data.capturedRequests || [];
      const summary = {
        total: list.length,
        endpoints: list.map(r => ({
          method: r.method,
          url: r.url,
          status: r.status,
          request: r.requestBody,
          response: r.responseBody
        }))
      };
      navigator.clipboard.writeText(JSON.stringify(summary, null, 2));
      showFloatingToast("📋 Сводка API скопирована!");
    });

    // Clear API requests
    clearRequestsBtn?.addEventListener("click", async () => {
      await chrome.storage.local.set({ capturedRequests: [] });
      loadDrawerRequests();
      showFloatingToast("Журнал API очищен");
    });

    // Restore drawer visibility and tab
    if (wasDrawerOpen) {
      drawer.style.display = "flex";
    }
    switchTab(activeTabId);
  }

  // Auto-init
  window.addEventListener("DOMContentLoaded", renderFloatingUi);
  setTimeout(renderFloatingUi, 1500);

  // Resume active monitoring on page reload if previously enabled
  chrome.storage.local.get(["monitoringActive", "tgToken"]).then(store => {
    if (store.monitoringActive) {
      setUnloadProtection(true);
      if (store.tgToken) startTelegramPoller();
      setTimeout(runMonitoringCycle, 2000);
    }
  });

  // Message listener for commands from Popup
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "POPUP_SEARCH_SLOTS") {
      (async () => {
        try {
          const { appointmentId, targetDatetime, timeWindow, anyDoctor, allowedLpuIds } = message.payload;
          const store = await chrome.storage.local.get(["appointments", "monitoringConfig"]);
          const appointments = store.appointments || [];
          const appt = appointments.find(a => String(a.id) === String(appointmentId)) || appointments[0];
          if (!appt) {
            sendResponse({ success: false, error: "Запись не найдена" });
            return;
          }

          // Persist the user's branch selection
          const currentConfig = store.monitoringConfig || {};
          currentConfig.appointmentId = appointmentId;
          currentConfig.targetDatetime = targetDatetime;
          currentConfig.timeWindow = timeWindow;
          currentConfig.anyDoctor = anyDoctor;
          if (allowedLpuIds) currentConfig.allowedLpuIds = allowedLpuIds;
          await chrome.storage.local.set({ monitoringConfig: currentConfig });

          const targetDateStr = targetDatetime.split("T")[0];
          const slots = await fetchAvailableSchedule(appt, targetDateStr, { anyDoctor, allowedLpuIds });
          const matched = findBestSlots(slots, targetDatetime, {
            windowMinutes: timeWindow === "any" ? null : parseInt(timeWindow, 10),
            onlyTargetDate: true
          });

          sendResponse({ success: true, totalSlots: slots.length, matchedSlots: matched });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    if (message.type === "POPUP_EXECUTE_SHIFT") {
      (async () => {
        try {
          const { appointmentId, targetSlot } = message.payload;
          const store = await chrome.storage.local.get("appointments");
          const appointments = store.appointments || [];
          const appt = appointments.find(a => String(a.id) === String(appointmentId)) || appointments[0];

          await performShift(appt, targetSlot);
          playSuccessChime();
          await addLog(`Ручной перенос на ${targetSlot.formattedFull} (${targetSlot.lpuName})`, "success");

          // Refresh appointments from server so popup & in-page UI immediately reflect the change
          await refreshAppointmentsAfterShift();

          sendResponse({ success: true });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    if (message.type === "POPUP_FETCH_BRANCHES") {
      (async () => {
        try {
          const appt = message.payload?.appointment;
          if (!appt) {
            sendResponse({ success: false, error: "Нет данных записи" });
            return;
          }

          const doctorsInfo = await getResilientDoctorsList(appt, true);
          sendResponse({ success: true, doctorsInfo: doctorsInfo || [] });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    if (message.type === "POPUP_START_MONITOR") {
      (async () => {
        await chrome.storage.local.set({
          monitoringActive: true,
          monitoringConfig: message.payload,
          transferMode: message.payload.transferMode || "semi"
        });
        setUnloadProtection(true);
        chrome.runtime.sendMessage({ type: "UPDATE_MONITOR_BADGE", active: true });

        const tgData = await chrome.storage.local.get(["tgToken", "tgChatId", "appointments"]);
        if (tgData.tgToken && tgData.tgChatId) {
          const appt = tgData.appointments?.find(a => String(a.id) === String(message.payload.appointmentId)) || tgData.appointments?.[0];
          const modeLabel = message.payload.transferMode === "semi" ? "📲 Полуавтомат (подтверждение кнопкой)" : "⚡ Полный автомат";
          const startMsg = buildTelegramStartMessage(appt, message.payload.targetDatetime, modeLabel);

          const keyboard = {
            keyboard: [
              [{ text: "📊 Проверить статус" }],
              [{ text: "⏹️ Прекратить поиск" }]
            ],
            resize_keyboard: true,
            persistent: true
          };

          await TelegramBot.sendMessage(tgData.tgToken, tgData.tgChatId, startMsg, { replyMarkup: keyboard });
          startTelegramPoller();
        }

        await addLog("🚀 Мониторинг запущен из Popup", "info");
        runMonitoringCycle();
        renderFloatingUi();
        sendResponse({ success: true });
      })();
      return true;
    }

    if (message.type === "POPUP_STOP_MONITOR") {
      (async () => {
        await stopMonitoring();
        await addLog("⏹️ Мониторинг остановлен из Popup", "stop");
        chrome.runtime.sendMessage({ type: "UPDATE_MONITOR_BADGE", active: false });
        renderFloatingUi();
        sendResponse({ success: true });
      })();
      return true;
    }

    return false;
  });
})();
