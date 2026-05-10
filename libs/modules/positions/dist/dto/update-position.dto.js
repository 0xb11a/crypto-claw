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
exports.UpdatePositionDto = void 0;
const class_validator_1 = require('class-validator');
const swagger_1 = require('@nestjs/swagger');
const position_list_query_dto_js_1 = require('./position-list-query.dto.js');
/** Request body for PATCH /v1/positions/:id. All fields optional. */
class UpdatePositionDto {
  current_price;
  quantity;
  value_usd;
  stop_loss;
  take_profit_levels;
  status;
  notes;
  narrative;
  trailing_stop_pct;
  max_price_since_entry;
  tp_levels_hit;
  onchain_balance;
  last_synced_at;
}
exports.UpdatePositionDto = UpdatePositionDto;
__decorate(
  [
    (0, swagger_1.ApiPropertyOptional)({ description: 'Updated current price' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsNumber)(),
    (0, class_validator_1.Min)(0),
    __metadata('design:type', Number),
  ],
  UpdatePositionDto.prototype,
  'current_price',
  void 0,
);
__decorate(
  [
    (0, swagger_1.ApiPropertyOptional)({ description: 'Updated quantity' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsNumber)(),
    (0, class_validator_1.Min)(0),
    __metadata('design:type', Number),
  ],
  UpdatePositionDto.prototype,
  'quantity',
  void 0,
);
__decorate(
  [
    (0, swagger_1.ApiPropertyOptional)({ description: 'Updated value in USD' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsNumber)(),
    (0, class_validator_1.Min)(0),
    __metadata('design:type', Number),
  ],
  UpdatePositionDto.prototype,
  'value_usd',
  void 0,
);
__decorate(
  [
    (0, swagger_1.ApiPropertyOptional)({ description: 'Updated stop-loss price' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsNumber)(),
    (0, class_validator_1.Min)(0),
    __metadata('design:type', Number),
  ],
  UpdatePositionDto.prototype,
  'stop_loss',
  void 0,
);
__decorate(
  [
    (0, swagger_1.ApiPropertyOptional)({
      description: 'Updated take-profit levels (array of numbers)',
      type: [Number],
    }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.IsNumber)({}, { each: true }),
    __metadata('design:type', Array),
  ],
  UpdatePositionDto.prototype,
  'take_profit_levels',
  void 0,
);
__decorate(
  [
    (0, swagger_1.ApiPropertyOptional)({ enum: position_list_query_dto_js_1.POSITION_STATUSES }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsIn)(position_list_query_dto_js_1.POSITION_STATUSES),
    __metadata('design:type', String),
  ],
  UpdatePositionDto.prototype,
  'status',
  void 0,
);
__decorate(
  [
    (0, swagger_1.ApiPropertyOptional)(),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata('design:type', String),
  ],
  UpdatePositionDto.prototype,
  'notes',
  void 0,
);
__decorate(
  [
    (0, swagger_1.ApiPropertyOptional)(),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata('design:type', String),
  ],
  UpdatePositionDto.prototype,
  'narrative',
  void 0,
);
__decorate(
  [
    (0, swagger_1.ApiPropertyOptional)({ description: 'Trailing stop percentage (0–100)' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsNumber)(),
    (0, class_validator_1.Min)(0),
    __metadata('design:type', Number),
  ],
  UpdatePositionDto.prototype,
  'trailing_stop_pct',
  void 0,
);
__decorate(
  [
    (0, swagger_1.ApiPropertyOptional)({ description: 'Max price observed since entry (for trailing stop)' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsNumber)(),
    (0, class_validator_1.Min)(0),
    __metadata('design:type', Number),
  ],
  UpdatePositionDto.prototype,
  'max_price_since_entry',
  void 0,
);
__decorate(
  [
    (0, swagger_1.ApiPropertyOptional)({
      description: 'TP levels already hit (JSON array of booleans/indices)',
      type: [Number],
    }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsArray)(),
    __metadata('design:type', Array),
  ],
  UpdatePositionDto.prototype,
  'tp_levels_hit',
  void 0,
);
__decorate(
  [
    (0, swagger_1.ApiPropertyOptional)({ description: 'On-chain balance (synced from chain)' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsNumber)(),
    (0, class_validator_1.Min)(0),
    __metadata('design:type', Number),
  ],
  UpdatePositionDto.prototype,
  'onchain_balance',
  void 0,
);
__decorate(
  [
    (0, swagger_1.ApiPropertyOptional)({ description: 'Timestamp of last on-chain sync' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata('design:type', String),
  ],
  UpdatePositionDto.prototype,
  'last_synced_at',
  void 0,
);
//# sourceMappingURL=update-position.dto.js.map
