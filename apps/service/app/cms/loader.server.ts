import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import MarkdownIt from "markdown-it";
import yaml from "yaml";
import { z } from "zod";

import { registry } from "#app/cms/registry";
import type { ContentEntry, DataItem, AnyConfig, ContentConfig, DataConfig } from "#app/cms/types";

const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

function absoluteDir(dir: string) {
  return path.isAbsolute(dir) ? dir : path.join(process.cwd(), dir);
}

async function listFiles(dir: string) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => path.join(dir, e.name));
}

function baseId(filePath: string) {
  return path.basename(filePath).replace(/\.[^.]+$/, "");
}

async function readText(filePath: string) {
  return fs.readFile(filePath, "utf-8");
}

function parseContentFrontmatter<T extends z.ZodTypeAny>(
  schema: T,
  filePath: string,
  content: string,
): { frontmatter: z.infer<T>; bodyRaw?: string; bodyHtml?: string } {
  if (filePath.endsWith(".md") || filePath.endsWith(".markdown") || filePath.endsWith(".mdx")) {
    const { data, content: body } = matter(content);
    // Normalize common frontmatter quirks (e.g., Date objects)
    if (data && typeof data === "object") {
      const record = data as Record<string, unknown>;
      if (record.date instanceof Date) {
        record.date = record.date.toISOString().slice(0, 10);
      }
    }
    const result = schema.safeParse(data);
    if (!result.success) {
      throw new Error(
        `Frontmatter validation failed for ${filePath}: ${result.error.message}`,
      );
    }
    const bodyHtml = body ? md.render(body) : undefined;
    return { frontmatter: result.data, bodyRaw: body, bodyHtml };
  }
  if (filePath.endsWith(".yml") || filePath.endsWith(".yaml")) {
    const data = yaml.parse(content);
    const result = schema.safeParse(data);
    if (!result.success) {
      throw new Error(
        `Frontmatter validation failed for ${filePath}: ${result.error.message}`,
      );
    }
    return { frontmatter: result.data, bodyRaw: undefined, bodyHtml: undefined };
  }
  throw new Error(`Unsupported content extension for ${filePath}`);
}

function parseData<T extends z.ZodTypeAny>(schema: T, filePath: string, content: string): z.infer<T> {
  let data: unknown;
  if (filePath.endsWith(".yml") || filePath.endsWith(".yaml")) {
    data = yaml.parse(content);
  } else if (filePath.endsWith(".json")) {
    data = JSON.parse(content);
  } else {
    throw new Error(`Unsupported data extension for ${filePath}`);
  }
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new Error(`Data validation failed for ${filePath}: ${result.error.message}`);
  }
  return result.data;
}

function isDraft(frontmatter: unknown): boolean {
  if (frontmatter && typeof frontmatter === "object" && "draft" in (frontmatter as Record<string, unknown>)) {
    const d = (frontmatter as Record<string, unknown>).draft;
    return d === true;
  }
  return false;
}

function shouldExcludeDraft(frontmatter: unknown, behavior: ContentConfig<z.ZodTypeAny>["draftBehavior"]) {
  const draft = isDraft(frontmatter);
  if (behavior === "alwaysInclude") return false;
  const isProd = process.env.NODE_ENV === "production";
  return isProd && draft;
}

function readSlugFrom(frontmatter: unknown): string | undefined {
  if (frontmatter && typeof frontmatter === "object" && "slug" in (frontmatter as Record<string, unknown>)) {
    const s = (frontmatter as Record<string, unknown>).slug;
    if (typeof s === "string" && s.trim().length > 0) return s;
  }
  return undefined;
}

function readDate(frontmatter: unknown): string | undefined {
  if (frontmatter && typeof frontmatter === "object" && "date" in (frontmatter as Record<string, unknown>)) {
    const d = (frontmatter as Record<string, unknown>).date;
    if (typeof d === "string") return d;
  }
  return undefined;
}

function isContentConfig<TSchema extends z.ZodTypeAny>(cfg: AnyConfig): cfg is ContentConfig<TSchema> {
  return cfg.type === "content";
}

function isDataConfig<TSchema extends z.ZodTypeAny>(cfg: AnyConfig): cfg is DataConfig<TSchema> {
  return cfg.type === "data";
}

export async function getCollection<TSchema extends z.ZodTypeAny>(
  name: keyof typeof registry,
  opts?: { filterDrafts?: boolean },
): Promise<ContentEntry<z.infer<TSchema>>[]> {
  const cfg = registry[name] as AnyConfig;
  if (!cfg || !isContentConfig<TSchema>(cfg)) throw new Error(`Unknown content collection: ${String(name)}`);
  const abs = absoluteDir(cfg.dir);
  const files = await listFiles(abs);

  const allowed = [".md", ".markdown", ".mdx", ".yml", ".yaml"];
  const entries: ContentEntry<z.infer<TSchema>>[] = [];
  const seenSlugs = new Set<string>();

  for (const f of files) {
    if (!allowed.some((ext) => f.endsWith(ext))) continue;
    const raw = await readText(f);
    const parsed = parseContentFrontmatter(cfg.schema, f, raw);

    const fmSlug = cfg.slugFrom === "frontmatter" ? readSlugFrom(parsed.frontmatter) : undefined;
    const slug = fmSlug ?? baseId(f);

    if (seenSlugs.has(slug)) {
      throw new Error(`Duplicate slug "${slug}" in ${cfg.name}`);
    }
    seenSlugs.add(slug);

    const excludeDraft = opts?.filterDrafts ?? cfg.draftBehavior === "hideInProd";
    if (excludeDraft && shouldExcludeDraft(parsed.frontmatter, cfg.draftBehavior)) {
      continue;
    }

    entries.push({
      slug,
      frontmatter: parsed.frontmatter,
      bodyHtml: parsed.bodyHtml,
      bodyRaw: parsed.bodyRaw,
      file: f,
    });
  }

  return entries.sort((a, b) => {
    // Default sort: date desc if present
    const ad = readDate(a.frontmatter);
    const bd = readDate(b.frontmatter);
    if (ad && bd) return bd.localeCompare(ad);
    return a.slug.localeCompare(b.slug);
  });
}

export async function getEntry<TSchema extends z.ZodTypeAny>(
  name: keyof typeof registry,
  slug: string,
): Promise<ContentEntry<z.infer<TSchema>> | null> {
  const entries = await getCollection<TSchema>(name);
  return entries.find((e) => e.slug === slug) ?? null;
}

export async function getDataset<TSchema extends z.ZodTypeAny>(
  name: keyof typeof registry,
): Promise<DataItem<z.infer<TSchema>>[]> {
  const cfg = registry[name] as AnyConfig;
  if (!cfg || !isDataConfig<TSchema>(cfg)) throw new Error(`Unknown dataset: ${String(name)}`);
  const abs = absoluteDir(cfg.dir);
  const files = await listFiles(abs);
  const allowed = [".yml", ".yaml", ".json"];
  const items: DataItem<z.infer<TSchema>>[] = [];
  const seen = new Set<string>();

  for (const f of files) {
    if (!allowed.some((ext) => f.endsWith(ext))) continue;
    const raw = await readText(f);
    const id = baseId(f);
    if (seen.has(id)) throw new Error(`Duplicate id "${id}" in ${cfg.name}`);
    seen.add(id);
    const data = parseData(cfg.schema, f, raw);
    items.push({ id, data, file: f });
  }

  return items.sort((a, b) => a.id.localeCompare(b.id));
}

export async function getDatasetItem<TSchema extends z.ZodTypeAny>(
  name: keyof typeof registry,
  id: string,
): Promise<DataItem<z.infer<TSchema>> | null> {
  const items = await getDataset<TSchema>(name);
  return items.find((e) => e.id === id) ?? null;
}
