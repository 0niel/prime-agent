export type { McpCatalogEntry } from "./catalog.js";
export { BUILTIN_MCP_CATALOG, getCatalogEntry, registerBuiltinMcpOAuthProviders } from "./catalog.js";
export type { McpOAuthChallenge, McpOAuthConfig } from "./oauth.js";
export {
	createMcpOAuthProvider,
	parseMcpOAuthChallenge,
	parseMcpOAuthResourceMetadataChallenge,
} from "./oauth.js";
