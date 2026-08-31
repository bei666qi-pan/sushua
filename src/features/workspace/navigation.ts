const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function claimReturnPath(workspaceId: string): string {
  return `/workspaces?claim=${encodeURIComponent(workspaceId)}`;
}

export function parsePendingClaim(value: string | undefined): string | undefined {
  return value && UUID_V7.test(value) ? value : undefined;
}
