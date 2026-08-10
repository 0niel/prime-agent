// Node-only SSRF-safe fetch primitives for MCP OAuth metadata and token flows.

const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_REQUEST_BODY_BYTES = 64 * 1024;

export interface OAuthFetchPolicy {
	/** The one explicitly configured HTTP origin allowed when it resolves only to loopback. */
	allowedHttpOrigin?: string;
	maxRedirects?: number;
	maxBodyBytes?: number;
	timeoutMs?: number;
}

interface ResolvedTarget {
	url: URL;
	address: string;
	family: 4 | 6;
}

function canonicalHostname(hostname: string): string {
	return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function parseIpv4(address: string): number[] | undefined {
	const parts = address.split(".");
	if (parts.length !== 4) return undefined;
	const bytes = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
	return bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255) ? bytes : undefined;
}

function ipv4Kind(address: string): "public" | "loopback" | "blocked" {
	const bytes = parseIpv4(address);
	if (!bytes) return "blocked";
	const [a, b, c] = bytes;
	if (a === 127) return "loopback";
	if (
		a === 0 ||
		a === 10 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 192 && b === 0 && c === 0) ||
		(a === 192 && b === 0 && c === 2) ||
		(a === 192 && b === 88 && c === 99) ||
		(a === 198 && (b === 18 || b === 19)) ||
		(a === 198 && b === 51 && c === 100) ||
		(a === 203 && b === 0 && c === 113) ||
		a >= 224
	) {
		return "blocked";
	}
	return "public";
}

function ipv6Bytes(address: string): number[] | undefined {
	const withoutZone = address.split("%", 1)[0]?.toLowerCase();
	if (!withoutZone || address.includes("%")) return undefined;
	let input = withoutZone;
	if (input.includes(".")) {
		const lastColon = input.lastIndexOf(":");
		const ipv4 = parseIpv4(input.slice(lastColon + 1));
		if (lastColon < 0 || !ipv4) return undefined;
		input = `${input.slice(0, lastColon)}:${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`;
	}
	if ((input.match(/::/g) ?? []).length > 1) return undefined;
	const [leftRaw, rightRaw] = input.split("::");
	const left = leftRaw ? leftRaw.split(":") : [];
	const right = rightRaw ? rightRaw.split(":") : [];
	const missing = 8 - left.length - right.length;
	if ((input.includes("::") && missing < 1) || (!input.includes("::") && missing !== 0)) return undefined;
	const groups = [...left, ...Array.from({ length: Math.max(0, missing) }, () => "0"), ...right];
	if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return undefined;
	return groups.flatMap((group) => {
		const value = Number.parseInt(group, 16);
		return [value >> 8, value & 0xff];
	});
}

function ipv6Kind(address: string): "public" | "loopback" | "blocked" {
	const bytes = ipv6Bytes(address);
	if (!bytes) return "blocked";
	if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) return "loopback";
	if (bytes.every((byte) => byte === 0)) return "blocked";
	if (bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
		return ipv4Kind(bytes.slice(12).join("."));
	}
	const first = bytes[0];
	const second = bytes[1];
	const firstGroup = (first << 8) | second;
	const secondGroup = (bytes[2] << 8) | bytes[3];
	if (
		(first & 0xfe) === 0xfc ||
		(first === 0xfe && (second & 0xc0) === 0x80) ||
		first === 0xff ||
		(firstGroup === 0x64 && secondGroup === 0xff9b) ||
		(firstGroup === 0x100 && bytes.slice(2, 8).every((byte) => byte === 0)) ||
		(firstGroup === 0x2001 && (bytes[2] <= 1 || secondGroup === 0x0db8)) ||
		firstGroup === 0x2002 ||
		(firstGroup === 0x3fff && (secondGroup & 0xf000) === 0) ||
		firstGroup === 0x5f00
	) {
		return "blocked";
	}
	return "public";
}

function addressKind(address: string, family: number): "public" | "loopback" | "blocked" {
	return family === 4 ? ipv4Kind(address) : family === 6 ? ipv6Kind(address) : "blocked";
}

export function createOAuthFetchPolicy(resourceUrl: string): OAuthFetchPolicy {
	const parsed = new URL(resourceUrl);
	if (parsed.username || parsed.password || parsed.hash) {
		throw new Error("MCP OAuth resource URL must not contain credentials or a fragment");
	}
	if (parsed.protocol === "https:") return {};
	if (parsed.protocol === "http:") {
		const hostname = canonicalHostname(parsed.hostname);
		const literalKind = ipv4Kind(hostname) === "loopback" || ipv6Kind(hostname) === "loopback";
		if (hostname.toLowerCase() !== "localhost" && !literalKind) {
			throw new Error("HTTP MCP OAuth resources must use an explicit loopback host");
		}
		return { allowedHttpOrigin: parsed.origin };
	}
	throw new Error("MCP OAuth resource URL must use HTTPS");
}

function redactedUrl(url: URL): string {
	return `${url.origin}${url.pathname}`;
}

async function resolveTarget(rawUrl: string | URL, policy: OAuthFetchPolicy): Promise<ResolvedTarget> {
	if (String(rawUrl).length > 4096) throw new Error("OAuth URL is too long");
	const url = new URL(rawUrl);
	if (url.username || url.password || url.hash)
		throw new Error("OAuth URL must not contain credentials or a fragment");
	const isHttpException = url.protocol === "http:" && url.origin === policy.allowedHttpOrigin;
	if (url.protocol !== "https:" && !isHttpException) throw new Error("OAuth network requests must use HTTPS");

	const hostname = canonicalHostname(url.hostname);
	const { isIP } = await import("node:net");
	const literalFamily = isIP(hostname);
	let addresses: Array<{ address: string; family: number }>;
	if (literalFamily) {
		addresses = [{ address: hostname, family: literalFamily }];
	} else {
		if (hostname.toLowerCase() === "localhost" || hostname.toLowerCase().endsWith(".localhost")) {
			addresses = [{ address: "127.0.0.1", family: 4 }];
		} else {
			let dnsTimeout: ReturnType<typeof setTimeout> | undefined;
			try {
				const { lookup } = await import("node:dns/promises");
				addresses = await Promise.race([
					lookup(hostname, { all: true, verbatim: true }),
					new Promise<never>((_, reject) => {
						dnsTimeout = setTimeout(
							() => reject(new Error("OAuth DNS lookup timed out")),
							policy.timeoutMs ?? DEFAULT_TIMEOUT_MS,
						);
					}),
				]);
			} catch (cause) {
				throw new Error(`OAuth hostname could not be resolved: ${hostname}`, { cause });
			} finally {
				if (dnsTimeout) clearTimeout(dnsTimeout);
			}
		}
	}
	if (addresses.length === 0) throw new Error(`OAuth hostname resolved to no addresses: ${hostname}`);
	const kinds = addresses.map(({ address, family }) => addressKind(address, family));
	if (isHttpException) {
		if (kinds.some((kind) => kind !== "loopback")) {
			throw new Error("The configured HTTP MCP resource must resolve only to loopback addresses");
		}
	} else if (kinds.some((kind) => kind !== "public")) {
		throw new Error(`OAuth hostname resolves to a non-public address: ${hostname}`);
	}
	const selected = addresses[0];
	return { url, address: selected.address, family: selected.family as 4 | 6 };
}

export async function validateOAuthNetworkUrl(rawUrl: string, policy: OAuthFetchPolicy): Promise<URL> {
	return (await resolveTarget(rawUrl, policy)).url;
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let total = 0;
	let text = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > maxBytes) throw new Error(`OAuth response exceeded ${maxBytes} bytes`);
			text += decoder.decode(value, { stream: true });
		}
		return text + decoder.decode();
	} finally {
		try {
			await reader.cancel();
		} catch {
			// Already closed.
		}
		rendererRelease(reader);
	}
}

function rendererRelease(reader: ReadableStreamDefaultReader<Uint8Array>): void {
	try {
		reader.releaseLock();
	} catch {
		// Lock already released.
	}
}

export async function safeFetchJson(
	rawUrl: string,
	init: RequestInit | undefined,
	policy: OAuthFetchPolicy,
): Promise<unknown> {
	const method = (init?.method ?? "GET").toUpperCase();
	const requestBodyBytes =
		typeof init?.body === "string"
			? new TextEncoder().encode(init.body).byteLength
			: init?.body instanceof Uint8Array
				? init.body.byteLength
				: 0;
	if (requestBodyBytes > MAX_REQUEST_BODY_BYTES) throw new Error("OAuth request body is too large");
	const maxRedirects = policy.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
	const maxBodyBytes = policy.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
	let current = rawUrl;

	for (let redirects = 0; ; redirects++) {
		const target = await resolveTarget(current, policy);
		const { Agent } = await import("undici");
		const pinnedLookup = ((_hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
			if (options?.all) callback(null, [{ address: target.address, family: target.family }]);
			else callback(null, target.address, target.family);
		}) as unknown as import("node:net").LookupFunction;
		const dispatcher = new Agent({
			headersTimeout: policy.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			bodyTimeout: policy.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			maxResponseSize: maxBodyBytes,
			connect: {
				timeout: Math.min(5_000, policy.timeoutMs ?? DEFAULT_TIMEOUT_MS),
				lookup: pinnedLookup,
			},
		});
		const controller = new AbortController();
		const onAbort = () => controller.abort(init?.signal?.reason);
		if (init?.signal?.aborted) controller.abort(init.signal.reason);
		else init?.signal?.addEventListener("abort", onAbort, { once: true });
		const timeout = setTimeout(
			() => controller.abort(new Error("OAuth request timed out")),
			policy.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		);
		try {
			const requestInit = {
				...init,
				redirect: "manual",
				signal: controller.signal,
				dispatcher,
			} as unknown as RequestInit;
			const response = await fetch(target.url, requestInit);

			if (response.status >= 300 && response.status < 400) {
				try {
					await response.body?.cancel();
				} catch {
					// Ignore redirect response teardown errors.
				}
				if (method !== "GET" && method !== "HEAD") throw new Error("OAuth POST redirects are not allowed");
				if (redirects >= maxRedirects) throw new Error(`OAuth redirect limit exceeded (${maxRedirects})`);
				const location = response.headers.get("location");
				if (!location) throw new Error("OAuth redirect response omitted Location");
				const next = new URL(location, target.url);
				if (next.origin !== target.url.origin)
					throw new Error("Cross-origin OAuth metadata redirects are not allowed");
				current = next.toString();
				continue;
			}

			const body = await readBoundedBody(response, maxBodyBytes);
			if (!response.ok) throw new Error(`${method} ${redactedUrl(target.url)} failed with HTTP ${response.status}`);
			try {
				return JSON.parse(body);
			} catch (cause) {
				const contentType = response.headers.get("content-type") ?? "unknown content type";
				throw new Error(`${method} ${redactedUrl(target.url)} returned non-JSON (${contentType})`, { cause });
			}
		} finally {
			clearTimeout(timeout);
			init?.signal?.removeEventListener("abort", onAbort);
			await dispatcher.close();
		}
	}
}
