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
exports.PositionsService = void 0;
const common_1 = require('@nestjs/common');
const positions_repository_js_1 = require('./positions.repository.js');
/**
 * Positions service — domain logic layer.
 *
 * Services call repositories; they do not write Prisma queries directly.
 * Paper-mode routing is handled inside the repository; the service passes
 * mode through and handles domain-level errors.
 */
let PositionsService = class PositionsService {
  repo;
  constructor(repo) {
    this.repo = repo;
  }
  async list(query) {
    const limit = Math.min(query.limit ?? 50, 200);
    const [data, total] = await Promise.all([this.repo.findMany(query), this.repo.count(query)]);
    const lastId = data.length > 0 ? data[data.length - 1]?.id : undefined;
    return {
      data,
      pagination: {
        total,
        limit,
        cursor: lastId,
        hasMore: data.length === limit,
      },
    };
  }
  async getById(id, mode = 'real') {
    return this.repo.findById(id, mode);
  }
  async create(dto) {
    return this.repo.create(dto);
  }
  async update(id, dto, mode = 'real') {
    // Verify the position exists before patching (throws 404 if not)
    await this.repo.findById(id, mode);
    return this.repo.update(id, dto, mode);
  }
  async close(id, dto, mode = 'real') {
    const pos = await this.repo.findById(id, mode);
    if (pos.status === 'closed') {
      throw new common_1.NotFoundException(`Position ${id} is already closed`);
    }
    return this.repo.closePosition(id, dto, mode);
  }
  async delete(id, mode = 'real') {
    await this.repo.findById(id, mode); // throws 404 if not found
    await this.repo.delete(id, mode);
  }
};
exports.PositionsService = PositionsService;
exports.PositionsService = PositionsService = __decorate(
  [(0, common_1.Injectable)(), __metadata('design:paramtypes', [positions_repository_js_1.PositionsRepository])],
  PositionsService,
);
//# sourceMappingURL=positions.service.js.map
