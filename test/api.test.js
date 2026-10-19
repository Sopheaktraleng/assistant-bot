import { describe, it, expect } from "vitest";
import { authenticateApiRequest } from "../src/handlers/api.js";

describe("API Authentication Handler", () => {
    it("should allow localhost dev bypass when user_id is provided", async () => {
        const req = new Request("http://localhost:8787/api/data?user_id=12345", {
            headers: { host: "localhost:8787" }
        });
        const env = { TELEGRAM_BOT_TOKEN: "mock_token" };
        const auth = await authenticateApiRequest(req, env);
        expect(auth.userId).toBe("12345");
        expect(auth.error).toBeUndefined();
    });

    it("should reject localhost request if user_id is missing", async () => {
        const req = new Request("http://localhost:8787/api/data", {
            headers: { host: "localhost:8787" }
        });
        const env = { TELEGRAM_BOT_TOKEN: "mock_token" };
        const auth = await authenticateApiRequest(req, env);
        expect(auth.error).toBe("Missing user_id parameter");
        expect(auth.status).toBe(400);
    });

    it("should reject non-localhost request without Telegram session", async () => {
        const req = new Request("https://cashflow.workers.dev/api/data?user_id=12345", {
            headers: { host: "cashflow.workers.dev" }
        });
        const env = { TELEGRAM_BOT_TOKEN: "mock_token" };
        const auth = await authenticateApiRequest(req, env);
        expect(auth.error).toBe("Unauthorized: Telegram WebApp authentication required");
        expect(auth.status).toBe(401);
    });

    it("should reject request when Telegram Init Data hash is invalid", async () => {
        const fakeInitData = "query_id=test&user=%7B%22id%22%3A12345%7D&auth_date=1700000000&hash=badhash";
        const req = new Request("https://cashflow.workers.dev/api/data", {
            headers: {
                host: "cashflow.workers.dev",
                "X-Telegram-Init-Data": fakeInitData
            }
        });
        const env = { TELEGRAM_BOT_TOKEN: "real_token" };
        const auth = await authenticateApiRequest(req, env);
        expect(auth.error).toBe("Invalid or expired Telegram WebApp session");
        expect(auth.status).toBe(401);
    });
});
