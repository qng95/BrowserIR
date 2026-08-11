/** Maximum CSS-area adjusted by device scale for one capture. */
export const MAX_CAPTURE_PHYSICAL_PIXELS = 8_294_400;

/** Maximum encoded image bytes returned by the core or MCP service. */
export const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;

/** Hard cross-layer bounds for the opt-in arbitrary page-code escape hatch. */
export const MAX_UNSAFE_EVALUATE_EXPRESSION_CHARACTERS = 16_384;
export const MAX_UNSAFE_EVALUATE_EXPRESSION_BYTES = 32 * 1024;
export const MAX_UNSAFE_EVALUATE_TIMEOUT_MS = 5_000;
export const MAX_UNSAFE_EVALUATE_OUTPUT_BYTES = 64 * 1024;
