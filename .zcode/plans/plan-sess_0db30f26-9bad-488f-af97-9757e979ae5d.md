# TierMux Auto Mode: Speed + Layer-wise Model Selection (সংক্ষিপ্ত, verification ছাড়া)

৫টা ছোট পরিবর্তন, সব static (কোনো learned scoring/hedging নয়)। **নতুন টেস্ট লেখা বা e2e রান — কিছুই নয়; শুধু দ্রুত lint/typecheck।**

1. **Head speed cap** (`src/router/picker.ts`): task-table head entry-তে speedRank ≥ 4 skip — agent/coding/debug/plan/chat/longContext kind-এ। trivial/vision অপরিবর্তিত, tail অপরিবর্তিত (dead-end নেই)।
2. **Layer-wise tier gate** (`src/router/picker.ts`): per-kind সর্বনিম্ন tier — agent/coding/debug/plan head-এ frontier/strong only; chat/longContext-এ strong/mid; mid-tier tail-এ failover হিসেবে থাকে।
3. **Timeout settings** (`src/agent/core/routerProvider.ts` + `package.json`): `tiermux.agent.connectTimeoutMs` (60s), `firstContentTimeoutMs` (30s), `chainDeadlineMs` (120s) — default বর্তমান মান, নামানো যাবে। `custom` platform অপরিবর্তিত।
4. **Diag timing** (`engine.ts`, `routerProvider.ts`): per-step duration ও per-candidate TTFT `diagLog`-এ, `diagTrace` gate-এ বন্ধ থাকে — selection-কে কিছু খাওয়ায় না।
5. **মরা `onStep` seam** (`engine.ts` → `chatViewProvider.ts:3021` ইতিমধ্যে wired): pass/tool phase event পাঠানো — অপেক্ষার সময় UI-তে progress দেখা যাবে।

সাথে: `docs/ROUTING.md` আপডেট (নতুন gate ও settings)।

যাচাই: শুধু `npm run typecheck` — repo-র নিয়ম অনুযায়ী কোনো issue আছে কিনা। e2e/verification স্ক্রিপ্ট এই প্ল্যানে চালানো হবে না।