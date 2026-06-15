import type { ISdk } from "iii-sdk";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import type { DeliveryRecord, InboxItem } from "../types.js";
import { getLarkConfig, isLarkDeliveryEnabled } from "../config.js";
import { safeAudit } from "./audit.js";
import { deliverViaLark as defaultDeliver, type LarkDeliverFn } from "./lark-adapter.js";

// Line D — delivery primitive. Fired fire-and-forget after an inbox item is
// persisted (STEP-D3 wires the trigger). Pure backend, default OFF:
//   - config gate: if delivery disabled or no lark config → record `skipped`,
//     never call the adapter. (Inbox behaves exactly as Line C.)
//   - dedup: an item is pushed at most once. If a `sent` ledger row already
//     exists for item.id, skip. Failed rows may be retried (attempts++).
//   - the actual Feishu send is delegated to the lark-cli adapter (D2). D1
//     ships the adapter as a stub so this logic is testable in isolation.
//
// Delivery state lives in its own KV scope (mem:delivery) keyed by item.id —
// the inbox stays the source of truth and is never mutated here.

export function registerInboxDeliverFunction(
  sdk: ISdk,
  kv: StateKV,
  deliver: LarkDeliverFn = defaultDeliver,
): void {
  sdk.registerFunction(
    "mem::inbox-deliver",
    async (data: { item: InboxItem }) => {
      const item = data?.item;
      if (!item || !item.id) {
        return { success: false, error: "item with id is required" };
      }

      // Config gate — disabled / unconfigured → clean skip, no adapter call.
      const config = isLarkDeliveryEnabled() ? getLarkConfig() : null;
      if (!config) {
        const record = await writeRecord(kv, item.id, {
          status: "skipped",
          attempts: 0,
        });
        return { success: true, skipped: true, record };
      }

      // Dedup — already delivered? skip. (Failed rows fall through to retry.)
      const prior = await kv.get<DeliveryRecord>(KV.delivery, item.id);
      if (prior && prior.status === "sent") {
        return { success: true, skipped: true, record: prior };
      }

      const attempts = (prior?.attempts ?? 0) + 1;
      const outcome = await deliver(item, config);

      if (outcome.ok) {
        const record = await writeRecord(kv, item.id, {
          status: "sent",
          messageId: outcome.messageId,
          urgent: outcome.urgent,
          attempts,
          deliveredAt: new Date().toISOString(),
        });
        await safeAudit(kv, "inbox_delivered", "mem::inbox-deliver", [item.id], {
          kind: item.kind,
          urgent: !!outcome.urgent,
        });
        return { success: true, record };
      }

      const record = await writeRecord(kv, item.id, {
        status: "failed",
        error: outcome.error,
        attempts,
      });
      await safeAudit(kv, "delivery_failed", "mem::inbox-deliver", [item.id], {
        kind: item.kind,
        error: outcome.error,
        attempts,
      });
      return { success: false, error: outcome.error, record };
    },
  );
}

async function writeRecord(
  kv: StateKV,
  id: string,
  fields: Omit<DeliveryRecord, "id" | "channel" | "createdAt"> &
    Partial<Pick<DeliveryRecord, "createdAt">>,
): Promise<DeliveryRecord> {
  const existing = await kv.get<DeliveryRecord>(KV.delivery, id);
  const record: DeliveryRecord = {
    id,
    channel: "lark",
    createdAt: existing?.createdAt ?? fields.createdAt ?? new Date().toISOString(),
    status: fields.status,
    messageId: fields.messageId,
    urgent: fields.urgent,
    error: fields.error,
    attempts: fields.attempts,
    deliveredAt: fields.deliveredAt,
  };
  await kv.set(KV.delivery, id, record);
  return record;
}
