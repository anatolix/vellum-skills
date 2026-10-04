// Native Codex agents are independent of Vellum subagent_spawn.
// Model-catalog V2 bypasses features.multi_agent=false; agents.enabled=false
// is required, and an explicit enabled V2 feature must not override it.
export function codexThreadConfig({ nativeTools = !!process.env.SHIM_NATIVE_TOOLS } = {}) {
  return {
    include_permissions_instructions: false,
    include_environment_context: false,
    include_collaboration_mode_instructions: false,
    include_apps_instructions: false,
    agents: { enabled: false },
    features: {
      multi_agent: false,
      multi_agent_v2: false,
      ...(nativeTools ? {} : { shell_tool: false, unified_exec: false, plugins: false, apps: false }),
    },
  };
}
