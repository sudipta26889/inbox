import prisma from "@/utils/prisma";
import { isDuplicateError } from "@/utils/prisma-helpers";
import { ConflictError, NotFoundError } from "@/utils/mcp-server/errors";
import type { CreateCategoryBody, UpdateCategoryBody } from "./validation";

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

export async function updateCategory(
  ctx: DomainCtx,
  input: UpdateCategoryBody,
) {
  const existing = await prisma.category.findUnique({
    where: { id: input.categoryId },
    select: { id: true, emailAccountId: true },
  });
  if (!existing || existing.emailAccountId !== ctx.emailAccountId) {
    throw new NotFoundError(`Category ${input.categoryId} not found`);
  }

  try {
    const category = await prisma.category.update({
      where: { id: input.categoryId },
      data: {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.description !== undefined && {
          description: input.description,
        }),
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
