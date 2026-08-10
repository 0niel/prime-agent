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
	/** Optional RFC 6052 NAT64 prefixes (length /32, /40, /48, /56, /64, or /96). */
	nat64Prefixes?: string[];
	/** @internal Shares one RFC 7050 discovery result across related endpoint policies. */
	nat64CacheKey?: object;
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
	if (a === 192 && b === 0 && c === 0 && (bytes[3] === 9 || bytes[3] === 10)) return "public";
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

function inCidr(bytes: number[], network: number[], prefixBits: number): boolean {
	const wholeBytes = Math.floor(prefixBits / 8);
	const remainder = prefixBits % 8;
	for (let index = 0; index < wholeBytes; index++) {
		if (bytes[index] !== network[index]) return false;
	}
	if (remainder === 0) return true;
	const mask = (0xff << (8 - remainder)) & 0xff;
	return (bytes[wholeBytes] & mask) === (network[wholeBytes] & mask);
}

const RFC6052_PREFIX_LENGTHS = new Set([32, 40, 48, 56, 64, 96]);
const IPV4ONLY_DISCOVERY_ADDRESSES = new Set(["192.0.0.170", "192.0.0.171"]);
interface Nat64Prefix {
	bytes: number[];
	length: number;
}
const NAT64_DISCOVERY_CACHE_MS = 30_000;
interface Nat64CacheEntry {
	expiresAt: number;
	promise: Promise<Nat64Prefix[]>;
}
const nat64PrefixCache = new WeakMap<object, Nat64CacheEntry>();

function parseNat64Prefix(cidr: string): Nat64Prefix {
	const slash = cidr.lastIndexOf("/");
	const length = Number(cidr.slice(slash + 1));
	const bytes = ipv6Bytes(cidr.slice(0, slash));
	if (slash <= 0 || !bytes || !RFC6052_PREFIX_LENGTHS.has(length)) {
		throw new Error("OAuth NAT64 prefix must be valid IPv6 with RFC 6052 length /32, /40, /48, /56, /64, or /96");
	}
	const network = bytes.map((byte, index) => (index < length / 8 ? byte : 0));
	if (!bytes.every((byte, index) => byte === network[index])) {
		throw new Error("OAuth NAT64 prefix contains non-zero host bits");
	}
	if (length === 96 && bytes[8] !== 0) {
		throw new Error("OAuth NAT64 /96 prefix must keep the RFC 6052 u octet zero");
	}
	return { bytes: network, length };
}

function decodeRfc6052(address: number[], prefix: Nat64Prefix): number[] | undefined {
	if (!inCidr(address, prefix.bytes, prefix.length)) return undefined;
	const n = prefix.length / 8;
	if (prefix.length === 96) return address.slice(12, 16);
	const beforeU = 8 - n;
	if (address[8] !== 0) return undefined;
	const embedded = [...address.slice(n, n + beforeU), ...address.slice(9, 9 + (4 - beforeU))];
	return embedded.length === 4 ? embedded : undefined;
}

function deriveRfc7050Prefix(address: string): Nat64Prefix | undefined {
	const bytes = ipv6Bytes(address);
	if (!bytes) return undefined;
	for (const length of RFC6052_PREFIX_LENGTHS) {
		const prefix: Nat64Prefix = {
			bytes: bytes.map((byte, index) => (index < length / 8 ? byte : 0)),
			length,
		};
		if (length === 96 && prefix.bytes[8] !== 0) continue;
		const embedded = decodeRfc6052(bytes, prefix);
		if (embedded && IPV4ONLY_DISCOVERY_ADDRESSES.has(embedded.join("."))) return prefix;
	}
	return undefined;
}

async function resolveNat64Prefixes(policy: OAuthFetchPolicy): Promise<Nat64Prefix[]> {
	const cacheKey = policy.nat64CacheKey ?? policy;
	const existing = nat64PrefixCache.get(cacheKey);
	if (existing && Date.now() < existing.expiresAt) return existing.promise;
	const promise = (async () => {
		if ((policy.nat64Prefixes?.length ?? 0) > 16) throw new Error("OAuth NAT64 prefix limit exceeded (16)");
		const configured = policy.nat64Prefixes?.map(parseNat64Prefix);
		if (configured) return [parseNat64Prefix("64:ff9b::/96"), ...configured];
		try {
			const { lookup } = await import("node:dns/promises");
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				const answers = await Promise.race([
					lookup("ipv4only.arpa", { all: true, verbatim: true }),
					new Promise<never>((_, reject) => {
						timer = setTimeout(
							() => reject(new Error("RFC 7050 discovery timed out")),
							policy.timeoutMs ?? DEFAULT_TIMEOUT_MS,
						);
					}),
				]);
				const discovered = answers
					.slice(0, 64)
					.filter(({ family }) => family === 6)
					.map(({ address }) => deriveRfc7050Prefix(address))
					.filter((prefix): prefix is Nat64Prefix => prefix !== undefined);
				const unique = new Map(discovered.map((prefix) => [`${prefix.bytes.join(":")}/${prefix.length}`, prefix]));
				return [parseNat64Prefix("64:ff9b::/96"), ...unique.values()];
			} finally {
				if (timer) clearTimeout(timer);
			}
		} catch {
			return [parseNat64Prefix("64:ff9b::/96")];
		}
	})();
	nat64PrefixCache.set(cacheKey, {
		expiresAt: policy.nat64Prefixes === undefined ? Date.now() + NAT64_DISCOVERY_CACHE_MS : Number.POSITIVE_INFINITY,
		promise,
	});
	return promise;
}

async function addressKindWithPolicy(
	address: string,
	family: number,
	policy: OAuthFetchPolicy,
): Promise<"public" | "loopback" | "blocked"> {
	if (family !== 6) return addressKind(address, family);
	const bytes = ipv6Bytes(address);
	if (!bytes) return "blocked";
	for (const prefix of await resolveNat64Prefixes(policy)) {
		if (!inCidr(bytes, prefix.bytes, prefix.length)) continue;
		const embedded = decodeRfc6052(bytes, prefix);
		if (!embedded || ipv4Kind(embedded.join(".")) !== "public") return "blocked";
	}
	// A public embedded IPv4 never upgrades an otherwise non-global IPv6
	// locator; discovered/configured prefixes are monotonic deny-only.
	return ipv6Kind(address);
}

function ipv6Kind(address: string): "public" | "loopback" | "blocked" {
	const bytes = ipv6Bytes(address);
	if (!bytes) return "blocked";
	if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) return "loopback";
	if (bytes.every((byte) => byte === 0)) return "blocked";

	// Normalize the operational IPv4-mapped socket alias before classification.
	if (inCidr(bytes, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff], 96)) {
		return ipv4Kind(bytes.slice(12).join("."));
	}
	// Deprecated IPv4-compatible and RFC 2765 translated forms are not global
	// IPv6 locators, even when their embedded IPv4 value is public.
	if (
		inCidr(bytes, new Array<number>(12).fill(0), 96) ||
		inCidr(bytes, [0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 0, 0], 96)
	) {
		return "blocked";
	}
	// RFC 6052's well-known NAT64 prefix is globally reachable only when its
	// embedded destination is itself public; local-use translation prefixes
	// remain excluded by the positive global-unicast gate below.
	if (inCidr(bytes, [0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0], 96)) {
		return ipv4Kind(bytes.slice(12).join(".")) === "public" ? "public" : "blocked";
	}

	// Positive policy from the IANA IPv6 Special-Purpose Address Registry:
	// currently allocated general global-unicast locators are in 2000::/3.
	// This denies site/link-local, ULA, multicast, discard, translation,
	// benchmarking and unallocated space by default.
	if (!inCidr(bytes, [0x20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 3)) return "blocked";

	// Globally reachable locator exceptions inside the otherwise special
	// 2001::/23 IETF assignments block. ORCHIDv2 and DET identity prefixes
	// are deliberately not treated as SSRF-safe network destinations even
	// though the IANA registry marks them globally reachable.
	const globalIetfException =
		[1, 2, 3].some((last) => inCidr(bytes, [0x20, 0x01, 0, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, last], 128)) ||
		inCidr(bytes, [0x20, 0x01, 0, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 32) ||
		inCidr(bytes, [0x20, 0x01, 0, 0x04, 0x01, 0x12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 48);
	if (globalIetfException) return "public";

	const nonGlobalSpecial =
		inCidr(bytes, [0x20, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 23) ||
		inCidr(bytes, [0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 32) ||
		inCidr(bytes, [0x20, 0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 16) ||
		inCidr(bytes, [0x3f, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 20);
	return nonGlobalSpecial ? "blocked" : "public";
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
	const kinds = await Promise.all(
		addresses.map(({ address, family }) => addressKindWithPolicy(address, family, policy)),
	);
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

interface BoundedFetchResult {
	status: number;
	headers: Headers;
	body: string;
	url: URL;
}

async function safeFetchBounded(
	rawUrl: string,
	init: RequestInit | undefined,
	policy: OAuthFetchPolicy,
	discardBody = false,
): Promise<BoundedFetchResult> {
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

			let body = "";
			if (discardBody) {
				try {
					await response.body?.cancel();
				} catch {
					// Headers are already bounded by Undici; teardown errors do not
					// invalidate an authoritative authentication challenge.
				}
			} else {
				body = await readBoundedBody(response, maxBodyBytes);
			}
			return { status: response.status, headers: new Headers(response.headers), body, url: target.url };
		} finally {
			clearTimeout(timeout);
			init?.signal?.removeEventListener("abort", onAbort);
			await dispatcher.close();
		}
	}
}

export async function safeFetchJson(
	rawUrl: string,
	init: RequestInit | undefined,
	policy: OAuthFetchPolicy,
): Promise<unknown> {
	const method = (init?.method ?? "GET").toUpperCase();
	const result = await safeFetchBounded(rawUrl, init, policy);
	if (result.status < 200 || result.status >= 300) {
		throw new Error(`${method} ${redactedUrl(result.url)} failed with HTTP ${result.status}`);
	}
	try {
		return JSON.parse(result.body);
	} catch (cause) {
		const contentType = result.headers.get("content-type") ?? "unknown content type";
		throw new Error(`${method} ${redactedUrl(result.url)} returned non-JSON (${contentType})`, { cause });
	}
}

/** Perform a bounded unauthenticated MCP initialize probe and return only a 401 challenge. */
export async function probeMcpOAuthChallenge(
	rawUrl: string,
	policy: OAuthFetchPolicy,
): Promise<{ challenged: boolean; header?: string }> {
	const body = JSON.stringify({
		jsonrpc: "2.0",
		id: 1,
		method: "initialize",
		params: {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "prime-agent-oauth-discovery", version: "1" },
		},
	});
	const result = await safeFetchBounded(
		rawUrl,
		{
			method: "POST",
			headers: {
				Accept: "application/json, text/event-stream",
				"Content-Type": "application/json",
			},
			body,
		},
		policy,
		true,
	);
	return result.status === 401
		? { challenged: true, header: result.headers.get("www-authenticate") ?? undefined }
		: { challenged: false };
}
