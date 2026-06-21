import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
	SELF,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src/index";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

// These tests exercise the request-handling paths that do NOT touch the Images
// binding (which requires `--remote`). The transform/watermark path is verified
// against the real bucket via `wrangler dev --remote`.
describe("bdgcafe image worker", () => {
	it("rejects non-GET/HEAD methods", async () => {
		const request = new IncomingRequest("https://image.bdgcafe.com/cafes/abc/cover.jpg", {
			method: "POST",
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(405);
		expect(response.headers.get("Allow")).toBe("GET, HEAD");
	});

	it("404s a missing object", async () => {
		const request = new IncomingRequest("https://image.bdgcafe.com/does/not/exist.jpg");
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(404);
	});

	it("404s a path-traversal key", async () => {
		const response = await SELF.fetch(
			"https://image.bdgcafe.com/..%2f..%2fsecret.jpg",
		);
		expect(response.status).toBe(404);
	});

	it("404s a direct request for the watermark asset", async () => {
		const response = await SELF.fetch("https://image.bdgcafe.com/watermark.png");
		expect(response.status).toBe(404);
	});
});
