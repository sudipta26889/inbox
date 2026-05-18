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

export async function previewDeleteCategory(
  ctx: DomainCtx,
  input: { categoryId: string },
) {
  const category = await prisma.category.findUnique({
    where: { id: input.categoryId },
    select: {
      id: true,
      name: true,
      description: true,
      emailAccountId: true,
    },
  });
  if (!category || category.emailAccountId !== ctx.emailAccountId) {
    throw new NotFoundError(`Category ${input.categoryId} not found`);
  }

  const affectedSenders = await prisma.newsletter.count({
    where: {
      emailAccountId: ctx.emailAccountId,
      categoryId: input.categoryId,
    },
  });

  return {
    category: {
      id: category.id,
      name: category.name,
      description: category.description,
    },
    affectedSenders,
  };
}

export async function deleteCategory(
  ctx: DomainCtx,
  input: { categoryId: string },
) {
  const category = await prisma.category.findUnique({
    where: { id: input.categoryId },
    select: { id: true, emailAccountId: true },
  });
  if (!category || category.emailAccountId !== ctx.emailAccountId) {
    throw new NotFoundError(`Category ${input.categoryId} not found`);
  }

  // Detach senders first (categoryId is nullable on Newsletter). No transaction:
  // project rule forbids prisma.$transaction(async (tx) => ...). Two sequential
  // statements; if the second fails, senders simply remain detached (idempotent).
  await prisma.newsletter.updateMany({
    where: {
      emailAccountId: ctx.emailAccountId,
      categoryId: input.categoryId,
    },
    data: { categoryId: null },
  });
  await prisma.category.delete({ where: { id: input.categoryId } });

  return { deletedId: input.categoryId };
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
