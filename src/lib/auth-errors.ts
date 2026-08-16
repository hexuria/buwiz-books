/**
 * Auth Error Classes
 *
 * Typed error classes for authentication and authorization failures.
 * These provide structured error handling across UI and server layers.
 */

export class AuthError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(message: string, code: string, statusCode: number) {
    super(message);
    this.name = "AuthError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * Thrown when user is not authenticated (no valid session)
 */
export class AuthenticationError extends AuthError {
  constructor(message = "Authentication required") {
    super(message, "UNAUTHENTICATED", 401);
    this.name = "AuthenticationError";
  }
}

/**
 * Thrown when user lacks permission for an action
 */
export class AuthorizationError extends AuthError {
  readonly resource: string;
  readonly action: string;

  constructor(resource: string, action: string) {
    super(`Permission denied: ${action} on ${resource}`, "FORBIDDEN", 403);
    this.name = "AuthorizationError";
    this.resource = resource;
    this.action = action;
  }
}

/**
 * Thrown when registration is attempted without a valid invitation
 */
export class InvitationRequiredError extends AuthError {
  constructor(message = "An invitation is required to register") {
    super(message, "INVITATION_REQUIRED", 403);
    this.name = "InvitationRequiredError";
  }
}

/**
 * Thrown when invitation is invalid or expired
 */
export class InvalidInvitationError extends AuthError {
  constructor(message = "Invalid or expired invitation") {
    super(message, "INVALID_INVITATION", 400);
    this.name = "InvalidInvitationError";
  }
}

/**
 * Thrown when user tries to access another organization's data
 */
export class OrganizationAccessError extends AuthError {
  constructor(message = "Access to this organization is denied") {
    super(message, "ORG_ACCESS_DENIED", 403);
    this.name = "OrganizationAccessError";
  }
}

/**
 * Type guard to check if an error is an AuthError
 */
export function isAuthError(error: unknown): error is AuthError {
  return error instanceof AuthError;
}

/**
 * Convert any error to a structured response object
 */
export function toAuthErrorResponse(error: unknown): {
  error: string;
  code: string;
  statusCode: number;
} {
  if (isAuthError(error)) {
    return {
      error: error.message,
      code: error.code,
      statusCode: error.statusCode,
    };
  }

  // Unknown error - don't expose details
  return {
    error: "An unexpected error occurred",
    code: "INTERNAL_ERROR",
    statusCode: 500,
  };
}
