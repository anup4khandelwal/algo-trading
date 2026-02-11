import { Persistence } from "../persistence/persistence.js";

export interface Alerter {
  notify(
    severity: "info" | "warning" | "critical",
    type: string,
    message: string,
    context?: unknown
  ): Promise<void>;
}

export class NullAlerter implements Alerter {
  async notify(
    _severity: "info" | "warning" | "critical",
    _type: string,
    _message: string,
    _context?: unknown
  ): Promise<void> {}
}

export class TelegramAlerter implements Alerter {
  private lastByType = new Map<string, number>();

  constructor(
    private persistence: Persistence,
    private botToken: string,
    private chatId: string,
    private cooldownMs: number
  ) {}

  async notify(
    severity: "info" | "warning" | "critical",
    type: string,
    message: string,
    context?: unknown
  ): Promise<void> {
    const now = Date.now();
    const key = `${severity}:${type}:${message}`;
    const last = this.lastByType.get(key) ?? 0;
    if (now - last < this.cooldownMs) {
      return;
    }
    this.lastByType.set(key, now);

    const contextJson = context ? JSON.stringify(context) : undefined;
    await this.persistence.insertAlertEvent({
      severity,
      type,
      message,
      contextJson
    });

    const text = [
      `[${severity.toUpperCase()}] ${type}`,
      message,
      contextJson ? `context: ${contextJson}` : ""
    ]
      .filter(Boolean)
      .join("\n");

    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: this.chatId,
        text
      })
    });
  }
}

export function buildAlerter(persistence: Persistence): Alerter {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const cooldownMs = Number(process.env.ALERT_COOLDOWN_MS ?? "60000");
  if (!botToken || !chatId) {
    return new NullAlerter();
  }
  return new TelegramAlerter(persistence, botToken, chatId, cooldownMs);
}
