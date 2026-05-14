import { Injectable } from '@nestjs/common';
import { PrismaService } from '@cclaw/prisma';
// Type-only import from @prisma/client — allowed only in repository files.
// eslint-disable-next-line no-restricted-imports
import type { ContractSnapshot } from '@prisma/client';
import type { AddContractSnapshotDto } from './dto/add-contract-snapshot.dto.js';
import type { ContractSnapshotQueryDto } from './dto/contract-snapshot-query.dto.js';
import type { ContractSnapshotResponseDto } from './dto/contract-snapshot-response.dto.js';

/**
 * Contracts repository — the only place Prisma queries for contract_snapshots live.
 *
 * Parity notes:
 * - safety_data stored as raw String, never parsed (bug-for-bug parity with
 *   db-query.js add-contract-snapshot which stores --json value verbatim).
 * - checked_at is omitted on create so SQLite DEFAULT (datetime('now')) fires,
 *   producing "YYYY-MM-DD HH:MM:SS" format.
 * - Query ordering matches legacy: ORDER BY checked_at DESC.
 */
@Injectable()
export class ContractsRepository {
  constructor(private readonly prisma: PrismaService) {}

  private map(row: ContractSnapshot): ContractSnapshotResponseDto {
    return {
      id: row.id,
      address: row.address,
      chain: row.chain,
      safety_data: row.safetyData,
      checked_at: row.checkedAt ?? null,
    };
  }

  /**
   * Add a new contract safety snapshot.
   *
   * checked_at intentionally omitted so SQLite DEFAULT (datetime('now')) fires.
   */
  async add(dto: AddContractSnapshotDto): Promise<ContractSnapshotResponseDto> {
    const row = await this.prisma.contractSnapshot.create({
      data: {
        address: dto.address,
        chain: dto.chain,
        safetyData: dto.json,
        // checkedAt deliberately omitted — let SQLite DEFAULT fire
      },
    });
    return this.map(row);
  }

  /**
   * List recent snapshots for a contract, ordered newest first.
   * Matches legacy: ORDER BY checked_at DESC LIMIT ?
   */
  async findByAddressChain(query: ContractSnapshotQueryDto): Promise<ContractSnapshotResponseDto[]> {
    const limit = Math.min(query.limit ?? 5, 100);
    const rows = await this.prisma.contractSnapshot.findMany({
      where: { address: query.address, chain: query.chain },
      orderBy: { checkedAt: 'desc' },
      take: limit,
    });
    return rows.map((r) => this.map(r));
  }
}
