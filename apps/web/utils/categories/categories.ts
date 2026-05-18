import prisma from "@/utils/prisma";
import { isDuplicateError } from "@/utils/prisma-helpers";
import { ConflictError } from "@/utils/mcp-server/errors";
import type { CreateCategoryBody } from "./validation";

export type DomainCtx = { userId: string; emailAccountId: string };

export async function listCategories(ctx: DomainCtx) {
  const categories = await prisma.category.findMany({
    where: { emailAccountId: ctx.emailAccountId },
    select: {
      id: true,
      name: true,
      description: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: { name: "asc" },
  });
  return { categories };
}

export async function createCategory(
  ctx: DomainCtx,
  input: CreateCategoryBody,
) {
  try {
    const category = await prisma.category.create({
      data: {
        emailAccountId: ctx.emailAccountId,
        name: input.name,
        description: input.description ?? null,
      },
      select: {
        id: true,
        name: true,
        description: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return { category };
  } catch (error) {
    if (isDuplicateError(error, "name")) {
      throw new ConflictError(
        `Category with name "${input.name}" already exists`,
      );
    }
    throw error;
  }
}
