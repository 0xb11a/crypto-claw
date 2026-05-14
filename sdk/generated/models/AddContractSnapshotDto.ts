/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type AddContractSnapshotDto = {
  /**
   * Contract address
   */
  address: string;
  /**
   * Chain identifier
   */
  chain: string;
  /**
   * Raw JSON string of safety check data (max 65KB)
   */
  json: string;
};
