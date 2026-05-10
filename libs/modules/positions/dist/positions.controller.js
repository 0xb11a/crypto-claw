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
var __param =
  (this && this.__param) ||
  function (paramIndex, decorator) {
    return function (target, key) {
      decorator(target, key, paramIndex);
    };
  };
Object.defineProperty(exports, '__esModule', { value: true });
exports.PositionsController = void 0;
const common_1 = require('@nestjs/common');
const swagger_1 = require('@nestjs/swagger');
const auth_1 = require('@cclaw/auth');
const audit_1 = require('@cclaw/audit');
const positions_service_js_1 = require('./positions.service.js');
const create_position_dto_js_1 = require('./dto/create-position.dto.js');
const update_position_dto_js_1 = require('./dto/update-position.dto.js');
const close_position_dto_js_1 = require('./dto/close-position.dto.js');
const position_list_query_dto_js_1 = require('./dto/position-list-query.dto.js');
/**
 * Positions controller — HTTP surface for the positions module (SPEC §5).
 *
 * Routes:
 *   GET    /v1/positions          - list (agent + dashboard)
 *   GET    /v1/positions/:id      - get by id (agent + dashboard)
 *   POST   /v1/positions          - create (agent only) @Audited
 *   PATCH  /v1/positions/:id      - update (agent only) @Audited
 *   POST   /v1/positions/:id/close - close (agent only) @Audited
 *   DELETE /v1/positions/:id      - delete (agent only) @Audited
 *
 * Every handler has @Roles(…) (SPEC §4 #3).
 * Every non-GET handler has @Audited() (SPEC §9.5, ADR-0018).
 */
let PositionsController = class PositionsController {
  svc;
  constructor(svc) {
    this.svc = svc;
  }
  list(query) {
    return this.svc.list(query);
  }
  getById(id, mode) {
    return this.svc.getById(id, mode ?? 'real');
  }
  create(dto) {
    return this.svc.create(dto);
  }
  update(id, dto, mode) {
    return this.svc.update(id, dto, mode ?? 'real');
  }
  close(id, dto, mode) {
    return this.svc.close(id, dto, mode ?? 'real');
  }
  async delete(id, mode) {
    await this.svc.delete(id, mode ?? 'real');
  }
};
exports.PositionsController = PositionsController;
__decorate(
  [
    (0, common_1.Get)(),
    (0, auth_1.Roles)('agent', 'dashboard'),
    (0, swagger_1.ApiOperation)({ summary: 'List positions' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'List of positions' }),
    __param(0, (0, common_1.Query)()),
    __metadata('design:type', Function),
    __metadata('design:paramtypes', [position_list_query_dto_js_1.PositionListQueryDto]),
    __metadata('design:returntype', Promise),
  ],
  PositionsController.prototype,
  'list',
  null,
);
__decorate(
  [
    (0, common_1.Get)(':id'),
    (0, auth_1.Roles)('agent', 'dashboard'),
    (0, swagger_1.ApiOperation)({ summary: 'Get a position by ID' }),
    (0, swagger_1.ApiParam)({ name: 'id', description: 'Position ID' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Position found' }),
    (0, swagger_1.ApiResponse)({ status: 404, description: 'Position not found' }),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Query)('mode')),
    __metadata('design:type', Function),
    __metadata('design:paramtypes', [String, String]),
    __metadata('design:returntype', Promise),
  ],
  PositionsController.prototype,
  'getById',
  null,
);
__decorate(
  [
    (0, common_1.Post)(),
    (0, auth_1.Roles)('agent'),
    (0, audit_1.Audited)(),
    (0, common_1.HttpCode)(common_1.HttpStatus.CREATED),
    (0, swagger_1.ApiOperation)({ summary: 'Create a new position' }),
    (0, swagger_1.ApiResponse)({ status: 201, description: 'Position created' }),
    (0, swagger_1.ApiResponse)({ status: 400, description: 'Validation error' }),
    __param(0, (0, common_1.Body)()),
    __metadata('design:type', Function),
    __metadata('design:paramtypes', [create_position_dto_js_1.CreatePositionDto]),
    __metadata('design:returntype', Promise),
  ],
  PositionsController.prototype,
  'create',
  null,
);
__decorate(
  [
    (0, common_1.Patch)(':id'),
    (0, auth_1.Roles)('agent'),
    (0, audit_1.Audited)(),
    (0, swagger_1.ApiOperation)({ summary: 'Update a position' }),
    (0, swagger_1.ApiParam)({ name: 'id', description: 'Position ID' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Position updated' }),
    (0, swagger_1.ApiResponse)({ status: 404, description: 'Position not found' }),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Query)('mode')),
    __metadata('design:type', Function),
    __metadata('design:paramtypes', [String, update_position_dto_js_1.UpdatePositionDto, String]),
    __metadata('design:returntype', Promise),
  ],
  PositionsController.prototype,
  'update',
  null,
);
__decorate(
  [
    (0, common_1.Post)(':id/close'),
    (0, auth_1.Roles)('agent'),
    (0, audit_1.Audited)(),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    (0, swagger_1.ApiOperation)({ summary: 'Close a position' }),
    (0, swagger_1.ApiParam)({ name: 'id', description: 'Position ID' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Position closed' }),
    (0, swagger_1.ApiResponse)({ status: 404, description: 'Position not found' }),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Query)('mode')),
    __metadata('design:type', Function),
    __metadata('design:paramtypes', [String, close_position_dto_js_1.ClosePositionDto, String]),
    __metadata('design:returntype', Promise),
  ],
  PositionsController.prototype,
  'close',
  null,
);
__decorate(
  [
    (0, common_1.Delete)(':id'),
    (0, auth_1.Roles)('agent'),
    (0, audit_1.Audited)(),
    (0, common_1.HttpCode)(common_1.HttpStatus.NO_CONTENT),
    (0, swagger_1.ApiOperation)({ summary: 'Delete a position' }),
    (0, swagger_1.ApiParam)({ name: 'id', description: 'Position ID' }),
    (0, swagger_1.ApiResponse)({ status: 204, description: 'Position deleted' }),
    (0, swagger_1.ApiResponse)({ status: 404, description: 'Position not found' }),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Query)('mode')),
    __metadata('design:type', Function),
    __metadata('design:paramtypes', [String, String]),
    __metadata('design:returntype', Promise),
  ],
  PositionsController.prototype,
  'delete',
  null,
);
exports.PositionsController = PositionsController = __decorate(
  [
    (0, swagger_1.ApiTags)('positions'),
    (0, swagger_1.ApiBearerAuth)(),
    (0, common_1.Controller)('positions'),
    __metadata('design:paramtypes', [positions_service_js_1.PositionsService]),
  ],
  PositionsController,
);
//# sourceMappingURL=positions.controller.js.map
