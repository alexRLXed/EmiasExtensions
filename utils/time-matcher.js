// Time Matcher Utility
// Calculates optimal appointment slots based on target time and acceptable tolerances

function parseDateTime(dtStr) {
  if (!dtStr) return null;
  // Handle ISO strings like "2026-09-08T14:20:00+03:00" or "2026-09-08T14:20:00"
  const d = new Date(dtStr);
  return isNaN(d.getTime()) ? null : d;
}

function formatTime(dt) {
  if (!dt) return "";
  const d = dt instanceof Date ? dt : new Date(dt);
  return d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

function formatDate(dt) {
  if (!dt) return "";
  const d = dt instanceof Date ? dt : new Date(dt);
  return d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function formatDateTimeNice(dt) {
  if (!dt) return "";
  const d = dt instanceof Date ? dt : new Date(dt);
  return `${formatDate(d)} в ${formatTime(d)}`;
}

/**
 * Format Date to YYYY-MM-DD in local time
 * @param {Date} [d] Optional Date instance (defaults to now)
 * @returns {string} Date formatted as YYYY-MM-DD
 */
function formatIsoDate(d = new Date()) {
  const dateObj = d instanceof Date ? d : new Date(d);
  const year = dateObj.getFullYear();
  const month = String(dateObj.getMonth() + 1).padStart(2, "0");
  const day = String(dateObj.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Get today's date formatted as YYYY-MM-DD
 * @returns {string}
 */
function getTodayDateStr() {
  return formatIsoDate(new Date());
}

/**
 * Get date string offset by specified number of days from today
 * @param {number} offsetDays Positive or negative day offset
 * @returns {string} YYYY-MM-DD
 */
function getDateOffsetStr(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return formatIsoDate(d);
}

/**
 * Extract and normalize clinic branches from an appointment and its doctorsInfo list
 * @param {Object} [appointment] Active appointment object
 * @param {Array} [doctorsInfoList] Discovered doctorsInfo array
 * @returns {Array<{ lpuId: string, name: string, address: string, isCurrent: boolean }>}
 */
function extractBranches(appointment, doctorsInfoList) {
  const branchesMap = new Map();

  // 1. Current appointment branch
  if (appointment && appointment.lpuId) {
    const curLpuId = String(appointment.lpuId);
    branchesMap.set(curLpuId, {
      lpuId: curLpuId,
      name: appointment.nameLpu || `Филиал #${curLpuId}`,
      address: appointment.lpuAddress || appointment.address || "",
      isCurrent: true
    });
  }

  // 2. Discovered branches from doctorsInfoList
  if (Array.isArray(doctorsInfoList)) {
    for (const doc of doctorsInfoList) {
      if (!doc) continue;
      const lpuId = String(doc.lpuId || (doc.availableResources && doc.availableResources[0] && doc.availableResources[0].lpuId) || "");
      if (!lpuId) continue;
      const existing = branchesMap.get(lpuId) || {};
      const isCur = existing.isCurrent || Boolean(appointment && String(appointment.lpuId) === lpuId);
      branchesMap.set(lpuId, {
        lpuId,
        name: doc.lpuShortName || existing.name || `Филиал #${lpuId}`,
        address: doc.defaultAddress || existing.address || "",
        isCurrent: isCur
      });
    }
  }

  return Array.from(branchesMap.values());
}

/**
 * Extract flat list of slots from EMIAS scheduleOfDay response
 * @param {Array} scheduleOfDay
 * @param {Object} resourceInfo
 * @returns {Array} Array of normalized slot objects
 */
function extractSlotsFromSchedule(scheduleOfDay, resourceInfo = {}) {
  const result = [];
  if (!Array.isArray(scheduleOfDay)) return result;

  for (const day of scheduleOfDay) {
    const dateStr = day.date; // "2026-09-08"
    if (!Array.isArray(day.scheduleBySlot)) continue;

    for (const slotGroup of day.scheduleBySlot) {
      const cabinet = slotGroup.cabinetNumber || "";
      const complexResourceId = slotGroup.complexResourceId || resourceInfo.complexResourceId;
      const slots = Array.isArray(slotGroup.slot) ? slotGroup.slot : [];

      for (const s of slots) {
        if (!s) continue;
        const startTimeStr = s.startTime || s.start || (dateStr && s.time ? `${dateStr}T${s.time}` : null);
        const endTimeStr = s.endTime || s.end || null;

        if (!startTimeStr) continue;

        const startTime = parseDateTime(startTimeStr);
        if (!startTime) continue;

        const endTime = endTimeStr ? parseDateTime(endTimeStr) : new Date(startTime.getTime() + 15 * 60000);

        result.push({
          startTime: startTimeStr,
          endTime: endTimeStr || endTime.toISOString(),
          startDate: startTime,
          endDate: endTime,
          dateStr: dateStr,
          cabinet: cabinet,
          complexResourceId: complexResourceId,
          availableResourceId: resourceInfo.availableResourceId,
          lpuId: resourceInfo.lpuId,
          lpuName: resourceInfo.lpuName || resourceInfo.lpuShortName || "",
          doctorName: resourceInfo.doctorName || resourceInfo.name || ""
        });
      }
    }
  }

  return result;
}

/**
 * Filter and score slots by distance to target datetime
 * @param {Array} slots Normalized slots
 * @param {Date|string} targetDateTime Target date and time
 * @param {Object} options { windowMinutes, onlyTargetDate, currentAppointmentTime }
 * @returns {Array} Sorted list of matching slots with delta info
 */
function findBestSlots(slots, targetDateTime, options = {}) {
  const target = targetDateTime instanceof Date ? targetDateTime : new Date(targetDateTime);
  if (isNaN(target.getTime())) return [];

  const targetTimeMs = target.getTime();
  const windowMinutes = options.windowMinutes !== undefined ? options.windowMinutes : 60; // default ±60 min
  const onlyTargetDate = options.onlyTargetDate !== undefined ? options.onlyTargetDate : true;
  const isAnyTime = options.windowMinutes === "any" || windowMinutes === null;

  const targetDateStr = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}-${String(target.getDate()).padStart(2, '0')}`;

  const matched = [];

  for (const slot of slots) {
    const slotTimeMs = slot.startDate.getTime();
    const diffMs = slotTimeMs - targetTimeMs;
    const diffMinutes = Math.round(diffMs / 60000);
    const absDiffMinutes = Math.abs(diffMinutes);

    // Filter by target date if required
    if (onlyTargetDate) {
      const slotDateStr = slot.dateStr || `${slot.startDate.getFullYear()}-${String(slot.startDate.getMonth() + 1).padStart(2, '0')}-${String(slot.startDate.getDate()).padStart(2, '0')}`;
      if (slotDateStr !== targetDateStr) {
        continue;
      }
    }

    // Filter by tolerance window
    if (!isAnyTime && typeof windowMinutes === "number" && windowMinutes > 0) {
      if (absDiffMinutes > windowMinutes) {
        continue;
      }
    }

    // Check if slot is in the past
    if (slotTimeMs < Date.now() + 5 * 60000) {
      continue; // Skip slots starting in less than 5 minutes
    }

    matched.push({
      ...slot,
      diffMinutes: diffMinutes,
      absDiffMinutes: absDiffMinutes,
      formattedTime: formatTime(slot.startDate),
      formattedDate: formatDate(slot.startDate),
      formattedFull: formatDateTimeNice(slot.startDate)
    });
  }

  // Sort by smallest distance to target time
  matched.sort((a, b) => a.absDiffMinutes - b.absDiffMinutes);

  return matched;
}

// Export for extension modules
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    parseDateTime,
    formatTime,
    formatDate,
    formatDateTimeNice,
    formatIsoDate,
    getTodayDateStr,
    getDateOffsetStr,
    extractBranches,
    extractSlotsFromSchedule,
    findBestSlots
  };
}
