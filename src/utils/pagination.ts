export interface IPagination {
  page: number;
  limit: number;
}

export const getPagination = (query: any): IPagination => {
  const page = parseInt(query.page as string) || 1;
  const limit = Math.min(parseInt(query.limit as string) || 20, 100);
  return { page, limit };
};
