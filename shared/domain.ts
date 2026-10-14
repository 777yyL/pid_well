import { z } from "zod";
export const verdict = z.enum(["exact", "partial", "no_match"]);
export const criteriaSchema = z.object({
  direction: z.string().min(1),
  scope: z.string().min(1),
  spec: z.string().min(1),
  context: z.string().min(1),
  delivery: z.string().min(1),
});
export const requirementSchema = z.object({
  id: z.string().regex(/^T-\d+$/),
  documentId: z.string().uuid(),
  module: z.string().min(1),
  type: z.enum(["功能", "性能", "接口", "兼容性", "安全", "部署"]),
  raw: z.string().min(1),
  lineStart: z.number().int().positive(),
  lineEnd: z.number().int().positive(),
});
export const evidenceSchema = z.object({
  snapshotId: z.string().uuid(),
  lineStart: z.number().int().positive(),
  lineEnd: z.number().int().positive(),
  quote: z.string().min(1),
});
export const assessmentSchema = z.object({
  productScopeRevision: z.number().int().positive().optional(),
  requirementId: z.string(),
  sales: z.array(z.string().min(1)),
  product: z.string().min(1),
  version: z.string(),
  level: verdict,
  ok: z.array(z.string()),
  hard: z.array(z.string()),
  no: z.array(z.string()),
  note: z.string().min(1),
  criteria: criteriaSchema,
  evidence: z.array(evidenceSchema),
  dependencies: z.array(z.string()),
  mustSelect: z.array(z.string()),
});
export type RequirementInput = z.infer<typeof requirementSchema>;
export const productChoiceSchema = z.object({
  name: z.string().trim().min(1).max(200),
  version: z.string().trim().max(100).default(""),
  path: z
    .string()
    .trim()
    .max(500)
    .default("")
    .refine(
      (p) =>
        !p || (p.startsWith("wiki/") && !p.includes("..") && !p.includes("\\")),
      "产品路径须位于 wiki/ 下",
    ),
});
export const productCandidateSchema = productChoiceSchema.extend({
  productName: z.string().trim().max(200).optional(),
  productId: z.string().trim().max(200).optional(),
  productLine: z.string().trim().max(200).optional(),
  department: z.string().trim().max(200).optional(),
  owner: z.string().trim().max(200).optional(),
  reason: z.string().min(10).max(4000),
  coverage: z.string().min(1).max(2000),
  gaps: z.string().max(2000).default(""),
  evidence: z.array(evidenceSchema).min(1).max(5),
});
export const productCombinationSchema = z.object({
  name: z.string().trim().min(1).max(80),
  summary: z.string().trim().min(10).max(300),
  products: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(200),
        version: z.string().trim().max(100).default(""),
        role: z.string().trim().min(1).max(200),
      }),
    )
    .min(1)
    .max(20),
});
export interface ProductScope {
  combinations?: z.infer<typeof productCombinationSchema>[];
  revision: number;
  status: "pending" | "confirmed" | "legacy";
  recommendations: z.infer<typeof productCandidateSchema>[];
  selected: z.infer<typeof productChoiceSchema>[];
  strategy: string;
  confirmed_by: string | null;
}
export type AssessmentInput = z.infer<typeof assessmentSchema>;
export interface User {
  id: string;
  username: string;
  display_name: string;
  role: "admin" | "member";
}
export interface Project {
  archived_at?: string | null;
  owner_name?: string;
  active_run?: boolean;
  id: string;
  name: string;
  description: string;
  wiki_project_id: string;
  owner_id: string;
  created_at: string;
}
export interface Conversation {
  id: string;
  project_id: string;
  title: string;
  plan: PlanStep[];
  created_at: string;
}
export interface PlanStep {
  id: string;
  title: string;
  status: "pending" | "running" | "done" | "blocked";
}
export interface ChatMessage {
  id: string;
  role: string;
  content: string;
  created_at: string;
  run_id: string | null;
}
export interface Run {
  id: string;
  conversation_id: string;
  project_id: string;
  status:
    "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
  input: string;
  error: string | null;
  created_at: string;
  turn_count: number;
}
export interface Document {
  id: string;
  name: string;
  status: string;
  error: string | null;
  lines: string[];
  line_count?: number;
  created_at: string;
}
export interface Requirement extends RequirementInput {
  confirmed: boolean;
}
export interface Assessment extends AssessmentInput {
  id: string;
  source: "agent" | "human";
  reviewed: boolean;
  revision: number;
  requirement_raw?: string;
  module?: string;
}
export interface Snapshot {
  title?: string | null;
  id: string;
  path: string;
  content: string;
  hash: string;
  created_at: string;
}
export interface RunEvent {
  id: number;
  type: string;
  payload: Record<string, unknown>;
  created_at: string;
}
export interface ProductAlternative {
  id: number;
  data: {
    requirementId: string;
    product: ProductScope["selected"][number];
    sales: string;
    reason: string;
    evidence: z.infer<typeof evidenceSchema>;
    scopeRevision: number;
  };
}
export interface Workspace {
  alternatives: ProductAlternative[];
  searchTrace: {
    id: number;
    action: string;
    created_at: string;
    data: {
      requirementId: string;
      query: string;
      scopeRevision: number;
      matchCount?: number;
      reason?: string;
      explanation?: string;
    };
  }[];
  productScope: ProductScope;
  project: Project;
  conversations: Conversation[];
  documents: Document[];
  requirements: Requirement[];
  assessments: Assessment[];
  snapshots: Snapshot[];
  runs: Run[];
}
export interface SettingsView {
  modelBaseUrl: string;
  model: string;
  modelApiKeySet: boolean;
  wikiBaseUrl: string;
  wikiTokenSet: boolean;
  contextWindow: number;
  maxOutputTokens: number;
  requireRequirementConfirmation: boolean;
}
