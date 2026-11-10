import { Response } from "express";

/**
 * Every successful response uses the same envelope so frontend clients
 * (React Query, mobile, etc.) can parse responses uniformly.
 */
export function sendSuccess<T>(
  res: Response,
  data: T,
  statusCode = 200,
  meta?: Record<string, unknown>
) {
  return res.status(statusCode).json({
    success: true,
    data,
    ...(meta ? { meta } : {}),
  });
}

export interface PaginationMeta {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

export function sendPaginated<T>(res: Response, items: T[], meta: PaginationMeta) {
  return res.status(200).json({
    success: true,
    data: items,
    meta,
  });
}
