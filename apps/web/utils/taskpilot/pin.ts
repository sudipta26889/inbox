/**
 * When a TaskPilot project is pinned, only things in that project are used.
 * One rule for the router, the manual convert action and the MCP tool, so they
 * cannot drift apart.
 */
export function filterToPin<T>(
  items: T[],
  pin: string | null,
  projectIdOf: (item: T) => string,
): T[] {
  return pin ? items.filter((item) => projectIdOf(item) === pin) : items;
}
