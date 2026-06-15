import type { InboxItem } from "../types.js";
import type { LarkConfig } from "../config.js";

// Line D — lark-cli adapter (D2 implements the real execFile call to lark-cli).
//
// D1 ships this as a not-yet-wired stub so the delivery primitive
// (mem::inbox-deliver: dedup + config gate + ledger + audit) is fully built
// and tested without depending on lark-cli or a live Feishu bot. The actual
// message construction + `execFile("lark-cli", [...])` lands in STEP-D2.
//
// Contract (frozen here so D1's deliver fn can call it):
//   deliverViaLark(item, config) → resolves a DeliveryOutcome.
//   - never throws; on any failure returns { ok: false, error }.
//   - question → interactive card + urgent_app (per config.urgentQuestion).
//   - briefing → markdown DM, no urgency.

export interface DeliveryOutcome {
  ok: boolean;
  messageId?: string;
  urgent?: boolean;
  error?: string;
}

export type LarkDeliverFn = (
  item: InboxItem,
  config: LarkConfig,
) => Promise<DeliveryOutcome>;

// D1 default: explicitly report "not implemented yet" so a misconfigured
// early opt-in records a clean `skipped`/`failed` ledger row instead of
// silently looking sent. D2 replaces this with the real lark-cli call.
export const deliverViaLark: LarkDeliverFn = async () => {
  return { ok: false, error: "lark adapter not implemented (pending STEP-D2)" };
};
