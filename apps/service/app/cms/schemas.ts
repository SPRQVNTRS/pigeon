import { z } from "zod";

export const ArticleSchema = z.object({
  title: z.string().min(1),
  date: z.string().datetime().or(z.string().regex(/^\d{4}-\d{2}-\d{2}/, "Expected ISO date")),
  excerpt: z.string().optional(),
  tags: z.array(z.string()).optional(),
  draft: z.boolean().optional().default(false),
  image: z.string().optional(),
  author: z.string().optional(),
  slug: z.string().optional(),
});

export type Article = z.infer<typeof ArticleSchema>;

export const FoodSchema = z.object({
  name: z.string().min(1),
  calories: z.number().nonnegative(),
  vegan: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
  image: z.string().optional(),
  description: z.string().optional(),
});

export type Food = z.infer<typeof FoodSchema>;

