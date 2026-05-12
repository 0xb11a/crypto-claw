/**
 * DTO for POST /v1/orders/:id/execute
 *
 * The execute body is intentionally empty — the order ID comes from the URL
 * param. No additional fields are needed for basic execution in P1c-i.
 * P1c-ii may add an `override_slippage_bps` field here.
 */
import { ApiExtraModels } from '@nestjs/swagger';

/**
 * Execute order request body — empty in P1c-i.
 *
 * We define this as a concrete class (not an interface) so class-validator's
 * ValidationPipe can process it, and so Swagger can document the empty body.
 */
@ApiExtraModels()
export class ExecuteOrderDto {}
