/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type UpdateWalletScoreDto = {
  retry_count?: number;
  score?: number;
  score_breakdown?: Record<string, any>;
  score_error?: string;
  /**
   * proposed | scoring | scored | failed
   */
  status?: string;
  type?: string;
};
