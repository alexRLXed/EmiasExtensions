// EMIAS Network Interceptor & API Bridge (MAIN execution world)
(() => {
  if (window.__EMIAS_INTERCEPTOR_INITIALIZED__) return;
  window.__EMIAS_INTERCEPTOR_INITIALIZED__ = true;
  window.__EMIAS_CAPTURED_API__ = window.__EMIAS_CAPTURED_API__ || [];
  window.__EMIAS_PATIENT__ = window.__EMIAS_PATIENT__ || null;
  window.__EMIAS_EI_TOKEN__ = window.__EMIAS_EI_TOKEN__ || null;
  window.__EMIAS_DEFAULT_HEADERS__ = window.__EMIAS_DEFAULT_HEADERS__ || {};

  console.log("%c[EMIAS Assistant]%c Сетевой мост и сниффер активированы", "background:#00897B;color:white;padding:2px 6px;border-radius:3px;font-weight:bold;", "color:#00897B;font-weight:bold;");

  const EMIAS_ENDPOINTS = {
    SCHEDULE: "/api-eip/v4/saOrchestrator/getAvailableResourceScheduleInfo",
    SHIFT: "/api-eip/v4/saOrchestrator/shiftAppointment",
    APPOINTMENTS: "/api-eip/v10/saOrchestrator/getAppointmentReceptionsByPatient",
    DOCTORS_INFO_LI: "/api-eip/v4/saOrchestrator/getDoctorsInfoForLI",
    DOCTORS_INFO: "/api-eip/v4/saOrchestrator/getDoctorsInfo"
  };

  const originalFetch = window.fetch;
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  const origSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

  // Scan localStorage and sessionStorage for patient context as instant fallback
  function scanStorageForPatient() {
    try {
      const storages = [window.localStorage, window.sessionStorage];
      for (const storage of storages) {
        if (!storage) continue;
        for (let i = 0; i < storage.length; i++) {
          const key = storage.key(i);
          const val = storage.getItem(key);
          if (!val || typeof val !== "string") continue;

          // Match birthDate or birthday or similar
          const bMatch = val.match(/"(?:birthDate|birthday|birth_date|dateOfBirth)"\s*:\s*"([^"]+)"/i);
          // Match omsNumber or oms
          const oMatch = val.match(/"(?:omsNumber|oms|policyNumber)"\s*:\s*"([^"]+)"/i);

          if (bMatch && oMatch && !bMatch[1].includes("REDACTED")) {
            window.__EMIAS_PATIENT__ = {
              birthDate: bMatch[1],
              omsNumber: oMatch[1]
            };
            window.postMessage({
              source: "EMIAS_INTERCEPTOR",
              type: "PATIENT_CONTEXT_SYNC",
              payload: window.__EMIAS_PATIENT__
            }, "*");
            console.log("%c[EMIAS Assistant]%c Пациент синхронизирован из хранилища браузера:", "background:#00897B;color:white;padding:2px 4px;font-weight:bold;", "color:#00897B;", window.__EMIAS_PATIENT__.omsNumber);
            return window.__EMIAS_PATIENT__;
          }
        }
      }
    } catch (e) {}
    return null;
  }
  scanStorageForPatient();

  // Find EI-Token across multiple sources (Memory, Next.js data, Cookies, Web Storage)
  function findEiToken() {
    if (window.__EMIAS_EI_TOKEN__) return window.__EMIAS_EI_TOKEN__;

    // 1. Check window.__NEXT_DATA__
    try {
      if (window.__NEXT_DATA__) {
        const str = JSON.stringify(window.__NEXT_DATA__);
        const m = str.match(/"(?:ei-token|ei_token|eitoken|eiToken|token)"\s*:\s*"([^"]+)"/i);
        if (m && m[1] && m[1].length > 10 && !m[1].includes("REDACTED")) {
          window.__EMIAS_EI_TOKEN__ = m[1];
          console.log("%c[EMIAS Assistant]%c EI-Token найден в __NEXT_DATA__", "background:#00897B;color:white;padding:2px 4px;font-weight:bold;", "color:#00897B;");
          window.postMessage({ source: "EMIAS_INTERCEPTOR", type: "EI_TOKEN_SYNC", payload: { eiToken: m[1] } }, "*");
          return window.__EMIAS_EI_TOKEN__;
        }
      }
    } catch (e) {}

    // 2. Check document.cookie
    try {
      const cookies = (document.cookie || "").split(";");
      for (const cookie of cookies) {
        const parts = cookie.trim().split("=");
        const name = parts[0].trim();
        const val = parts.slice(1).join("=").trim();
        if (/^(ei-?token|ei_token|eitoken|auth_token|token)$/i.test(name)) {
          if (val && val.length > 5) {
            window.__EMIAS_EI_TOKEN__ = decodeURIComponent(val);
            console.log("%c[EMIAS Assistant]%c EI-Token найден в Cookie (" + name + ")", "background:#00897B;color:white;padding:2px 4px;font-weight:bold;", "color:#00897B;");
            window.postMessage({ source: "EMIAS_INTERCEPTOR", type: "EI_TOKEN_SYNC", payload: { eiToken: window.__EMIAS_EI_TOKEN__ } }, "*");
            return window.__EMIAS_EI_TOKEN__;
          }
        }
      }
    } catch (e) {}

    // 3. Check localStorage & sessionStorage
    try {
      const storages = [window.localStorage, window.sessionStorage];
      for (const storage of storages) {
        if (!storage) continue;
        for (let i = 0; i < storage.length; i++) {
          const key = storage.key(i);
          if (!key) continue;

          if (/^(ei-?token|ei_token|eitoken|auth_token|token)$/i.test(key)) {
            let val = storage.getItem(key);
            if (val) {
              try {
                const parsed = JSON.parse(val);
                if (typeof parsed === "string") val = parsed;
                else if (parsed && (parsed.token || parsed.value || parsed.eiToken)) {
                  val = parsed.token || parsed.value || parsed.eiToken;
                }
              } catch (e) {}
              val = String(val).replace(/^["']|["']$/g, '').trim();
              if (val.length > 5 && !val.includes("REDACTED")) {
                window.__EMIAS_EI_TOKEN__ = val;
                console.log("%c[EMIAS Assistant]%c EI-Token найден в хранилище (" + key + ")", "background:#00897B;color:white;padding:2px 4px;font-weight:bold;", "color:#00897B;");
                window.postMessage({ source: "EMIAS_INTERCEPTOR", type: "EI_TOKEN_SYNC", payload: { eiToken: val } }, "*");
                return window.__EMIAS_EI_TOKEN__;
              }
            }
          }

          const rawVal = storage.getItem(key);
          if (rawVal && typeof rawVal === "string") {
            const m = rawVal.match(/"(?:ei-token|ei_token|eitoken|eiToken|token)"\s*:\s*"([^"]+)"/i);
            if (m && m[1] && m[1].length > 10 && !m[1].includes("REDACTED")) {
              window.__EMIAS_EI_TOKEN__ = m[1];
              console.log("%c[EMIAS Assistant]%c EI-Token извлечён из объекта хранилища (" + key + ")", "background:#00897B;color:white;padding:2px 4px;font-weight:bold;", "color:#00897B;");
              window.postMessage({ source: "EMIAS_INTERCEPTOR", type: "EI_TOKEN_SYNC", payload: { eiToken: m[1] } }, "*");
              return window.__EMIAS_EI_TOKEN__;
            }
          }
        }
      }
    } catch (e) {}

    return null;
  }
  findEiToken();

  function extractHeaderValue(headers, targetName) {
    if (!headers) return null;
    const lower = targetName.toLowerCase();

    if (typeof headers.get === "function") {
      return headers.get(targetName) || headers.get(lower);
    }
    if (typeof headers.forEach === "function") {
      let found = null;
      headers.forEach((val, key) => {
        if (key && key.toLowerCase() === lower) found = val;
      });
      if (found) return found;
    }
    if (typeof headers === "object") {
      for (const [k, v] of Object.entries(headers)) {
        if (k && k.toLowerCase() === lower) return v;
      }
    }
    return null;
  }

  function captureHeaders(headers) {
    if (!headers) return;
    try {
      const token = extractHeaderValue(headers, "EI-Token");
      if (token && typeof token === "string" && token.length > 5 && !token.includes("REDACTED")) {
        if (window.__EMIAS_EI_TOKEN__ !== token) {
          window.__EMIAS_EI_TOKEN__ = token;
          console.log("%c[EMIAS Assistant]%c Захвачен актуальный EI-Token из сетевого заголовка", "background:#00897B;color:white;padding:2px 4px;font-weight:bold;", "color:#00897B;");
          window.postMessage({
            source: "EMIAS_INTERCEPTOR",
            type: "EI_TOKEN_SYNC",
            payload: { eiToken: token }
          }, "*");
        }
      }

      if (typeof headers.forEach === "function") {
        headers.forEach((v, k) => {
          const kl = String(k).toLowerCase();
          if (!["host", "content-length", "content-type"].includes(kl)) {
            window.__EMIAS_DEFAULT_HEADERS__[k] = v;
          }
        });
      } else if (typeof headers === "object") {
        for (const [k, v] of Object.entries(headers)) {
          const kl = String(k).toLowerCase();
          if (!["host", "content-length", "content-type"].includes(kl)) {
            window.__EMIAS_DEFAULT_HEADERS__[k] = v;
          }
        }
      }
    } catch (e) {}
  }

  function buildRequestHeaders(customHeaders = {}) {
    const token = window.__EMIAS_EI_TOKEN__ || findEiToken();
    const headers = {
      "Content-Type": "application/json",
      "Accept": "application/json",
      ...(window.__EMIAS_DEFAULT_HEADERS__ || {}),
      ...customHeaders
    };
    if (token) {
      headers["EI-Token"] = token;
    }
    return headers;
  }

  // Also scan on DOM ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      scanStorageForPatient();
      findEiToken();
    });
  }

  function sanitizeData(data, depth = 0) {
    if (depth > 6) return "...";
    if (data === null || data === undefined) return data;
    if (typeof data === "number" || typeof data === "boolean") return data;
    if (typeof data === "string") {
      if (data.length > 80 && !data.includes(" ") && !data.includes("/")) {
        return data.substring(0, 10) + "...[TRUNCATED_TOKEN]";
      }
      return data;
    }
    if (Array.isArray(data)) {
      if (data.length > 5) {
        const sample = data.slice(0, 3).map(item => sanitizeData(item, depth + 1));
        return { _type: "Array", totalCount: data.length, sampleItems: sample };
      }
      return data.map(item => sanitizeData(item, depth + 1));
    }
    if (typeof data === "object") {
      const sanitized = {};
      for (const [key, value] of Object.entries(data)) {
        if (/^(fio|fullName|surName|firstName|patronymic|birthDate|oms|polis|phone|email|snils|passport)$/i.test(key)) {
          sanitized[key] = "[REDACTED_FOR_PRIVACY]";
        } else {
          sanitized[key] = sanitizeData(value, depth + 1);
        }
      }
      return sanitized;
    }
    return data;
  }

  function shouldIntercept(url) {
    if (!url) return false;
    const lower = String(url).toLowerCase();
    return (
      lower.includes("/api/") ||
      lower.includes("/api-eip/") ||
      lower.includes("appointment") ||
      lower.includes("schedule") ||
      lower.includes("specialit") ||
      lower.includes("doctor") ||
      lower.includes("slot") ||
      lower.includes("shift") ||
      lower.includes("resource") ||
      lower.includes("einfo")
    );
  }

  function handleSpecializedApi(url, reqBody, resData) {
    // Whenever ANY /api-eip/ call has omsNumber and birthDate, save the REAL patientContext!
    if (reqBody && reqBody.omsNumber && reqBody.birthDate) {
      const bDate = String(reqBody.birthDate);
      const oms = String(reqBody.omsNumber);
      if (!bDate.includes("REDACTED")) {
        window.__EMIAS_PATIENT__ = {
          omsNumber: oms,
          birthDate: bDate,
          patientId: reqBody.patientId ? String(reqBody.patientId) : null
        };
        window.postMessage({
          source: "EMIAS_INTERCEPTOR",
          type: "PATIENT_CONTEXT_SYNC",
          payload: window.__EMIAS_PATIENT__
        }, "*");
      }
    }

    if (!resData || !resData.payload) return;

    if (url.includes("getAppointmentReceptionsByPatient")) {
      const appointments = resData.payload.appointment || [];
      window.postMessage({
        source: "EMIAS_INTERCEPTOR",
        type: "APPOINTMENTS_SYNC",
        payload: { appointments }
      }, "*");
    }

    if (url.includes("getDoctorsInfoForLI") || url.includes("getDoctorsInfo")) {
      const doctorsInfo = resData.payload.doctorsInfo || [];
      const appointmentId = reqBody?.appointmentId || null;
      window.postMessage({
        source: "EMIAS_INTERCEPTOR",
        type: "DOCTORS_INFO_SYNC",
        payload: { appointmentId, doctorsInfo }
      }, "*");
    }

    if (url.includes("getAvailableResourceScheduleInfo")) {
      console.log("%c[EMIAS Assistant] Зафиксирован реальный вызов расписания ЕМИАС:%c", "color:#0284c7;font-weight:bold;", "", {
        request: reqBody,
        response: resData
      });
    }
  }

  function broadcastCaptured(apiRecord) {
    window.__EMIAS_CAPTURED_API__.push(apiRecord);
    if (window.__EMIAS_CAPTURED_API__.length > 100) {
      window.__EMIAS_CAPTURED_API__.shift();
    }

    window.postMessage({
      source: "EMIAS_INTERCEPTOR",
      type: "API_CAPTURED",
      payload: apiRecord
    }, "*");
  }

  // Intercept Fetch
  window.fetch = async function(...args) {
    const resource = args[0];
    const init = args[1] || {};
    const url = typeof resource === "string" ? resource : (resource ? resource.url : "");
    const method = (init.method || (resource && resource.method) || "GET").toUpperCase();

    if (init.headers) captureHeaders(init.headers);
    if (resource && resource.headers) captureHeaders(resource.headers);

    let requestBody = null;
    if (init.body) {
      try {
        requestBody = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
      } catch (e) {
        requestBody = init.body;
      }
    }

    const response = await originalFetch.apply(this, args);

    if (shouldIntercept(url)) {
      try {
        const clone = response.clone();
        clone.text().then(text => {
          let responseJson = null;
          try {
            responseJson = JSON.parse(text);
            handleSpecializedApi(url, requestBody, responseJson);
          } catch (e) {
            responseJson = text.substring(0, 300);
          }

          const apiRecord = {
            id: "req_" + Date.now() + "_" + Math.random().toString(36).substring(2, 6),
            timestamp: new Date().toLocaleTimeString(),
            method: method,
            url: url,
            status: response.status,
            requestBody: sanitizeData(requestBody),
            responseBody: sanitizeData(responseJson)
          };

          broadcastCaptured(apiRecord);
        }).catch(err => {});
      } catch (err) {}
    }

    return response;
  };

  // Intercept XHR
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this._interceptedUrl = url;
    this._interceptedMethod = method ? method.toUpperCase() : "GET";
    return origOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.setRequestHeader = function(header, value) {
    try {
      if (header) {
        const lower = header.toLowerCase();
        if (lower === "ei-token" && value && !value.includes("REDACTED")) {
          if (window.__EMIAS_EI_TOKEN__ !== value) {
            window.__EMIAS_EI_TOKEN__ = value;
            console.log("%c[EMIAS Assistant]%c Захвачен EI-Token из XHR", "background:#00897B;color:white;padding:2px 4px;font-weight:bold;", "color:#00897B;");
            window.postMessage({
              source: "EMIAS_INTERCEPTOR",
              type: "EI_TOKEN_SYNC",
              payload: { eiToken: value }
            }, "*");
          }
        }
        if (!["host", "content-length", "content-type"].includes(lower)) {
          window.__EMIAS_DEFAULT_HEADERS__[header] = value;
        }
      }
    } catch (e) {}
    return origSetRequestHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function(body) {
    if (shouldIntercept(this._interceptedUrl)) {
      const url = this._interceptedUrl;
      const method = this._interceptedMethod;
      let requestBody = null;
      if (body) {
        try {
          requestBody = typeof body === "string" ? JSON.parse(body) : body;
        } catch (e) {
          requestBody = body;
        }
      }

      this.addEventListener("load", function() {
        let responseJson = null;
        try {
          responseJson = JSON.parse(this.responseText);
          handleSpecializedApi(url, requestBody, responseJson);
        } catch (e) {
          responseJson = (this.responseText || "").substring(0, 300);
        }

        const apiRecord = {
          id: "req_" + Date.now() + "_" + Math.random().toString(36).substring(2, 6),
          timestamp: new Date().toLocaleTimeString(),
          method: method,
          url: url,
          status: this.status,
          requestBody: sanitizeData(requestBody),
          responseBody: sanitizeData(responseJson)
        };

        broadcastCaptured(apiRecord);
      });
    }

    return origSend.call(this, body);
  };

  // -------------------------------------------------------------
  // Command execution bridge helpers
  // -------------------------------------------------------------
  function preparePatientPayload(payload) {
    if (!window.__EMIAS_PATIENT__) {
      scanStorageForPatient();
    }
    if (payload.eiToken && !window.__EMIAS_EI_TOKEN__) {
      window.__EMIAS_EI_TOKEN__ = payload.eiToken;
    }
    const patient = window.__EMIAS_PATIENT__ || {};
    const birthDate = (!payload.birthDate || payload.birthDate === "undefined" || payload.birthDate.includes("REDACTED"))
      ? patient.birthDate
      : payload.birthDate;
    const omsNumber = (!payload.omsNumber || payload.omsNumber === "undefined" || payload.omsNumber.includes("REDACTED"))
      ? patient.omsNumber
      : payload.omsNumber;

    const requestPayload = { ...payload, birthDate, omsNumber };
    delete requestPayload.eiToken;
    return requestPayload;
  }

  function sendBridgeResponse(action, reqId, status, data = null, error = null) {
    window.postMessage({
      source: "EMIAS_INTERCEPTOR",
      action,
      reqId,
      status,
      data,
      error
    }, "*");
  }

  // -------------------------------------------------------------
  // Command execution bridge listener
  // -------------------------------------------------------------
  window.addEventListener("message", async (event) => {
    if (event.source !== window || !event.data || event.data.source !== "EMIAS_EXTENSION_CONTENT") {
      return;
    }

    const { action, reqId, payload } = event.data;

    try {
      if (action === "CMD_GET_SCHEDULE") {
        const requestPayload = preparePatientPayload(payload);
        const reqHeaders = buildRequestHeaders();
        if (!reqHeaders["EI-Token"]) {
          console.warn("%c[EMIAS Assistant]%c Внимание: заголовок 'EI-Token' пока не перехвачен! Запрос расписания может завершиться с ошибкой 400. Обновите страницу ЕМИАС или перейдите в раздел записей.", "background:#f59e0b;color:white;font-weight:bold;padding:2px 4px;", "color:#f59e0b;");
        }

        const res = await originalFetch(EMIAS_ENDPOINTS.SCHEDULE, {
          method: "POST",
          credentials: "include",
          headers: reqHeaders,
          body: JSON.stringify(requestPayload)
        });

        let data = null;
        try { data = await res.json(); } catch (e) { data = await res.text(); }

        if (!res.ok) {
          const errStr = typeof data === "object" ? JSON.stringify(data) : String(data);
          const payloadStr = JSON.stringify(requestPayload);
          console.error("%c[EMIAS 400 REASON]:%c " + errStr, "background:#dc2626;color:white;font-weight:bold;padding:2px 4px;", "color:#dc2626;font-weight:bold;");
          console.error("%c[EMIAS SENT PAYLOAD]:%c " + payloadStr, "background:#475569;color:white;padding:2px 4px;", "color:#334155;");
        }

        const errMsg = res.ok ? null : (typeof data === "object" ? JSON.stringify(data) : (data || `Ошибка ${res.status}`));
        sendBridgeResponse("RES_GET_SCHEDULE", reqId, res.status, res.ok ? data : null, errMsg);
      } else if (action === "CMD_SHIFT_APPOINTMENT") {
        console.log("%c[EMIAS Assistant]%c Выполняется перенос записи...", "background:#16a34a;color:white;padding:2px 6px;font-weight:bold;", "color:#16a34a;font-weight:bold;", payload);
        const requestPayload = preparePatientPayload(payload);
        const reqHeaders = buildRequestHeaders();

        const res = await originalFetch(EMIAS_ENDPOINTS.SHIFT, {
          method: "POST",
          credentials: "include",
          headers: reqHeaders,
          body: JSON.stringify(requestPayload)
        });

        let data = null;
        try { data = await res.json(); } catch (e) { data = await res.text(); }

        if (!res.ok) {
          console.error("%c[EMIAS SHIFT FAILED]:%c", "background:#dc2626;color:white;font-weight:bold;padding:2px 4px;", "color:#dc2626;font-weight:bold;", data, requestPayload);
        }

        const errMsg = res.ok ? null : (typeof data === "object" ? JSON.stringify(data) : (data || `Ошибка ${res.status}`));
        sendBridgeResponse("RES_SHIFT_APPOINTMENT", reqId, res.status, res.ok ? data : null, errMsg);
      } else if (action === "CMD_REFRESH_APPOINTMENTS") {
        const requestPayload = preparePatientPayload(payload);
        const reqHeaders = buildRequestHeaders();

        const res = await originalFetch(EMIAS_ENDPOINTS.APPOINTMENTS, {
          method: "POST",
          credentials: "include",
          headers: reqHeaders,
          body: JSON.stringify(requestPayload)
        });
        const data = await res.json();
        sendBridgeResponse("RES_REFRESH_APPOINTMENTS", reqId, res.status, data);
      } else if (action === "CMD_GET_DOCTORS_INFO") {
        const prepared = preparePatientPayload(payload);
        const now = new Date();
        const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        const nextWeek = new Date(now.getTime() + 7 * 86400000);
        const nextWeekStr = `${nextWeek.getFullYear()}-${String(nextWeek.getMonth() + 1).padStart(2, '0')}-${String(nextWeek.getDate()).padStart(2, '0')}`;

        const isBM = payload.isBM !== false;
        const endpoint = isBM ? EMIAS_ENDPOINTS.DOCTORS_INFO_LI : EMIAS_ENDPOINTS.DOCTORS_INFO;

        const requestPayload = isBM ? {
          appointmentId: Number(payload.appointmentId),
          assignment: {
            moId: Number(payload.lpuId || 10000367),
            period: {
              dateFrom: payload.dateFrom || todayStr,
              dateTo: payload.dateTo || nextWeekStr
            },
            samplingTypeId: Number(payload.samplingTypeId || 1)
          },
          birthDate: prepared.birthDate,
          omsNumber: prepared.omsNumber
        } : {
          appointmentId: Number(payload.appointmentId),
          birthDate: prepared.birthDate,
          omsNumber: prepared.omsNumber
        };

        const reqHeaders = buildRequestHeaders();
        const res = await originalFetch(endpoint, {
          method: "POST",
          credentials: "include",
          headers: reqHeaders,
          body: JSON.stringify(requestPayload)
        });
        const data = await res.json();
        if (data && data.payload && data.payload.doctorsInfo) {
          window.postMessage({
            source: "EMIAS_INTERCEPTOR",
            type: "DOCTORS_INFO_SYNC",
            payload: { appointmentId: payload.appointmentId, doctorsInfo: data.payload.doctorsInfo }
          }, "*");
        }
        sendBridgeResponse("RES_GET_DOCTORS_INFO", reqId, res.status, data);
      }
    } catch (err) {
      console.error("[EMIAS Interceptor Bridge Error]", err);
      sendBridgeResponse(action ? action.replace("CMD_", "RES_") : "RES_ERROR", reqId, 500, null, err.message);
    }
  });
})();
