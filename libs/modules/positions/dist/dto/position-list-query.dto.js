'use strict';
var __decorate =
  (this && this.__decorate) ||
  function (decorators, target, key, desc) {
    var c = arguments.length,
      r = c < 3 ? target : desc === null ? (desc = Object.getOwnPropertyDescriptor(target, key)) : desc,
      d;
    if (typeof Reflect === 'object' && typeof Reflect.decorate === 'function')
      r = Reflect.decorate(decorators, target, key, desc);
    else
      for (var i = decorators.length - 1; i >= 0; i--)
        if ((d = decorators[i])) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return (c > 3 && r && Object.defineProperty(target, key, r), r);
  };
var __metadata =
  (this && this.__metadata) ||
  function (k, v) {
    if (typeof Reflect === 'object' && typeof Reflect.metadata === 'function') return Reflect.metadata(k, v);
  };
Object.defineProperty(exports, '__esModule', { value: true });
exports.PositionListQueryDto = exports.POSITION_STATUSES = void 0;
const class_validator_1 = require('class-validator');
const class_transformer_1 = require('class-transformer');
const swagger_1 = require('@nestjs/swagger');
/** Valid position status values (mirrors legacy CHECK constraint). */
exports.POSITION_STATUSES = ['open', 'partial_exit', 'closed', 'pending_analysis', 'draft', 'pending_exit'];
/** Query parameters for GET /v1/positions (SPEC §5). */
class PositionListQueryDto {
  status;
  mode;
  symbol;
  chain;
  limit;
  cursor;
}
exports.PositionListQueryDto = PositionListQueryDto;
__decorate(
  [
    (0, swagger_1.ApiPropertyOptional)({ enum: exports.POSITION_STATUSES, description: 'Filter by position status' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsIn)(exports.POSITION_STATUSES),
    __metadata('design:type', String),
  ],
  PositionListQueryDto.prototype,
  'status',
  void 0,
);
__decorate(
  [
    (0, swagger_1.ApiPropertyOptional)({ enum: ['real', 'paper'], description: 'Portfolio mode (default: real)' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsIn)(['real', 'paper']),
    __metadata('design:type', String),
  ],
  PositionListQueryDto.prototype,
  'mode',
  void 0,
);
__decorate(
  [
    (0, swagger_1.ApiPropertyOptional)({ description: 'Filter by token symbol (case-insensitive)' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata('design:type', String),
  ],
  PositionListQueryDto.prototype,
  'symbol',
  void 0,
);
__decorate(
  [
    (0, swagger_1.ApiPropertyOptional)({ description: 'Filter by chain', example: 'base' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata('design:type', String),
  ],
  PositionListQueryDto.prototype,
  'chain',
  void 0,
);
__decorate(
  [
    (0, swagger_1.ApiPropertyOptional)({
      description: 'Maximum number of results (default 50, max 200)',
      minimum: 1,
      maximum: 200,
    }),
    (0, class_validator_1.IsOptional)(),
    (0, class_transformer_1.Type)(() => Number),
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(1),
    __metadata('design:type', Number),
  ],
  PositionListQueryDto.prototype,
  'limit',
  void 0,
);
__decorate(
  [
    (0, swagger_1.ApiPropertyOptional)({ description: 'Cursor for pagination (last position id)' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata('design:type', String),
  ],
  PositionListQueryDto.prototype,
  'cursor',
  void 0,
);
//# sourceMappingURL=position-list-query.dto.js.map
