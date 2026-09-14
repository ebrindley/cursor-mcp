import { z } from "zod";

/** Generic Cursor selections; callers own model and parameter preferences. */
export const ModelSelectionSchema = z.strictObject({
  id: z.string().trim().min(1),
  params: z.array(z.strictObject({
    id: z.string().trim().min(1),
    value: z.string(),
  })).refine((params) => new Set(params.map((p) => p.id)).size === params.length,
    "model parameter ids must be unique").optional(),
});

export const ModelInputSchema = z.union([z.string().trim().min(1), ModelSelectionSchema]);
export type ModelInput = z.infer<typeof ModelInputSchema>;

export function modelSelection(model: ModelInput): z.infer<typeof ModelSelectionSchema> {
  return typeof model === "string" ? { id: model } : model;
}

export function sameModel(a: ModelInput, b: ModelInput): boolean {
  const left = modelSelection(a);
  const right = modelSelection(b);
  const params = (model: typeof left) => JSON.stringify(
    [...(model.params ?? [])].sort((a, b) => a.id.localeCompare(b.id)),
  );
  return left.id === right.id && params(left) === params(right);
}
