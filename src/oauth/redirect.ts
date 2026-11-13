/** Only the three clients selected for this personal server may receive grants. */
export function isAllowedRedirectUri(value: string): boolean {
  return (
    [
      'https://chatgpt.com/connector_platform_oauth_redirect',
      'https://claude.ai/api/mcp/auth_callback',
      'https://agent.meta.ai/api/hatch/oauth/callback',
    ].includes(value) ||
    /^https:\/\/chatgpt\.com\/connector\/oauth\/[A-Za-z0-9_-]+$/.test(value)
  )
}
