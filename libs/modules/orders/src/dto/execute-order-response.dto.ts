/**
 * Response DTO for POST /v1/orders/:id/execute
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ExecuteOrderAcceptedDto {
  /**
   * BullMQ job ID. Null in paper mode (no BullMQ enqueue).
   */
  @ApiPropertyOptional({ description: 'BullMQ job ID (null in paper mode)', nullable: true })
  jobId!: string | null;

  /** The order ID being executed. */
  @ApiProperty({ description: 'Order ID' })
  orderId!: string;

  /**
   * Execution status:
   * - 'enqueued'       — real mode: job queued, executor will run async
   * - 'paper_executed' — paper mode: order simulated synchronously
   */
  @ApiProperty({
    description: 'Execution result status',
    enum: ['enqueued', 'paper_executed'],
  })
  status!: 'enqueued' | 'paper_executed';
}
