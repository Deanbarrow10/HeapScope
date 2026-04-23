export interface LeakNode {
  id: string;
  size: number;
  zone: string;
  reachable: boolean;
  in_cycle: boolean;
}

export interface LeakEdge {
  from: string;
  to: string;
}

export interface LeakSummary {
  total_allocations: number;
  reachable: number;
  leaked: number;
  leaked_bytes: number;
  cycles_found: number;
}

export interface LeakReport {
  pid?: number;
  summary: LeakSummary;
  nodes: LeakNode[];
  edges: LeakEdge[];
  cycles: string[][];
  _sample?: boolean;
  _note?: string;
}

export type FilterKey = 'all' | 'reachable' | 'leaked' | 'cycle';

export interface MemoryBug {
  n: number;
  company: string;
  area: string;
  hq: [number, number]; // [lon, lat]
  tag: string;
  year: string;
  issue: string;
  description: string;
  outcome: string;
}
