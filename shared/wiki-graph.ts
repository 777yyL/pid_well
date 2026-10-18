export type WikiGraphNode = {
  id: string;
  label: string;
  path?: string;
  nodeType: string;
};
export type WikiGraphEdge = { source: string; target: string; label: string };
export type WikiGraphData = {
  nodes: WikiGraphNode[];
  edges: WikiGraphEdge[];
  truncated: boolean;
};
