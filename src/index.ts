/**
 * bdgcafe image worker
 *
 * Serves images from a PRIVATE R2 bucket, resized + watermarked on the fly via
 * the Cloudflare Images binding. The bucket has no public access — this Worker
 * (custom domain image.bdgcafe.com) is the only way to read it.
 *
 *   request ─▶ edge cache lookup (canonical key)
 *           ─▶ R2 read (private binding)
 *           ─▶ Images: resize + centered watermark
 *           ─▶ cache + return
 *
 * The DB stores the bare R2 key (e.g. "cafes/abc/cover.jpg"); the request path
 * IS the key. Transform via query params (long or short form):
 *
 *   width  | w       target width  (px, never enlarges past the source)
 *   height | h       target height (px)
 *   quality| q       1-100 (default 82)
 *   fit              scale-down | contain | cover | crop | pad
 *                    (default: cover when both w & h given, else scale-down)
 *   format | f       avif | webp | jpeg | png | auto (default webp;
 *                    auto negotiates from the Accept header)
 *
 * These names line up with what unpic-img emits per srcset width.
 */

const WATERMARK_KEY = "watermark.png"; // logo object at the bucket root
const WATERMARK_SCALE = 0.4; // watermark width as a fraction of the rendered width
const WATERMARK_OPACITY = 0.35;
const DEFAULT_FORMAT = "image/webp" as const;
const DEFAULT_QUALITY = 82;
const MAX_DIM = 4000; // clamp requested + oversized-source dimensions
const FALLBACK_WIDTH = 1600; // watermark sizing when source dimensions are unknown (e.g. SVG)
const CACHE_CONTROL = "public, max-age=31536000, immutable";

const FITS = new Set(["scale-down", "contain", "cover", "crop", "pad"]);
const FORMATS: Record<string, ImageOutputOptions["format"]> = {
	avif: "image/avif",
	webp: "image/webp",
	jpeg: "image/jpeg",
	jpg: "image/jpeg",
	png: "image/png",
};

/** A fresh ReadableStream over the same bytes — the Images binding consumes streams. */
function bytesToStream(bytes: ArrayBuffer): ReadableStream<Uint8Array> {
	return new Response(bytes).body!;
}

/** Positive integer from a query value, else undefined. */
function intParam(params: URLSearchParams, ...names: string[]): number | undefined {
	for (const name of names) {
		const raw = params.get(name);
		if (raw === null) continue;
		const n = Number(raw);
		if (Number.isFinite(n) && n > 0) return Math.round(n);
	}
	return undefined;
}

/**
 * True if `key` matches any entry in the comma/newline-separated bypass list.
 * Entry forms: exact ("a/b.jpg"), folder ("a/" => prefix), wildcard ("a/b-*" => prefix).
 */
export function isWatermarkBypassed(key: string, list: string | undefined): boolean {
	if (!list) return false;
	for (const raw of list.split(/[\n,]/)) {
		const entry = raw.trim();
		if (!entry) continue;
		if (entry.endsWith("*")) {
			if (key.startsWith(entry.slice(0, -1))) return true;
		} else if (entry.endsWith("/")) {
			if (key.startsWith(entry)) return true;
		} else if (key === entry) {
			return true;
		}
	}
	return false;
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		if (request.method !== "GET" && request.method !== "HEAD") {
			return new Response("Method Not Allowed", {
				status: 405,
				headers: { Allow: "GET, HEAD" },
			});
		}
		const isGet = request.method === "GET";

		const url = new URL(request.url);
		const key = decodeURIComponent(url.pathname.slice(1));

		// Reject empty, path traversal, and direct access to the bare watermark.
		if (!key || key.includes("..") || key === WATERMARK_KEY) {
			return new Response("Not Found", { status: 404 });
		}

		// Paths on the bypass list are served without a watermark.
		const bypass = isWatermarkBypassed(key, env.WATERMARK_BYPASS);

		// Parse + validate params.
		const p = url.searchParams;
		const reqWidth = intParam(p, "width", "w");
		const reqHeight = intParam(p, "height", "h");
		const reqQuality = intParam(p, "quality", "q");
		const quality = reqQuality ? Math.min(100, reqQuality) : DEFAULT_QUALITY;

		const fitParam = p.get("fit");
		const fit: ImageTransform["fit"] =
			fitParam && FITS.has(fitParam)
				? (fitParam as ImageTransform["fit"])
				: reqWidth && reqHeight
					? "cover"
					: "scale-down";

		const formatParam = (p.get("format") ?? p.get("f") ?? "").toLowerCase();
		const accept = request.headers.get("Accept") ?? "";
		const negotiated = /image\/avif/.test(accept) ? "image/avif" : "image/webp";
		const format: ImageOutputOptions["format"] =
			formatParam === "auto"
				? negotiated
				: (FORMATS[formatParam] ?? DEFAULT_FORMAT);

		// Canonical edge-cache key: same image+params collapse to one entry
		// regardless of param aliases, and the resolved format is baked in so
		// `format=auto` variants (avif vs webp) cache separately and correctly.
		const ck = new URL(url.origin + url.pathname);
		if (reqWidth) ck.searchParams.set("width", String(reqWidth));
		if (reqHeight) ck.searchParams.set("height", String(reqHeight));
		ck.searchParams.set("quality", String(quality));
		if (reqWidth || reqHeight) ck.searchParams.set("fit", fit!);
		ck.searchParams.set("format", format);
		// Distinguish un-watermarked entries so toggling the bypass list never
		// serves a stale watermarked (or un-watermarked) copy from cache.
		if (bypass) ck.searchParams.set("wm", "0");
		const cacheKey = new Request(ck.toString(), { method: "GET" });

		const cache = caches.default;
		if (isGet) {
			const hit = await cache.match(cacheKey);
			if (hit) return hit;
		}

		// Read original (+ watermark, unless bypassed) straight from the private bucket.
		const [object, watermark] = await Promise.all([
			env.BUCKET.get(key),
			bypass ? Promise.resolve(null) : env.BUCKET.get(WATERMARK_KEY),
		]);
		if (!object) return new Response("Not Found", { status: 404 });
		if (!bypass && !watermark) return new Response("Watermark asset missing", { status: 500 });

		try {
			const originalBytes = await object.arrayBuffer();

			const info = await env.IMAGES.info(bytesToStream(originalBytes));
			const srcW = "width" in info ? info.width : undefined;
			const srcH = "height" in info ? info.height : undefined;

			// Build the resize transform.
			const transform: ImageTransform = {};
			if (reqWidth) transform.width = Math.min(reqWidth, MAX_DIM);
			if (reqHeight) transform.height = Math.min(reqHeight, MAX_DIM);
			if (reqWidth || reqHeight) {
				transform.fit = fit;
			} else if (srcW !== undefined && srcW > MAX_DIM) {
				// No explicit size: still clamp a huge original.
				transform.width = MAX_DIM;
				transform.fit = "scale-down";
			}

			let pipeline = env.IMAGES.input(bytesToStream(originalBytes));
			if (Object.keys(transform).length > 0) {
				pipeline = pipeline.transform(transform);
			}

			// Watermark unless this path is on the bypass list.
			if (watermark) {
				// Size the watermark relative to the rendered width (centered).
				let renderedWidth: number;
				if (transform.width !== undefined) {
					renderedWidth = srcW !== undefined ? Math.min(transform.width, srcW) : transform.width;
				} else if (reqHeight && srcW && srcH) {
					renderedWidth = Math.min(Math.round(reqHeight * (srcW / srcH)), srcW);
				} else {
					renderedWidth = srcW ?? FALLBACK_WIDTH;
				}
				const watermarkWidth = Math.max(1, Math.round(renderedWidth * WATERMARK_SCALE));

				pipeline = pipeline.draw(
					// `fit: contain` lets the small watermark upscale to the target width.
					env.IMAGES.input(watermark.body).transform({ width: watermarkWidth, fit: "contain" }),
					{ opacity: WATERMARK_OPACITY }, // no top/left/bottom/right => centered
				);
			}

			const result = await pipeline.output({ format, quality });

			// Re-wrap so we can attach cache headers (binding headers are immutable).
			const headers = new Headers({
				"Content-Type": result.contentType(),
				"Cache-Control": CACHE_CONTROL,
			});
			// Only `auto` depends on the request; tell shared caches downstream.
			if (formatParam === "auto") headers.set("Vary", "Accept");

			const response = new Response(result.image(), { headers });
			if (isGet) ctx.waitUntil(cache.put(cacheKey, response.clone()));
			return response;
		} catch (err) {
			console.error("image transform failed", key, err);
			return new Response("Image processing failed", { status: 500 });
		}
	},
} satisfies ExportedHandler<Env>;
