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
