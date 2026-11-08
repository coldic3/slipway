/** Slipway environment variables: `SLIPWAY_<name>`. */
export function slipwayEnv(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[`SLIPWAY_${name}`] || undefined;
}
