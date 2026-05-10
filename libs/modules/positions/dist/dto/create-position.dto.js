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
exports.CreatePositionDto = exports.POSITION_TIERS = void 0;
const class_validator_1 = require('class-validator');
const swagger_1 = require('@nestjs/swagger');
exports.POSITION_TIERS = ['base', 'conviction', 'moonshot'];
/**
 * Request body for POST /v1/positions.
 *
 * @note take_profit_levels is validated as an array of numbers here;
 * the repository layer serialises it to a JSON string before writing to SQLite
 * to maintain parity with the legacy db-query.js behaviour (OPEN-5).
 */
class CreatePositionDto {
  symbol;
  name;
  address;
  chain;
  tier;
  entry_price;
  quantity;
  stop_loss;
  take_profit_levels;
  entry_date;
  narrative;
  notes;
  mode;
}
exports.CreatePositionDto = CreatePositionDto;
__decorate(
  [
    (0, swagger_1.ApiProperty)({ description: 'Token symbol', example: 'ETH' }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    __metadata('design:type', String),
  ],
  CreatePositionDto.prototype,
  'symbol',
  void 0,
);
__decorate(
  [
    (0, swagger_1.ApiPropertyOptional)({ description: 'Token name', example: 'Ethereum' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata('design:type', String),
  ],
  CreatePositionDto.prototype,
  'name',
  void 0,
);
__decorate(
  [
    (0, swagger_1.ApiProperty)({
      description: 'Token contract address',
      example: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    __metadata('design:type', String),
  ],
  CreatePositionDto.prototype,
  'address',
  void 0,
);
__decorate(
  [
    (0, swagger_1.ApiProperty)({ description: 'Chain identifier', example: 'base' }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    __metadata('design:type', String),
  ],
  CreatePositionDto.prototype,
  'chain',
  void 0,
);
__decorate(
  [
    (0, swagger_1.ApiProperty)({ enum: exports.POSITION_TIERS, description: 'Position tier' }),
    (0, class_validator_1.IsIn)(exports.POSITION_TIERS),
    __metadata('design:type', String),
  ],
  CreatePositionDto.prototype,
  'tier',
  void 0,
);
__decorate(
  [
    (0, swagger_1.ApiProperty)({ description: 'Entry price in USD', example: 2000.0 }),
    (0, class_validator_1.IsNumber)(),
    (0, class_validator_1.Min)(0),
    __metadata('design:type', Number),
  ],
  CreatePositionDto.prototype,
  'entry_price',
  void 0,
);
__decorate(
  [
    (0, swagger_1.ApiProperty)({ description: 'Token quantity', example: 0.5 }),
    (0, class_validator_1.IsNumber)(),
    (0, class_validator_1.Min)(0),
    __metadata('design:type', Number),
  ],
  CreatePositionDto.prototype,
  'quantity',
  void 0,
);
__decorate(
  [
    (0, swagger_1.ApiProperty)({ description: 'Stop-loss price in USD', example: 1600.0 }),
    (0, class_validator_1.IsNumber)(),
    (0, class_validator_1.Min)(0),
    __metadata('design:type', Number),
  ],
  CreatePositionDto.prototype,
  'stop_loss',
  void 0,
);
__decorate(
  [
    (0, swagger_1.ApiProperty)({
      description: 'Take-profit price levels (JSON array of numbers)',
      type: [Number],
      example: [2500, 3000, 4000],
    }),
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.ArrayMinSize)(1),
    (0, class_validator_1.IsNumber)({}, { each: true }),
    __metadata('design:type', Array),
  ],
  CreatePositionDto.prototype,
  'take_profit_levels',
  void 0,
);
__decorate(
  [
    (0, swagger_1.ApiPropertyOptional)({ description: 'Entry date (ISO date string)', example: '2026-05-10' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata('design:type', String),
  ],
  CreatePositionDto.prototype,
  'entry_date',
  void 0,
);
__decorate(
  [
    (0, swagger_1.ApiPropertyOptional)({ description: 'Narrative tag', example: 'defi' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata('design:type', String),
  ],
  CreatePositionDto.prototype,
  'narrative',
  void 0,
);
__decorate(
  [
    (0, swagger_1.ApiPropertyOptional)({ description: 'Notes' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata('design:type', String),
  ],
  CreatePositionDto.prototype,
  'notes',
  void 0,
);
__decorate(
  [
    (0, swagger_1.ApiPropertyOptional)({ description: 'Portfolio mode (default: real)', enum: ['real', 'paper'] }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsIn)(['real', 'paper']),
    __metadata('design:type', String),
  ],
  CreatePositionDto.prototype,
  'mode',
  void 0,
);
//# sourceMappingURL=create-position.dto.js.map
