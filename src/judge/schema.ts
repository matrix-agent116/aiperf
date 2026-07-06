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
  /** English — this is what gets posted inline on GitHub */
  comment: z.string(),
  /** Chinese rendering, shown to the human for understanding; NOT posted */
  commentZh: z.string().optional(),
  /** what in the diff this is based on (quote/snippet) */
  evidence: z.string().optional(),
});
export type ReviewPoint = z.infer<typeof ReviewPointSchema>;

export const DecisionSchema = z
  .object({
    itemType: z.enum(["issue", "pull_request"]),
    needsReply: z.boolean(),
    /** English — the reply actually POSTED to GitHub when needsReply=true.
     *  For a PR this is the review's top-level body; per-line points go in reviewPoints. */
    draftReply: z.string().optional(),
    /** Chinese rendering of draftReply, shown to the human for understanding; NOT posted */
    draftReplyZh: z.string().optional(),
    /** PR only: per-line review points, each anchored to a changed line */
    reviewPoints: z.array(ReviewPointSchema).default([]),
    /** Suggested next action when needsReply=false */
    suggestedAction: ActionEnum.default("none"),
    /** Labels to apply when suggestedAction=add_labels */
    labels: z.array(z.string()).default([]),
    /** Human-readable rationale for the decision */
    reasoning: z.string(),
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
    if (d.suggestedAction === "add_labels" && d.labels.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["labels"],
        message: "labels must not be empty when suggestedAction=add_labels",
      });
    }
  });

export type Decision = z.infer<typeof DecisionSchema>;
