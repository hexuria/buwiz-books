export type OrganizationSwitchDecision = "existing_member" | "platform_operator" | "denied";

export interface OrganizationSwitchDecisionInput {
  hasExistingMembership: boolean;
  actorEmail?: string | null;
  configuredOperatorEmail?: string | null;
}

function normalizeEmail(value?: string | null): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : null;
}

export function isPlatformOperatorEmail(
  actorEmail?: string | null,
  configuredOperatorEmail?: string | null,
): boolean {
  const actor = normalizeEmail(actorEmail);
  const operator = normalizeEmail(configuredOperatorEmail);
  return actor !== null && operator !== null && actor === operator;
}

export function decideOrganizationSwitch(
  input: OrganizationSwitchDecisionInput,
): OrganizationSwitchDecision {
  if (input.hasExistingMembership) return "existing_member";
  if (isPlatformOperatorEmail(input.actorEmail, input.configuredOperatorEmail)) {
    return "platform_operator";
  }
  return "denied";
}
