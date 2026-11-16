/** Prisma filter: email accounts the user owns or has been shared. */
export function accessibleEmailAccountWhere(userId: string) {
  return { OR: [{ userId }, { shares: { some: { userId } } }] };
}
