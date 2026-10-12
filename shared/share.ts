import type { Assessment } from "./domain.js";
export interface SharedAssessment extends Pick<
  Assessment,
  | "requirementId"
  | "module"
  | "requirement_raw"
  | "product"
  | "version"
  | "sales"
  | "level"
  | "ok"
  | "hard"
  | "no"
  | "note"
  | "criteria"
  | "dependencies"
  | "mustSelect"
  | "source"
  | "revision"
> {
  evidence: {
    quote: string;
    path: string;
    lineStart: number;
    lineEnd: number;
  }[];
}
export interface SharedResult {
  projectName: string;
  generatedAt: string;
  strategy: string;
  rows: SharedAssessment[];
  sales: {
    title: string;
    product: string;
    version: string;
    moduleId: string;
    category: string;
    specification: string;
    unit: string;
    price?: number;
    quantity?: number;
    total?: number;
    description: string;
    quotation: string;
    dependencyNote: string;
    mandatory: string;
    requirements: string[];
  }[];
  files: { id: string; name: string; kind: string; format: string }[];
  expiresAt: string;
}
export interface ShareLink {
  id: string;
  url: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
}
