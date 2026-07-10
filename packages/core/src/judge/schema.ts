import { z } from "zod";

export const ActionEnum = z.enum([
  "none",
  "close_issue",
  "approve_pr",
  "request_changes_pr",
  "close_pr",
  "add_labels",
]);
export type SuggestedAction = z.infer<typeof ActionEnum>;

export const SeverityEnum = z.enum(["blocker", "suggestion", "nit", "question"]);
export type Severity = z.infer<typeof SeverityEnum>;

/** One PR review point, anchored to a changed line (line=null → goes in the review body) */
export const ReviewPointSchema = z.object({
  path: z.string(),
  line: z.number().int().positive().nullable(),
  severity: SeverityEnum.default("suggestion"),
  /** English version of the point (which variant gets posted is a settings choice) */
  comment: z.string(),
  /** 中文 version of the point (optional in the type for legacy rows; required at judge time) */
  commentZh: z.string().optional(),
  /** what in the diff this is based on (quote/snippet) */
  evidence: z.string().optional(),
});
export type ReviewPoint = z.infer<typeof ReviewPointSchema>;

export const DecisionSchema = z
  .object({
    itemType: z.enum(["issue", "pull_request"]),
    needsReply: z.boolean(),
    /** English version of the reply (for a PR, the review's top-level body). Which
     *  variant gets posted is decided at confirm time by the post_language setting. */
    draftReply: z.string().optional(),
    /** 中文 version of the same reply (optional in the type for legacy rows) */
    draftReplyZh: z.string().optional(),
    /** PR only: per-line review points, each anchored to a changed line */
    reviewPoints: z.array(ReviewPointSchema).default([]),
    /** Suggested next action when needsReply=false */
    suggestedAction: ActionEnum.default("none"),
    /** Labels to apply when suggestedAction=add_labels */
    labels: z.array(z.string()).default([]),
    /** Human-readable rationale, 中文 */
    reasoning: z.string(),
    /** The same rationale in English (optional in the type for legacy rows) */
    reasoningEn: z.string().optional(),
    /** Confidence, 0-1 */
    confidence: z.number().min(0).max(1),
  })
  .superRefine((d, ctx) => {
    if (d.needsReply && !d.draftReply?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["draftReply"],
        message: "draftReply is required when needsReply=true",
      });
    }
    if (d.needsReply && !d.draftReplyZh?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["draftReplyZh"],
        message: "draftReplyZh (中文 version) is required when needsReply=true",
      });
    }
    if (!d.reasoningEn?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reasoningEn"],
        message: "reasoningEn (English rationale) is required",
      });
    }
    d.reviewPoints.forEach((pt, i) => {
      if (!pt.commentZh?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["reviewPoints", i, "commentZh"],
          message: "commentZh (中文 version) is required for every review point",
        });
      }
    });
    if (d.suggestedAction === "add_labels" && d.labels.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["labels"],
        message: "labels must not be empty when suggestedAction=add_labels",
      });
    }
  });

export type Decision = z.infer<typeof DecisionSchema>;

/**
 * JSON Schema handed to the Agent SDK's `outputFormat` so the model is forced to
 * emit an object of this shape. It mirrors DecisionSchema's *shape* only — the
 * cross-field rules (needsReply⇒draftReply, add_labels⇒labels) and the 0-1
 * confidence bound are still enforced by DecisionSchema.safeParse afterwards, so
 * keep this in sync with the zod schema above when either changes.
 */
export const DecisionJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["itemType", "needsReply", "reasoning", "reasoningEn", "confidence"],
  properties: {
    itemType: { type: "string", enum: ["issue", "pull_request"] },
    needsReply: { type: "boolean" },
    draftReply: { type: "string" },
    draftReplyZh: { type: "string" },
    reviewPoints: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "line", "comment", "commentZh"],
        properties: {
          path: { type: "string" },
          line: { type: ["integer", "null"] },
          severity: {
            type: "string",
            enum: ["blocker", "suggestion", "nit", "question"],
          },
          comment: { type: "string" },
          commentZh: { type: "string" },
          evidence: { type: "string" },
        },
      },
    },
    suggestedAction: { type: "string", enum: ActionEnum.options },
    labels: { type: "array", items: { type: "string" } },
    reasoning: { type: "string" },
    reasoningEn: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
};
