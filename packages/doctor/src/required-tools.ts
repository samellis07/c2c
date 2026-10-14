/**
 * The Catalyst MCP tools c2c needs: the one list doctor D-B5 checks and
 * `c2c plan` writes into plan.json (`mcpTools`). The data is
 * data/required-mcp-tools.json (the plugin ships a copy as
 * references/required-mcp-tools.json); everything else imports it from here.
 *
 * - `base`: tools doctor itself calls, needed for every app.
 * - `byFeature`: tools a plan step needs only when the app uses that feature —
 *   every name has a call site in a provision step or a shipped skill (a tool
 *   nothing calls is dropped, never demanded).
 * - `neverCall`: tools c2c never needs and the agent must never call — the
 *   MCP project tools return project secrets (jwtSecret, clientSecret) into
 *   the transcript. Projects are read through the Catalyst CLI instead.
 *
 * Names are bare (no `CatalystbyZoho_` prefix, no host prefix).
 */

import data from '../data/required-mcp-tools.json' with { type: 'json' };

export const MCP_TOOL_PREFIX: string = data.prefix;

export const REQUIRED_MCP_TOOLS: {
  readonly base: readonly string[];
  readonly byFeature: Readonly<Record<string, readonly string[]>>;
} = { base: data.base, byFeature: data.byFeature };

/** Bare names of the MCP tools c2c never requires and the agent must never call. */
export const NEVER_CALL_MCP_TOOLS: readonly string[] = Object.keys(data.neverCall);

/** Every tool name c2c may need: base plus every feature group. */
export const ALL_REQUIRED_MCP_TOOLS: readonly string[] = [...new Set([...data.base, ...Object.values(data.byFeature as Record<string, string[]>).flat()])];

/** The customer step that adds missing tools to a Zoho MCP server (D-B5 fix). */
export const MCP_TOOLS_GUIDANCE =
  'In the Zoho MCP console (mcp.zoho.com), open your server, Tools, Config Tools, and enable these Catalyst by Zoho tools (or enable all). Then restart your AI chat session so the new tools load.';

