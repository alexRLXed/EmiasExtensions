// Popup script for EMIAS Reschedule Assistant v1.2.0
document.addEventListener("DOMContentLoaded", async () => {
  // Tabs
  const tabButtons = document.querySelectorAll(".tab-btn");
  const tabContents = document.querySelectorAll(".tab-content");

  // Elements
  const connStatus = document.getElementById("connection-status");
  const apptSelect = document.getElementById("appointment-select");
  const targetDtInput = document.getElementById("target-datetime");
  const timeWindowSelect = document.getElementById("time-window");
  const anyDoctorCb = document.getElementById("any-doctor");
  const intervalRange = document.getElementById("interval-range");
  const intervalValue = document.getElementById("interval-value");
  const branchSelectionContainer = document.getElementById("branch-selection-container");
  const branchList = document.getElementById("branch-list");
  const branchSelectAllBtn = document.getElementById("branch-select-all-btn");
  const branchDeselectAllBtn = document.getElementById("branch-deselect-all-btn");
  const findNowBtn = document.getElementById("find-now-btn");
  const toggleMonitorBtn = document.getElementById("toggle-monitor-btn");

  const monitorCard = document.getElementById("monitor-status-card");
  const monitorBadge = document.getElementById("monitor-badge");
  const monitorCounter = document.getElementById("monitor-counter");
  const monitorDetail = document.getElementById("monitor-detail");
  const monitorPulseDot = document.getElementById("monitor-pulse-dot");

  // Rich card elements
  const cardApptNum = document.getElementById("card-appt-num");
  const cardApptBranchShort = document.getElementById("card-appt-branch-short");
  const cardApptTitle = document.getElementById("card-appt-title");
  const cardApptTime = document.getElementById("card-appt-time");
  const cardApptLpu = document.getElementById("card-appt-lpu");

  // Mode elements
  const modePills = document.querySelectorAll(".mode-pill");
  const modeInputs = document.querySelectorAll("input[name='transfer-mode']");

  // Slots preview
  const quickSlotsContainer = document.getElementById("quick-slots-container");
  const slotsList = document.getElementById("slots-list");

  // Log Tab elements
  const popupLogList = document.getElementById("popup-log-list");
  const popupClearLogBtn = document.getElementById("popup-clear-log-btn");

  // Telegram Elements
  const tgTokenInput = document.getElementById("tg-token");
  const tgChatIdInput = document.getElementById("tg-chat-id");
  const saveTgBtn = document.getElementById("save-tg-btn");
  const testTgBtn = document.getElementById("test-tg-btn");
  const tgTestStatus = document.getElementById("tg-test-status");

  // Sniffer Elements
  const requestsCount = document.getElementById("requests-count");
  const requestsContainer = document.getElementById("requests-container");
  const copySummaryBtn = document.getElementById("copy-summary-btn");
  const clearRequestsBtn = document.getElementById("clear-requests-btn");
  const toast = document.getElementById("toast");

  let cachedAppointments = [];

  function showToast(text, duration = 2200) {
    toast.textContent = text;
    toast.classList.remove("hidden");
    setTimeout(() => toast.classList.add("hidden"), duration);
  }

  // Tab switching
  tabButtons.forEach(btn => {
    btn.addEventListener("click", () => {
      tabButtons.forEach(b => b.classList.remove("active"));
      tabContents.forEach(c => c.classList.remove("active"));
      btn.classList.add("active");
      const targetId = btn.getAttribute("data-tab");
      document.getElementById(targetId).classList.add("active");
      if (targetId === "tab-log") loadLogs();
    });
  });

  // Mode Selection pills
  modeInputs.forEach(input => {
    input.addEventListener("change", async () => {
      modePills.forEach(p => p.classList.remove("selected"));
      input.closest(".mode-pill").classList.add("selected");
      await chrome.storage.local.set({ transferMode: input.value });
    });
  });

  function getSelectedMode() {
    const checked = document.querySelector("input[name='transfer-mode']:checked");
    return checked ? checked.value : "semi";
  }

  async function initMode() {
    const store = await chrome.storage.local.get("transferMode");
    const mode = store.transferMode || "semi";
    modeInputs.forEach(input => {
      if (input.value === mode) {
        input.checked = true;
        modePills.forEach(p => p.classList.remove("selected"));
        input.closest(".mode-pill").classList.add("selected");
      }
    });
  }

  // Get active EMIAS tab
  async function getActiveEmiaTab() {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0];
      if (tab && tab.url && tab.url.includes("emias.info")) return tab;
      const allTabs = await chrome.tabs.query({ currentWindow: true });
      return allTabs.find(t => t.url && t.url.includes("emias.info")) || null;
    } catch (e) {
      return null;
    }
  }

  // Update connection indicator
  async function updateConnection() {
    const tab = await getActiveEmiaTab();
    if (tab) {
      connStatus.className = "status-pill status-connected";
      connStatus.innerHTML = '<span class="dot"></span><span class="status-text">ЕМИАС подключен</span>';
    } else {
      connStatus.className = "status-pill status-disconnected";
      connStatus.innerHTML = '<span class="dot"></span><span class="status-text">Откройте emias.info</span>';
    }
    return tab;
  }

  // Render Rich Appointment Card
  function updateRichCard(appt) {
    if (!appt) {
      cardApptNum.textContent = "НЕТ ЗАПИСЕЙ";
      cardApptBranchShort.textContent = "";
      cardApptTitle.textContent = "🩺 Откройте emias.info для загрузки записей";
      cardApptTime.textContent = "";
      cardApptLpu.textContent = "";
      return;
    }

    cardApptNum.textContent = appt.number || "АКТИВНАЯ ЗАПИСЬ";
    cardApptBranchShort.textContent = appt.nameLpu ? (appt.nameLpu.split(" ").slice(-2).join(" ")) : "";
    cardApptTitle.textContent = `🩺 ${appt.toBM ? appt.toBM.name : (appt.specialityName || "Приём врача")}`;
    cardApptTime.textContent = `📅 ${formatDateTimeNice(appt.startTime)}`;
    cardApptLpu.textContent = `📍 ${appt.nameLpu || "Поликлиника"} (${appt.roomNumber || ""})`;
  }

  // Load appointments
  async function loadAppointments() {
    const store = await chrome.storage.local.get(["appointments", "monitoringConfig"]);
    cachedAppointments = store.appointments || [];

    apptSelect.innerHTML = "";

    if (cachedAppointments.length === 0) {
      apptSelect.innerHTML = '<option value="">Нет сохраненных записей</option>';
      updateRichCard(null);
      return;
    }

    cachedAppointments.forEach((a, idx) => {
      const opt = document.createElement("option");
      opt.value = a.id;
      const dateStr = formatDate(a.startTime);
      const timeStr = formatTime(a.startTime);
      const title = a.toBM ? a.toBM.name : (a.specialityName || "Приём");
      opt.textContent = `Запись #${idx + 1} (${title} · ${dateStr} ${timeStr})`;
      apptSelect.appendChild(opt);
    });

    const targetId = store.monitoringConfig?.appointmentId || cachedAppointments[0].id;
    apptSelect.value = targetId;
    const selected = cachedAppointments.find(a => String(a.id) === String(apptSelect.value)) || cachedAppointments[0];
    updateRichCard(selected);
    await renderBranchSelector(selected);
  }

  apptSelect.addEventListener("change", async () => {
    const selected = cachedAppointments.find(a => String(a.id) === String(apptSelect.value));
    updateRichCard(selected);
    await renderBranchSelector(selected);
  });

  // Render Branch/Clinic Selector
  async function renderBranchSelector(selectedAppt) {
    if (!branchList) return;

    if (!selectedAppt) {
      branchList.innerHTML = '<div class="branch-empty">Нет выбранной записи</div>';
      return;
    }

    const store = await chrome.storage.local.get(["doctorsInfoMap", "monitoringConfig", "capturedRequests"]);
    const doctorsMap = store.doctorsInfoMap || {};
    let doctorsList = doctorsMap[selectedAppt.id] || doctorsMap[String(selectedAppt.id)] || doctorsMap["last"] || null;

    // Fallback 1: Any existing entry in doctorsInfoMap
    if (!doctorsList || !Array.isArray(doctorsList) || doctorsList.length === 0) {
      const allLists = Object.values(doctorsMap).filter(v => Array.isArray(v) && v.length > 0);
      if (allLists.length > 0) {
        doctorsList = allLists[allLists.length - 1];
      }
    }

    // Fallback 2: Check capturedRequests sniffer history
    if (!doctorsList || !Array.isArray(doctorsList) || doctorsList.length === 0) {
      const reqs = store.capturedRequests || [];
      const docReq = reqs.slice().reverse().find(r => r.url && (r.url.includes("getDoctorsInfoForLI") || r.url.includes("getDoctorsInfo")) && r.responseBody?.payload?.doctorsInfo);
      if (docReq && Array.isArray(docReq.responseBody.payload.doctorsInfo)) {
        doctorsList = docReq.responseBody.payload.doctorsInfo;
        doctorsMap[selectedAppt.id] = doctorsList;
        doctorsMap["last"] = doctorsList;
        chrome.storage.local.set({ doctorsInfoMap: doctorsMap });
      }
    }

    // Fallback 3: Query active tab to fetch doctorsInfo via bridge
    if (!doctorsList || !Array.isArray(doctorsList) || doctorsList.length === 0) {
      try {
        const tab = await getActiveEmiaTab();
        if (tab) {
          const res = await chrome.tabs.sendMessage(tab.id, {
            type: "POPUP_FETCH_BRANCHES",
            payload: { appointment: selectedAppt }
          });
          if (res && res.success && Array.isArray(res.doctorsInfo) && res.doctorsInfo.length > 0) {
            doctorsList = res.doctorsInfo;
          }
        }
      } catch (e) {
        // Tab not responsive
      }
    }

    const branches = extractBranches(selectedAppt, doctorsList);

    if (branches.length === 0) {
      branchList.innerHTML = `
        <div class="branch-empty">
          <div>Филиалы не определены</div>
          <div class="branch-empty-hint">💡 Откройте запись на сайте emias.info для загрузки филиалов</div>
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
            ${b.isCurrent ? '<span class="branch-current-tag">Текущий</span>' : ''}
          </div>
          ${b.address ? `<div class="branch-item-address">📍 ${b.address}</div>` : ''}
        </div>
      `;

      const cb = item.querySelector(".branch-checkbox");
      cb.addEventListener("change", async () => {
        await saveCurrentAllowedLpus();
      });

      fragment.appendChild(item);
    });

    branchList.innerHTML = "";
    branchList.appendChild(fragment);
  }

  function getSelectedLpuIds() {
    if (!branchList) return [];
    return Array.from(branchList.querySelectorAll(".branch-checkbox:checked")).map(cb => cb.value);
  }

  async function saveCurrentAllowedLpus() {
    const checked = getSelectedLpuIds();
    const store = await chrome.storage.local.get("monitoringConfig");
    const cfg = store.monitoringConfig || {};
    cfg.allowedLpuIds = checked;
    await chrome.storage.local.set({ monitoringConfig: cfg });
  }

  if (branchSelectAllBtn) {
    branchSelectAllBtn.addEventListener("click", async () => {
      branchList.querySelectorAll(".branch-checkbox").forEach(cb => { cb.checked = true; });
      await saveCurrentAllowedLpus();
      showToast("Выбраны все филиалы");
    });
  }

  if (branchDeselectAllBtn) {
    branchDeselectAllBtn.addEventListener("click", async () => {
      branchList.querySelectorAll(".branch-checkbox").forEach(cb => { cb.checked = false; });
      await saveCurrentAllowedLpus();
      showToast("Все филиалы отключены");
    });
  }

  // Populate default target datetime
  async function initTargetDateTime() {
    const store = await chrome.storage.local.get("monitoringConfig");
    if (store.monitoringConfig && store.monitoringConfig.targetDatetime) {
      targetDtInput.value = store.monitoringConfig.targetDatetime;
      if (store.monitoringConfig.timeWindow) timeWindowSelect.value = store.monitoringConfig.timeWindow;
      if (store.monitoringConfig.anyDoctor !== undefined) anyDoctorCb.checked = store.monitoringConfig.anyDoctor;
      if (store.monitoringConfig.appointmentId) apptSelect.value = store.monitoringConfig.appointmentId;
	  if (store.monitoringConfig.intervalSeconds) {
        intervalRange.value = store.monitoringConfig.intervalSeconds;
        intervalValue.textContent = store.monitoringConfig.intervalSeconds + " сек";
      }
    } else {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      d.setHours(10, 0, 0, 0);
      const localIso = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
      targetDtInput.value = localIso;
    }
  }
	
  // Interval slider
  intervalRange?.addEventListener("input", () => {
    intervalValue.textContent = intervalRange.value + " сек";
  });

  intervalRange?.addEventListener("change", async () => {
    const s = await chrome.storage.local.get("monitoringConfig");
    const cfg = s.monitoringConfig || {};
    cfg.intervalSeconds = parseInt(intervalRange.value, 10);
    await chrome.storage.local.set({ monitoringConfig: cfg });
    showToast(`Интервал: ${cfg.intervalSeconds} сек`);
  });
  
  // Render Monitor Card
  async function updateMonitorCard() {
    const store = await chrome.storage.local.get(["monitoringActive", "monitoringConfig", "transferMode"]);
    const isActive = Boolean(store.monitoringActive);
    const config = store.monitoringConfig || {};
    const mode = store.transferMode || "semi";

    if (isActive) {
      monitorCard.className = "monitor-card active";
      monitorPulseDot.classList.remove("hidden");
      monitorBadge.innerHTML = "Автопоиск запущен";
      monitorBadge.style.color = "#15803d";
      monitorCounter.textContent = `Проверок: ${config.checkCount || 0}`;

      const modeStr = mode === "semi" ? "Полуавтомат (кнопка в TG)" : "Полный автомат";
      const iv = config.intervalSeconds || 22;
      monitorDetail.innerHTML = `Режим: <b>${modeStr}</b>. Опрос каждые ~${iv}с (+случайный разброс). При появлении слота придет запрос в Telegram.`;
      toggleMonitorBtn.textContent = "⏹️ Остановить поиск";
      toggleMonitorBtn.className = "btn btn-danger";
    } else {
      monitorCard.className = "monitor-card inactive";
      monitorPulseDot.classList.add("hidden");
      monitorBadge.innerHTML = "⚪ Мониторинг выключен";
      monitorBadge.style.color = "#475569";
      monitorCounter.textContent = "";
      monitorDetail.textContent = "Выберите запись, желаемое время и запустите поиск слотов.";
      toggleMonitorBtn.textContent = "🚀 Запустить автоперенос";
      toggleMonitorBtn.className = "btn btn-primary";
    }
  }

  // Mini Logs
  async function loadLogs() {
    const store = await chrome.storage.local.get("monitoringLogs");
    const logs = store.monitoringLogs || [];

    if (logs.length === 0) {
      popupLogList.innerHTML = '<div class="empty-state">История проверок пока пуста</div>';
      return;
    }

    popupLogList.innerHTML = logs.slice().reverse().map(l => {
      const cls = l.type === "success" ? "log-success" : (l.type === "match" ? "log-match" : (l.type === "error" ? "log-error" : (l.type === "stop" ? "log-stop" : "log-info")));
      return `
        <div class="log-item ${cls}">
          <span class="log-time">${l.time}</span> ${l.text}
        </div>
      `;
    }).join("");
  }

  popupClearLogBtn.addEventListener("click", async () => {
    await chrome.storage.local.set({ monitoringLogs: [] });
    await loadLogs();
    showToast("Журнал очищен");
  });

  // Find Now
  findNowBtn.addEventListener("click", async () => {
    const tab = await getActiveEmiaTab();
    if (!tab) {
      alert("Откройте вкладку https://emias.info/app/einfo/ в браузере!");
      return;
    }

    if (!targetDtInput.value) {
      alert("Укажите желаемую дату и время");
      return;
    }

    findNowBtn.disabled = true;
    findNowBtn.innerText = "🔍 Поиск слотов...";
    quickSlotsContainer.classList.remove("hidden");
    slotsList.innerHTML = `<div style="color:#64748b;text-align:center;padding:10px;">Запрос расписания...</div>`;

    const selectedLpus = getSelectedLpuIds();
    if (selectedLpus.length === 0) {
      alert("Выберите хотя бы один подходящий филиал для поиска!");
      findNowBtn.disabled = false;
      findNowBtn.innerText = "🔍 Найти слоты сейчас";
      quickSlotsContainer.classList.add("hidden");
      return;
    }

    try {
      const payload = {
        appointmentId: apptSelect.value,
        targetDatetime: targetDtInput.value,
        timeWindow: timeWindowSelect.value,
        anyDoctor: anyDoctorCb.checked,
        allowedLpuIds: selectedLpus
      };

      const response = await chrome.tabs.sendMessage(tab.id, {
        type: "POPUP_SEARCH_SLOTS",
        payload
      });

      if (!response || !response.success) {
        slotsList.innerHTML = `<div style="color:#dc2626;padding:8px;">${response ? response.error : "Обновите вкладку ЕМИАС."}</div>`;
        return;
      }

      const matched = response.matchedSlots || [];
      if (matched.length === 0) {
        slotsList.innerHTML = `<div style="color:#64748b;text-align:center;padding:10px;">На эту дату подходящих слотов не найдено (проверено: ${response.totalSlots}). Запустите автоперенос для ожидания отмен.</div>`;
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
              const shiftRes = await chrome.tabs.sendMessage(tab.id, {
                type: "POPUP_EXECUTE_SHIFT",
                payload: {
                  appointmentId: apptSelect.value,
                  targetSlot: slot
                }
              });

              if (shiftRes && shiftRes.success) {
                showToast("✅ Запись успешно перенесена!");
                setTimeout(() => window.close(), 1200);
              } else {
                alert("Ошибка переноса: " + (shiftRes ? shiftRes.error : "Неизвестная ошибка"));
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
      slotsList.innerHTML = `<div style="color:#dc2626;padding:8px;">Ошибка связи: ${err.message}. Убедитесь, что вкладка ЕМИАС открыта.</div>`;
    } finally {
      findNowBtn.disabled = false;
      findNowBtn.innerText = "🔍 Найти слоты сейчас";
    }
  });

  // Toggle Monitor
  toggleMonitorBtn.addEventListener("click", async () => {
    const tab = await getActiveEmiaTab();
    if (!tab) {
      alert("Откройте вкладку https://emias.info/app/einfo/ в браузере!");
      return;
    }

    const store = await chrome.storage.local.get("monitoringActive");
    const isActive = Boolean(store.monitoringActive);

    if (isActive) {
      await chrome.tabs.sendMessage(tab.id, { type: "POPUP_STOP_MONITOR" });
      await updateMonitorCard();
      showToast("Мониторинг остановлен");
    } else {
      if (!targetDtInput.value) {
        alert("Укажите желаемое время");
        return;
      }

      const selectedLpus = getSelectedLpuIds();
      if (selectedLpus.length === 0) {
        alert("Выберите хотя бы один подходящий филиал для поиска!");
        return;
      }

      const config = {
        appointmentId: apptSelect.value,
        targetDatetime: targetDtInput.value,
        timeWindow: timeWindowSelect.value,
        anyDoctor: anyDoctorCb.checked,
        transferMode: getSelectedMode(),
        allowedLpuIds: selectedLpus,
		intervalSeconds: parseInt(intervalRange?.value, 10) || 22,   // ← добавить
        checkCount: 0
      };

      await chrome.tabs.sendMessage(tab.id, {
        type: "POPUP_START_MONITOR",
        payload: config
      });

      await updateMonitorCard();
      showToast("🚀 Автоперенос запущен!");
    }
  });

  // Telegram Tab Settings
  async function loadTgSettings() {
    const store = await chrome.storage.local.get(["tgToken", "tgChatId"]);
    if (store.tgToken) tgTokenInput.value = store.tgToken;
    if (store.tgChatId) tgChatIdInput.value = store.tgChatId;
  }

  saveTgBtn.addEventListener("click", async () => {
    await chrome.storage.local.set({
      tgToken: tgTokenInput.value.trim(),
      tgChatId: tgChatIdInput.value.trim()
    });
    showToast("Настройки Telegram сохранены!");
  });

  testTgBtn.addEventListener("click", async () => {
    const botToken = tgTokenInput.value.trim();
    const chatId = tgChatIdInput.value.trim();

    if (!botToken || !chatId) {
      tgTestStatus.className = "status-msg error";
      tgTestStatus.textContent = "Заполните Bot Token и Chat ID";
      return;
    }

    tgTestStatus.className = "status-msg";
    tgTestStatus.textContent = "Отправка сообщения...";

    const res = await chrome.runtime.sendMessage({
      type: "SEND_TELEGRAM_TEST",
      payload: { botToken, chatId }
    });

    if (res && res.success) {
      tgTestStatus.className = "status-msg success";
      tgTestStatus.textContent = "✅ Сообщение успешно доставлено в Telegram!";
    } else {
      tgTestStatus.className = "status-msg error";
      tgTestStatus.textContent = `❌ Ошибка: ${res ? res.error : "Не удалось отправить"}`;
    }
  });

  // Sniffer Tab
  async function loadRequests() {
    const data = await chrome.storage.local.get("capturedRequests");
    const list = data.capturedRequests || [];
    requestsCount.textContent = list.length;

    if (list.length === 0) {
      requestsContainer.innerHTML = '<div class="empty-state">Ожидание сетевой активности на emias.info...</div>';
      return;
    }

    requestsContainer.innerHTML = "";
    list.slice().reverse().forEach(req => {
      const item = document.createElement("div");
      item.className = "req-item";
      const methodClass = req.method === "GET" ? "req-get" : (req.method === "POST" ? "req-post" : "req-other");
      const shortUrl = req.url.length > 55 ? req.url.substring(0, 55) + "..." : req.url;
      item.innerHTML = `
        <div class="req-header">
          <span class="req-badge ${methodClass}">${req.method}</span>
          <span class="req-time">${req.timestamp} [${req.status}]</span>
        </div>
        <div class="req-url" title="${req.url}">${shortUrl}</div>
      `;
      requestsContainer.appendChild(item);
    });
  }

  copySummaryBtn.addEventListener("click", async () => {
    const data = await chrome.storage.local.get("capturedRequests");
    const list = data.capturedRequests || [];
    if (list.length === 0) {
      showToast("⚠️ Нет запросов для копирования");
      return;
    }
    const report = {
      total: list.length,
      endpoints: list.map(r => ({ method: r.method, url: r.url, status: r.status, request: r.requestBody, response: r.responseBody }))
    };
    await navigator.clipboard.writeText("```json\n" + JSON.stringify(report, null, 2) + "\n```");
    showToast("📋 Схема скопирована!");
  });

  clearRequestsBtn.addEventListener("click", async () => {
    await chrome.storage.local.set({ capturedRequests: [] });
    await loadRequests();
    showToast("Журнал очищен");
  });

  // Storage changes listener
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== "local") return;
    if (changes.appointments) {
      await loadAppointments();
    }
    if (changes.doctorsInfoMap) {
      const selected = cachedAppointments.find(a => String(a.id) === String(apptSelect.value)) || cachedAppointments[0];
      await renderBranchSelector(selected);
    }
    if (changes.monitoringActive || changes.monitoringConfig) {
      await updateMonitorCard();
    }
    if (changes.monitoringLogs) {
      await loadLogs();
    }
  });

  // Init
  await updateConnection();
  await loadAppointments();
  await initMode();
  await initTargetDateTime();
  await updateMonitorCard();
  await loadTgSettings();
  await loadLogs();
  await loadRequests();

  setInterval(async () => {
    await updateMonitorCard();
    await loadLogs();
  }, 1500);
});
