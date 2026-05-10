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
exports.PositionListResponseDto = exports.PositionResponseDto = void 0;
const swagger_1 = require('@nestjs/swagger');
/**
 * Response shape for a single position.
 *
 * JSON-string columns (take_profit_levels, tp_levels_hit) are parsed
 * by the repository layer and returned as typed arrays here.
 */
class PositionResponseDto {
  id;
  symbol;
  name;
  address;
  chain;
  tier;
  entry_price;
  current_price;
  quantity;
  value_usd;
  percent_of_portfolio;
  entry_date;
  stop_loss;
  /** Parsed take-profit levels array. */
  take_profit_levels;
  narrative;
  status;
  notes;
  onchain_balance;
  last_synced_at;
  exit_price;
  exit_date;
  pnl_percent;
  pnl_usd;
  exit_reason;
  max_price_since_entry;
  trailing_stop_pct;
  trailing_stop_active;
  /** Parsed TP levels hit array. */
  tp_levels_hit;
  created_at;
  updated_at;
  /** Whether this is a paper position. */
  mode;
}
exports.PositionResponseDto = PositionResponseDto;
__decorate(
  [(0, swagger_1.ApiProperty)(), __metadata('design:type', String)],
  PositionResponseDto.prototype,
  'id',
  void 0,
);
__decorate(
  [(0, swagger_1.ApiProperty)(), __metadata('design:type', String)],
  PositionResponseDto.prototype,
  'symbol',
  void 0,
);
__decorate(
  [(0, swagger_1.ApiPropertyOptional)(), __metadata('design:type', Object)],
  PositionResponseDto.prototype,
  'name',
  void 0,
);
__decorate(
  [(0, swagger_1.ApiProperty)(), __metadata('design:type', String)],
  PositionResponseDto.prototype,
  'address',
  void 0,
);
__decorate(
  [(0, swagger_1.ApiProperty)(), __metadata('design:type', String)],
  PositionResponseDto.prototype,
  'chain',
  void 0,
);
__decorate(
  [(0, swagger_1.ApiProperty)(), __metadata('design:type', String)],
  PositionResponseDto.prototype,
  'tier',
  void 0,
);
__decorate(
  [(0, swagger_1.ApiProperty)(), __metadata('design:type', Number)],
  PositionResponseDto.prototype,
  'entry_price',
  void 0,
);
__decorate(
  [(0, swagger_1.ApiPropertyOptional)(), __metadata('design:type', Object)],
  PositionResponseDto.prototype,
  'current_price',
  void 0,
);
__decorate(
  [(0, swagger_1.ApiProperty)(), __metadata('design:type', Number)],
  PositionResponseDto.prototype,
  'quantity',
  void 0,
);
__decorate(
  [(0, swagger_1.ApiPropertyOptional)(), __metadata('design:type', Object)],
  PositionResponseDto.prototype,
  'value_usd',
  void 0,
);
__decorate(
  [(0, swagger_1.ApiPropertyOptional)(), __metadata('design:type', Object)],
  PositionResponseDto.prototype,
  'percent_of_portfolio',
  void 0,
);
__decorate(
  [(0, swagger_1.ApiProperty)(), __metadata('design:type', String)],
  PositionResponseDto.prototype,
  'entry_date',
  void 0,
);
__decorate(
  [(0, swagger_1.ApiProperty)(), __metadata('design:type', Number)],
  PositionResponseDto.prototype,
  'stop_loss',
  void 0,
);
__decorate(
  [(0, swagger_1.ApiProperty)({ type: [Number] }), __metadata('design:type', Array)],
  PositionResponseDto.prototype,
  'take_profit_levels',
  void 0,
);
__decorate(
  [(0, swagger_1.ApiPropertyOptional)(), __metadata('design:type', Object)],
  PositionResponseDto.prototype,
  'narrative',
  void 0,
);
__decorate(
  [(0, swagger_1.ApiProperty)(), __metadata('design:type', String)],
  PositionResponseDto.prototype,
  'status',
  void 0,
);
__decorate(
  [(0, swagger_1.ApiPropertyOptional)(), __metadata('design:type', Object)],
  PositionResponseDto.prototype,
  'notes',
  void 0,
);
__decorate(
  [(0, swagger_1.ApiPropertyOptional)(), __metadata('design:type', Object)],
  PositionResponseDto.prototype,
  'onchain_balance',
  void 0,
);
__decorate(
  [(0, swagger_1.ApiPropertyOptional)(), __metadata('design:type', Object)],
  PositionResponseDto.prototype,
  'last_synced_at',
  void 0,
);
__decorate(
  [(0, swagger_1.ApiPropertyOptional)(), __metadata('design:type', Object)],
  PositionResponseDto.prototype,
  'exit_price',
  void 0,
);
__decorate(
  [(0, swagger_1.ApiPropertyOptional)(), __metadata('design:type', Object)],
  PositionResponseDto.prototype,
  'exit_date',
  void 0,
);
__decorate(
  [(0, swagger_1.ApiPropertyOptional)(), __metadata('design:type', Object)],
  PositionResponseDto.prototype,
  'pnl_percent',
  void 0,
);
__decorate(
  [(0, swagger_1.ApiPropertyOptional)(), __metadata('design:type', Object)],
  PositionResponseDto.prototype,
  'pnl_usd',
  void 0,
);
__decorate(
  [(0, swagger_1.ApiPropertyOptional)(), __metadata('design:type', Object)],
  PositionResponseDto.prototype,
  'exit_reason',
  void 0,
);
__decorate(
  [(0, swagger_1.ApiPropertyOptional)(), __metadata('design:type', Object)],
  PositionResponseDto.prototype,
  'max_price_since_entry',
  void 0,
);
__decorate(
  [(0, swagger_1.ApiPropertyOptional)(), __metadata('design:type', Object)],
  PositionResponseDto.prototype,
  'trailing_stop_pct',
  void 0,
);
__decorate(
  [(0, swagger_1.ApiProperty)(), __metadata('design:type', Number)],
  PositionResponseDto.prototype,
  'trailing_stop_active',
  void 0,
);
__decorate(
  [(0, swagger_1.ApiProperty)({ type: [Number] }), __metadata('design:type', Array)],
  PositionResponseDto.prototype,
  'tp_levels_hit',
  void 0,
);
__decorate(
  [(0, swagger_1.ApiPropertyOptional)(), __metadata('design:type', Object)],
  PositionResponseDto.prototype,
  'created_at',
  void 0,
);
__decorate(
  [(0, swagger_1.ApiPropertyOptional)(), __metadata('design:type', Object)],
  PositionResponseDto.prototype,
  'updated_at',
  void 0,
);
__decorate(
  [(0, swagger_1.ApiProperty)(), __metadata('design:type', String)],
  PositionResponseDto.prototype,
  'mode',
  void 0,
);
/** Paginated list response. */
class PositionListResponseDto {
  data;
  pagination;
}
exports.PositionListResponseDto = PositionListResponseDto;
__decorate(
  [(0, swagger_1.ApiProperty)({ type: [PositionResponseDto] }), __metadata('design:type', Array)],
  PositionListResponseDto.prototype,
  'data',
  void 0,
);
__decorate(
  [(0, swagger_1.ApiProperty)(), __metadata('design:type', Object)],
  PositionListResponseDto.prototype,
  'pagination',
  void 0,
);
//# sourceMappingURL=position-response.dto.js.map
