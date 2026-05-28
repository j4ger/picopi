/**
 * Provider fallback — transparent failover when provider errors
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getConfig, resolveModel, getProvider } from "./config";

const failures = new Map<string, number>();
const lastFail = new Map<string, number>();
const THRESHOLD = 3;
const COOLDOWN = 60000;

export function registerFallback(pi: ExtensionAPI) {
  pi.on("before_provider_request", async (event, ctx) => {
    const model = event.model;
    if (!model) return;

    const [provider] = model.split("/");
    const f = failures.get(provider) || 0;
    const lf = lastFail.get(provider) || 0;

    if (f >= THRESHOLD && Date.now() - lf < COOLDOWN) {
      const resolver = resolveModel(model);
      for (const entry of resolver.chain) {
        const { provider: fbProvider, modelId } = resolver.parse(entry);
        if (fbProvider === provider) continue;
        const p = getProvider(fbProvider);
        if (!p || !p.key) continue;
        if ((failures.get(fbProvider) || 0) >= THRESHOLD) continue;

        ctx.ui.notify(`Switched to ${fbProvider}`, "warning");
        return { override: { ...event, model: `${fbProvider}/${modelId}` } };
      }
    }
  });

  pi.on("after_provider_response", async (event) => {
    const [provider] = (event.model || "").split("/");
    if (!provider) return;
    if (event.status >= 500 || event.status === 429) {
      failures.set(provider, (failures.get(provider) || 0) + 1);
      lastFail.set(provider, Date.now());
    } else if (event.status === 200) {
      failures.set(provider, 0);
    }
  });
}
