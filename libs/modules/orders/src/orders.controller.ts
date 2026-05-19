import { Controller, Get, Post, Param, Body, Query, HttpCode, HttpStatus, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiParam } from '@nestjs/swagger';
import { Roles, Identities } from '@cclaw/auth';
import { Audited } from '@cclaw/audit';
import { OrdersService } from './orders.service.js';
import type { AuthenticatedUser } from '@cclaw/auth';
import { ProposeOrderDto } from './dto/propose-order.dto.js';
import { ApproveOrderDto, RejectOrderDto, CancelOrderDto, RetryOrderDto } from './dto/order-state-change.dto.js';
import { ExecuteOrderDto } from './dto/execute-order.dto.js';
import { OrderListQueryDto } from './dto/order-list-query.dto.js';
import type { OrderListResponseDto, OrderResponseDto } from './dto/order-response.dto.js';
import type { ExecuteOrderAcceptedDto } from './dto/execute-order-response.dto.js';

/**
 * Orders controller — HTTP surface for the orders module (SPEC §5).
 *
 * Routes:
 *   GET  /v1/orders                 - list (agent + dashboard)
 *   GET  /v1/orders/:id             - get by id (agent + dashboard)
 *   POST /v1/orders                 - propose (agent only) @Audited
 *   POST /v1/orders/:id/approve     - approve (agent only) @Audited
 *   POST /v1/orders/:id/reject      - reject (agent only) @Audited
 *   POST /v1/orders/:id/cancel      - cancel (agent only) @Audited
 *   POST /v1/orders/:id/retry       - retry (agent only) @Audited
 *   POST /v1/orders/:id/execute     - execute (agent only) @Audited — P1c-i
 *
 * Every handler has @Roles(…). Every non-GET has @Audited().
 */
@ApiTags('orders')
@ApiBearerAuth()
@Controller('orders')
export class OrdersController {
  constructor(private readonly svc: OrdersService) {}

  @Get()
  @Roles('agent', 'dashboard')
  @Identities('*')
  @ApiOperation({ summary: 'List orders' })
  @ApiResponse({ status: 200, description: 'List of orders' })
  list(@Query() query: OrderListQueryDto): Promise<OrderListResponseDto> {
    return this.svc.list(query);
  }

  @Get(':id')
  @Roles('agent', 'dashboard')
  @Identities('*')
  @ApiOperation({ summary: 'Get an order by ID' })
  @ApiParam({ name: 'id', description: 'Order ID' })
  @ApiResponse({ status: 200, description: 'Order found' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  getById(@Param('id') id: string): Promise<OrderResponseDto> {
    return this.svc.getById(id);
  }

  @Post()
  @Roles('agent')
  @Identities('RESEARCH', 'SENTINEL', 'LOOP')
  @Audited()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Propose a new order' })
  @ApiResponse({ status: 201, description: 'Order proposed' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({ status: 403, description: 'Identity-action mismatch (SENTINEL can only sell; RESEARCH can only buy)' })
  propose(@Body() dto: ProposeOrderDto, @Req() req: { user?: AuthenticatedUser }): Promise<OrderResponseDto> {
    // Pass identity to service for action-vs-identity assertion (plan Decision 8, P7 PR-C1).
    // The assertion is a forward-compat safety net: today all LLM-agent calls identify as LOOP
    // (§16.5 LLM-agent gap), so the RESEARCH/SENTINEL branches fire only after PR-B lands.
    return this.svc.propose(dto, req.user?.identity);
  }

  @Post(':id/approve')
  @Roles('agent')
  @Identities('RESEARCH', 'LOOP')
  @Audited()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve an order' })
  @ApiParam({ name: 'id', description: 'Order ID' })
  @ApiResponse({ status: 200, description: 'Order approved' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  @ApiResponse({ status: 409, description: 'Invalid state transition' })
  approve(@Param('id') id: string, @Body() dto: ApproveOrderDto): Promise<OrderResponseDto> {
    return this.svc.approve(id, dto);
  }

  @Post(':id/reject')
  @Roles('agent')
  @Identities('RESEARCH', 'LOOP')
  @Audited()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject an order' })
  @ApiParam({ name: 'id', description: 'Order ID' })
  @ApiResponse({ status: 200, description: 'Order rejected' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  @ApiResponse({ status: 409, description: 'Invalid state transition' })
  reject(@Param('id') id: string, @Body() dto: RejectOrderDto): Promise<OrderResponseDto> {
    return this.svc.reject(id, dto);
  }

  @Post(':id/cancel')
  @Roles('agent')
  @Identities('RESEARCH', 'SENTINEL', 'LOOP')
  @Audited()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel an order' })
  @ApiParam({ name: 'id', description: 'Order ID' })
  @ApiResponse({ status: 200, description: 'Order cancelled' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  @ApiResponse({ status: 409, description: 'Invalid state transition' })
  cancel(@Param('id') id: string, @Body() dto: CancelOrderDto): Promise<OrderResponseDto> {
    return this.svc.cancel(id, dto);
  }

  @Post(':id/retry')
  @Roles('agent')
  @Identities('RESEARCH', 'LOOP')
  @Audited()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Retry a failed order' })
  @ApiParam({ name: 'id', description: 'Order ID' })
  @ApiResponse({ status: 200, description: 'Order retried' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  @ApiResponse({ status: 409, description: 'Only failed orders can be retried' })
  retry(@Param('id') id: string, @Body() dto: RetryOrderDto): Promise<OrderResponseDto> {
    return this.svc.retry(id, dto);
  }

  @Post(':id/execute')
  @Roles('agent')
  @Identities('EXECUTOR', 'LOOP')
  @Audited()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Execute an approved order (enqueues BullMQ job in real mode; short-circuits in paper mode)',
  })
  @ApiParam({ name: 'id', description: 'Order ID' })
  @ApiResponse({ status: 202, description: 'Order execution enqueued (real mode) or completed (paper mode)' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  @ApiResponse({ status: 409, description: 'Order not in approved status' })
  execute(@Param('id') id: string, @Body() _dto: ExecuteOrderDto): Promise<ExecuteOrderAcceptedDto> {
    return this.svc.execute(id);
  }
}
