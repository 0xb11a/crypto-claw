import { Injectable } from '@nestjs/common';
import { ContractsRepository } from './contracts.repository.js';
import type { AddContractSnapshotDto } from './dto/add-contract-snapshot.dto.js';
import type { ContractSnapshotQueryDto } from './dto/contract-snapshot-query.dto.js';
import type { ContractSnapshotResponseDto } from './dto/contract-snapshot-response.dto.js';

/**
 * Contracts service — thin orchestration layer between the controller and repository.
 */
@Injectable()
export class ContractsService {
  constructor(private readonly repo: ContractsRepository) {}

  /** Add a contract safety snapshot. */
  add(dto: AddContractSnapshotDto): Promise<ContractSnapshotResponseDto> {
    return this.repo.add(dto);
  }

  /** List recent snapshots for a contract. */
  list(query: ContractSnapshotQueryDto): Promise<ContractSnapshotResponseDto[]> {
    return this.repo.findByAddressChain(query);
  }
}
