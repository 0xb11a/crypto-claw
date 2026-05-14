/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { BaseHttpRequest } from './core/BaseHttpRequest';
import type { OpenAPIConfig } from './core/OpenAPI';
import { FetchHttpRequest } from './core/FetchHttpRequest';
import { AgentLogsService } from './services/AgentLogsService';
import { AlertsService } from './services/AlertsService';
import { AnalysisCacheService } from './services/AnalysisCacheService';
import { ContractsService } from './services/ContractsService';
import { HealthService } from './services/HealthService';
import { HeartbeatService } from './services/HeartbeatService';
import { LiquidityService } from './services/LiquidityService';
import { OrdersService } from './services/OrdersService';
import { PositionsService } from './services/PositionsService';
import { ReceiptsService } from './services/ReceiptsService';
import { SystemService } from './services/SystemService';
import { WalletsService } from './services/WalletsService';
import { WatchlistService } from './services/WatchlistService';
type HttpRequestConstructor = new (config: OpenAPIConfig) => BaseHttpRequest;
export class CClawClient {
  public readonly agentLogs: AgentLogsService;
  public readonly alerts: AlertsService;
  public readonly analysisCache: AnalysisCacheService;
  public readonly contracts: ContractsService;
  public readonly health: HealthService;
  public readonly heartbeat: HeartbeatService;
  public readonly liquidity: LiquidityService;
  public readonly orders: OrdersService;
  public readonly positions: PositionsService;
  public readonly receipts: ReceiptsService;
  public readonly system: SystemService;
  public readonly wallets: WalletsService;
  public readonly watchlist: WatchlistService;
  public readonly request: BaseHttpRequest;
  constructor(config?: Partial<OpenAPIConfig>, HttpRequest: HttpRequestConstructor = FetchHttpRequest) {
    this.request = new HttpRequest({
      BASE: config?.BASE ?? '',
      VERSION: config?.VERSION ?? '1.0',
      WITH_CREDENTIALS: config?.WITH_CREDENTIALS ?? false,
      CREDENTIALS: config?.CREDENTIALS ?? 'include',
      TOKEN: config?.TOKEN,
      USERNAME: config?.USERNAME,
      PASSWORD: config?.PASSWORD,
      HEADERS: config?.HEADERS,
      ENCODE_PATH: config?.ENCODE_PATH,
    });
    this.agentLogs = new AgentLogsService(this.request);
    this.alerts = new AlertsService(this.request);
    this.analysisCache = new AnalysisCacheService(this.request);
    this.contracts = new ContractsService(this.request);
    this.health = new HealthService(this.request);
    this.heartbeat = new HeartbeatService(this.request);
    this.liquidity = new LiquidityService(this.request);
    this.orders = new OrdersService(this.request);
    this.positions = new PositionsService(this.request);
    this.receipts = new ReceiptsService(this.request);
    this.system = new SystemService(this.request);
    this.wallets = new WalletsService(this.request);
    this.watchlist = new WatchlistService(this.request);
  }
}
