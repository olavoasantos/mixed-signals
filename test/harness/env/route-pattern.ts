/**
 * Create a route-matching regex for an origin that matches all paths
 * EXCEPT .js files (which have their own dedicated routes).
 */
export function htmlRoutePattern(origin: string): RegExp {
  return new RegExp(`^${origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/(?!.*\\.js$)`);
}
