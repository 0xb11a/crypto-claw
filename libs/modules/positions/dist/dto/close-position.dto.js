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
exports.ClosePositionDto = void 0;
const class_validator_1 = require('class-validator');
const swagger_1 = require('@nestjs/swagger');
/** Request body for POST /v1/positions/:id/close. */
class ClosePositionDto {
  exit_price;
  exit_reason;
  pnl_percent;
  pnl_usd;
  exit_date;
}
exports.ClosePositionDto = ClosePositionDto;
__decorate(
  [
    (0, swagger_1.ApiProperty)({ description: 'Exit price in USD', example: 2500.0 }),
    (0, class_validator_1.IsNumber)(),
    (0, class_validator_1.Min)(0),
    __metadata('design:type', Number),
  ],
  ClosePositionDto.prototype,
  'exit_price',
  void 0,
);
__decorate(
  [
    (0, swagger_1.ApiPropertyOptional)({ description: 'Exit reason', example: 'take_profit' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata('design:type', String),
  ],
  ClosePositionDto.prototype,
  'exit_reason',
  void 0,
);
__decorate(
  [
    (0, swagger_1.ApiPropertyOptional)({ description: 'Final P&L percent' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsNumber)(),
    __metadata('design:type', Number),
  ],
  ClosePositionDto.prototype,
  'pnl_percent',
  void 0,
);
__decorate(
  [
    (0, swagger_1.ApiPropertyOptional)({ description: 'Final P&L in USD' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsNumber)(),
    __metadata('design:type', Number),
  ],
  ClosePositionDto.prototype,
  'pnl_usd',
  void 0,
);
__decorate(
  [
    (0, swagger_1.ApiPropertyOptional)({ description: 'Exit date (ISO date string)', example: '2026-05-10' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata('design:type', String),
  ],
  ClosePositionDto.prototype,
  'exit_date',
  void 0,
);
//# sourceMappingURL=close-position.dto.js.map
