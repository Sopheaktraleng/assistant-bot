export function timingSafeEqual(a, b) {
    if (typeof a !== "string" || typeof b !== "string") return false;
    if (a.length !== b.length) return false;
    let mismatch = 0;
    for (let i = 0; i < a.length; i++) {
        mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return mismatch === 0;
}

export function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const len = bytes.byteLength;
    const chunkSize = 8192;
    for (let i = 0; i < len; i += chunkSize) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
}

export async function validateTelegramInitData(initDataString, botToken) {
    if (!initDataString || !botToken) return null;
    try {
        const urlParams = new URLSearchParams(initDataString);
        const hash = urlParams.get("hash");
        if (!hash) return null;
        urlParams.delete("hash");
        urlParams.sort();

        const dataCheckString = Array.from(urlParams.entries())
            .map(([k, v]) => `${k}=${v}`)
            .join("\n");

        const encoder = new TextEncoder();
        const keyMaterial = await crypto.subtle.importKey(
            "raw",
            encoder.encode("WebAppData"),
            { name: "HMAC", hash: "SHA-256" },
            false,
            ["sign"]
        );
        const secretKey = await crypto.subtle.sign(
            "HMAC",
            keyMaterial,
            encoder.encode(botToken)
        );

        const hmacKey = await crypto.subtle.importKey(
            "raw",
            secretKey,
            { name: "HMAC", hash: "SHA-256" },
            false,
            ["sign"]
        );
        const signatureBytes = await crypto.subtle.sign(
            "HMAC",
            hmacKey,
            encoder.encode(dataCheckString)
        );

        const calculatedHash = Array.from(new Uint8Array(signatureBytes))
            .map(b => b.toString(16).padStart(2, "0"))
            .join("");

        if (!timingSafeEqual(calculatedHash.toLowerCase(), hash.toLowerCase())) {
            return null;
        }

        const authDate = parseInt(urlParams.get("auth_date") || "0", 10);
        const nowSec = Math.floor(Date.now() / 1000);
        // Valid for up to 7 days
        if (nowSec - authDate > 86400 * 7) {
            return null;
        }

        let user = null;
        const userRaw = urlParams.get("user");
        if (userRaw) {
            try {
                user = JSON.parse(userRaw);
            } catch (_) {}
        }

        const userId = user?.id ? String(user.id) : urlParams.get("user_id");
        return {
            valid: true,
            user,
            userId
        };
    } catch (e) {
        console.error("InitData validation error:", e);
        return null;
    }
}
