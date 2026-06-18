import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function ensurePlansGitIgnore(cwd: string): void {
	const dir = join(cwd, ".picopi", "plans");
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	const ignorePath = join(dir, ".gitignore");
	if (!existsSync(ignorePath)) {
		writeFileSync(ignorePath, "*\n", "utf-8");
	}
}

export function setupPlans(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		try {
			ensurePlansGitIgnore(ctx.cwd);
		} catch {
			if (ctx.hasUI) {
				ctx.ui.notify("Failed to set up .picopi/plans/ gitignore — plans may be committed accidentally", "warning");
			}
		}
	});
}
