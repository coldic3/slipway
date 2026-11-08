import pkg from '../package.json' with { type: 'json' };

/** Slipway's version: the CLI, the plugin and its MCP server share it (a unit test keeps plugin.json in step). */
export const VERSION: string = pkg.version;
