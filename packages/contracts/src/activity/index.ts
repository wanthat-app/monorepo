// The ADMIN activity feed only. The former MEMBER merged feed (`./member`, GET /activity) is
// deleted — the SPA composes it client-side from GET /wallet/entries + GET /recommendations
// (both cursor-paginated at their own endpoints), so no shared wire type remains.
export * from "./admin";
