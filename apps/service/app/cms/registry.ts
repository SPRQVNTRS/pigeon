import { ArticleSchema, FoodSchema } from "#app/cms/schemas";
import type { AnyConfig, ContentConfig, DataConfig } from "#app/cms/types";

export const registry = {
  // Routable content collection
  articles: {
    name: "articles",
    type: "content",
    dir: "content/collections/articles",
    schema: ArticleSchema,
    slugFrom: "filename",
    draftBehavior: "hideInProd",
  } satisfies ContentConfig<typeof ArticleSchema>,

  // Non-routable dataset
  foods: {
    name: "foods",
    type: "data",
    dir: "content/datasets/foods",
    schema: FoodSchema,
  } satisfies DataConfig<typeof FoodSchema>,
} satisfies Record<string, AnyConfig>;

export type Registry = typeof registry;

