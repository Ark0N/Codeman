/**
 * @fileoverview Token validation utilities.
 *
 * Centralizes token count validation logic used across the codebase.
 * Claude's context window is ~200k tokens, so 500k is a generous upper bound.
 *
 * @module utils/token-validation
 */

/**
 * Maximum tokens allowed per session.
 * Claude's context is ~200k, so 500k is a safe upper bound for validation.
 */
export const MAX_SESSION_TOKENS = 500_000;

/**
 * Validates token counts are within acceptable bounds.
 * Rejects negative values and values exceeding MAX_SESSION_TOKENS.
 *
 * @param inputTokens - Input token count to validate
 * @param outputTokens - Output token count to validate
 * @returns Object with isValid flag and optional error reason
 */
export function validateTokenCounts(inputTokens: number, outputTokens: number): { isValid: boolean; reason?: string } {
  if (inputTokens < 0 || outputTokens < 0) {
    return {
      isValid: false,
      reason: `Negative token values: input=${inputTokens}, output=${outputTokens}`,
    };
  }

  if (inputTokens > MAX_SESSION_TOKENS || outputTokens > MAX_SESSION_TOKENS) {
    return {
      isValid: false,
      reason: `Token values exceed maximum (${MAX_SESSION_TOKENS}): input=${inputTokens}, output=${outputTokens}`,
    };
  }

  return { isValid: true };
}

/**
 * Validates token counts and cost for restoration/persistence.
 * Returns true if all values are valid.
 *
 * @param inputTokens - Input token count
 * @param outputTokens - Output token count
 * @param cost - Cost value (must be non-negative)
 * @returns Object with isValid flag and optional error reason
 */
export function validateTokensAndCost(
  inputTokens: number,
  outputTokens: number,
  cost: number
): { isValid: boolean; reason?: string } {
  const tokenValidation = validateTokenCounts(inputTokens, outputTokens);
  if (!tokenValidation.isValid) {
    return tokenValidation;
  }

  if (cost < 0) {
    return {
      isValid: false,
      reason: `Negative cost value: ${cost}`,
    };
  }

  return { isValid: true };
}
