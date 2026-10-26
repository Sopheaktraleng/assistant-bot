import { TIME_ZONE } from "../config/constants.js";

export function today() {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: TIME_ZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(new Date());
}

export function monthPrefix() {
    return today().slice(0, 7);
}

export function monthLabel() {
    return new Intl.DateTimeFormat("en-US", {
        timeZone: TIME_ZONE,
        year: "numeric",
        month: "long",
    }).format(new Date());
}

export function currentTime() {
    return new Intl.DateTimeFormat("en-GB", {
        timeZone: TIME_ZONE,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    }).format(new Date());
}

export function lastMonthPrefix() {
    const now = new Date();
    const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    return `${y}-${m}`;
}

export function lastMonthLabel() {
    const now = new Date();
    const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return new Intl.DateTimeFormat("en-US", {
        timeZone: TIME_ZONE,
        year: "numeric",
        month: "long",
    }).format(d);
}

export function dateDaysAgo(days) {
    const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: TIME_ZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(d);
}

export function getPreviousWorkdayDate() {
    const now = new Date();
    const weekdayStr = new Intl.DateTimeFormat("en-US", {
        timeZone: TIME_ZONE,
        weekday: "short"
    }).format(now); // "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"

    if (weekdayStr === "Mon") {
        return dateDaysAgo(3); // Friday
    } else if (weekdayStr === "Sun") {
        return dateDaysAgo(2); // Friday
    } else {
        return dateDaysAgo(1); // Yesterday
    }
}

/**
 * Normalizes any human-entered or AI-generated reminder time into standard 24-hour HH:mm.
 * Supports:
 *   - 24-hour ("15:30", "9:00", "09:00")
 *   - 12-hour AM/PM ("3:30 PM", "3:30pm", "3pm", "9am", "12:00 am")
 *   - Relative ("in 30 mins", "in 1 hour", "45m")
 */
export function normalizeReminderTime(timeStr) {
    if (!timeStr || typeof timeStr !== "string") return null;
    const clean = timeStr.trim();

    // 1. 24h format e.g. "15:30", "09:00", "9:30"
    const m24 = clean.match(/^([0-1]?[0-9]|2[0-3]):([0-5][0-9])$/);
    if (m24) {
        return `${m24[1].padStart(2, "0")}:${m24[2]}`;
    }

    // 2. 12h format e.g. "3:30 PM", "3:30pm", "3pm", "03:30 PM", "11:45 am"
    const m12 = clean.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
    if (m12) {
        let hour = parseInt(m12[1], 10);
        const minute = m12[2] ? parseInt(m12[2], 10) : 0;
        const ampm = m12[3].toLowerCase();
        if (ampm === "pm" && hour < 12) hour += 12;
        if (ampm === "am" && hour === 12) hour = 0;
        return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    }

    // 3. Relative format e.g. "in 30 mins", "in 30m", "in 1 hour", "45 mins"
    const mRel = clean.match(/^(?:in\s+)?(\d+)\s*(m|min|mins|minutes|h|hr|hrs|hours)$/i);
    if (mRel) {
        const num = parseInt(mRel[1], 10);
        const unit = mRel[2].toLowerCase();
        const mins = unit.startsWith("h") ? num * 60 : num;
        const now = new Date();
        const target = new Date(now.getTime() + mins * 60 * 1000);
        return new Intl.DateTimeFormat("en-GB", {
            timeZone: TIME_ZONE,
            hour: "2-digit",
            minute: "2-digit",
            hour12: false
        }).format(target);
    }

    return null;
}
