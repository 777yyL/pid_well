export type CapabilityRelation = "product" | "dependency" | "related";
export type CapabilityGraphNode = {
  id: string;
  label: string;
  path?: string;
  relation: CapabilityRelation;
  source: "page" | "graph";
  quote: string;
  line?: number;
  unresolved?: string;
};
export type CapabilityGraph = {
  root: { label: string; path: string; pageId: string };
  nodes: CapabilityGraphNode[];
  warnings: string[];
};
