/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { BaseHttpRequest } from './core/BaseHttpRequest';
import type { OpenAPIConfig } from './core/OpenAPI';
import { FetchHttpRequest } from './core/FetchHttpRequest';
import { HealthService } from './services/HealthService';
import { OrdersService } from './services/OrdersService';
import { PositionsService } from './services/PositionsService';
type HttpRequestConstructor = new (config: OpenAPIConfig) => BaseHttpRequest;
export class CClawClient {
  public readonly health: HealthService;
  public readonly orders: OrdersService;
  public readonly positions: PositionsService;
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
    this.health = new HealthService(this.request);
    this.orders = new OrdersService(this.request);
    this.positions = new PositionsService(this.request);
  }
}
